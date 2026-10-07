// Checkout locks (S13, B5).
import fs from 'node:fs';
import path from 'node:path';
import { gitDir } from './git.js';
import { EngineError } from './util.js';

const STALE_MS = 10 * 60 * 1000;

export const lockPath = (repoDir) => path.join(gitDir(repoDir), 'junior-dev.lock');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readLock(repoDir) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(repoDir), 'utf8'));
  } catch {
    return null;
  }
}

export function isStale(lock, { now = Date.now(), sessionLive = () => false } = {}) {
  if (!lock) return true;
  if (!pidAlive(lock.pid)) return true;
  return now - Date.parse(lock.heartbeatAt) > STALE_MS && !sessionLive(lock.sessionId);
}

/** Take the lock (O_EXCL). A stale lock is replaced; a live lock of another run refuses. */
export function acquire(repoDir, { feature, sessionId, pid = process.pid, now = new Date(), sessionLive } = {}) {
  const file = lockPath(repoDir);
  const body = JSON.stringify({ feature, sessionId, pid, startedAt: now.toISOString(), heartbeatAt: now.toISOString() });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return { ok: true, replacedStale: i > 0 };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readLock(repoDir);
      if (cur && cur.feature === feature && cur.sessionId === sessionId) {
        fs.writeFileSync(file, body);
        return { ok: true, replacedStale: false };
      }
      if (!isStale(cur, { now: now.getTime(), sessionLive })) {
        return { ok: false, reason: `${repoDir} is locked by run "${cur.feature}" (session ${cur.sessionId}, since ${cur.startedAt})` };
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new EngineError('lock', `could not take lock on ${repoDir}`);
}

export function heartbeat(repoDir, { feature, sessionId, now = new Date() }) {
  const cur = readLock(repoDir);
  if (!cur || cur.feature !== feature || cur.sessionId !== sessionId) return false;
  cur.heartbeatAt = now.toISOString();
  fs.writeFileSync(lockPath(repoDir), JSON.stringify(cur));
  return true;
}

export function holds(repoDir, { feature, sessionId }) {
  const cur = readLock(repoDir);
  return !!cur && cur.feature === feature && cur.sessionId === sessionId;
}

export function release(repoDir, { feature, sessionId }) {
  if (holds(repoDir, { feature, sessionId })) fs.rmSync(lockPath(repoDir), { force: true });
}
