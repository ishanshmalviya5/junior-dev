import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialState, reduce } from './reducer.js';
import { EngineError, isoNow } from './util.js';

const EVENTS = 'events.jsonl';
const SNAPSHOT = 'snapshot.json';

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems refuse directory fsync; the rename is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Append-only event log plus atomic snapshot (S1). The only writer of feature state (S1.4).
 * `faults` lets tests simulate a crash at each write point (U2).
 */
/** Keyed hash chain over every event (S1.6, J4). The host sets the key from ~/.junior-dev; tests may leave it unset. */
let SECRET = process.env.JD_STORE_SECRET ?? 'junior-dev';
export function setStoreSecret(secret) {
  SECRET = secret;
}
const link = (prev, ev) => crypto.createHmac('sha256', SECRET).update(prev + JSON.stringify({ seq: ev.seq, ts: ev.ts, type: ev.type, data: ev.data })).digest('hex');

export class Store {
  constructor(stateDir, { clock = isoNow, snapshotEvery = 20, faults = null } = {}) {
    this.dir = stateDir;
    this.clock = clock;
    this.snapshotEvery = snapshotEvery;
    this.faults = faults;
    this.state = initialState();
    this.seq = 0;
    this.offset = 0;
    this.hash = crypto.createHash('sha256');
    this.listeners = new Set();
    this.recovered = [];
    this.chain = '';
  }

  static exists(stateDir) {
    return fs.existsSync(path.join(stateDir, EVENTS)) || fs.existsSync(path.join(stateDir, SNAPSHOT));
  }

  static open(stateDir, opts) {
    const s = new Store(stateDir, opts);
    fs.mkdirSync(stateDir, { recursive: true });
    s.#load();
    return s;
  }

  #fault(point, extra) {
    if (this.faults && this.faults(point, extra)) throw new EngineError('crash', `simulated crash at ${point}`);
  }

  #load() {
    const evPath = path.join(this.dir, EVENTS);
    const snapPath = path.join(this.dir, SNAPSHOT);
    let buf = fs.existsSync(evPath) ? fs.readFileSync(evPath) : Buffer.alloc(0);
    let start = 0;
    if (fs.existsSync(snapPath)) {
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      if (snap.offset > buf.length) throw new EngineError('tamper', 'event log is shorter than the snapshot says');
      const prefixHash = crypto.createHash('sha256').update(buf.subarray(0, snap.offset)).digest('hex');
      if (prefixHash !== snap.hash) throw new EngineError('tamper', 'event log was edited outside junior-dev (hash mismatch)');
      this.state = snap.state;
      this.seq = snap.seq;
      start = snap.offset;
    }
    // Torn tail: a final line without newline is an interrupted append (S1.3).
    const lastNl = buf.lastIndexOf(0x0a);
    const goodEnd = lastNl + 1;
    if (goodEnd < buf.length) {
      this.recovered.push({ kind: 'torn-line', bytes: buf.length - goodEnd });
      fs.truncateSync(evPath, goodEnd);
      buf = buf.subarray(0, goodEnd);
    }
    // verify the keyed chain over the whole log (an appended or edited event breaks it)
    let prev = '';
    let n = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      const ev = JSON.parse(line);
      n++;
      if (ev.seq !== n) throw new EngineError('tamper', `event seq gap at ${ev.seq}`);
      if (ev.h !== link(prev, ev)) throw new EngineError('tamper', `event ${ev.seq} was not written by junior-dev (chain mismatch)`);
      prev = ev.h;
    }
    this.chain = prev;
    this.hash.update(buf.subarray(0, start));
    const tail = buf.subarray(start).toString('utf8');
    let pos = start;
    for (const line of tail.split('\n')) {
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.seq !== this.seq + 1) throw new EngineError('tamper', `event seq gap at ${ev.seq}`);
      reduce(this.state, ev);
      this.seq = ev.seq;
      const len = Buffer.byteLength(line) + 1;
      this.hash.update(buf.subarray(pos, pos + len));
      pos += len;
    }
    this.offset = buf.length;
  }

  onCommit(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  commit(type, data = {}) {
    const ev = { seq: this.seq + 1, ts: this.clock(), type, data };
    ev.h = link(this.chain, ev);
    const line = Buffer.from(JSON.stringify(ev) + '\n');
    this.#fault('before-append', ev);
    const evPath = path.join(this.dir, EVENTS);
    const fd = fs.openSync(evPath, 'a');
    try {
      if (this.faults && this.faults('partial-append', ev)) {
        fs.writeSync(fd, line.subarray(0, Math.max(1, Math.floor(line.length / 2))));
        fs.fsyncSync(fd);
        throw new EngineError('crash', 'simulated crash at partial-append');
      }
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.hash.update(line);
    this.chain = ev.h;
    this.offset += line.length;
    this.#fault('after-append', ev);
    reduce(this.state, ev);
    this.seq = ev.seq;
    if (type === 'phase' || type === 'side' || this.seq % this.snapshotEvery === 0) this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(ev, this.state);
      } catch {
        // listeners never break a commit
      }
    }
    return ev;
  }

  snapshot() {
    const snapPath = path.join(this.dir, SNAPSHOT);
    const tmp = snapPath + '.tmp';
    const body = JSON.stringify({ seq: this.seq, offset: this.offset, hash: this.hash.copy().digest('hex'), state: this.state });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.#fault('before-rename');
    fs.renameSync(tmp, snapPath);
    fsyncDir(this.dir);
  }
}
