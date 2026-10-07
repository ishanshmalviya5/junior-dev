// U2 (durability) and the tamper half of U5.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/engine/store.js';
import { tmpdir } from './helpers.js';

const SCRIPT = [
  ['created', { name: 'f', sessionFolder: '/x', prdSha: 'abc' }],
  ['fact', { id: 'F1', text: 'repo uses ESM', source: 'package.json' }],
  ['question', { question: { id: 'Q1', text: 'push?', options: [] } }],
  ['answer', { id: 'Q1', answer: 'no' }],
  ['setting', { key: 'dial', value: 'careful' }],
  ['phase', { from: 'intake', to: 'research' }],
  ['note', { kind: 'x', text: 'y' }],
  ['usage', { tokens: 10, costUsd: 0.1 }],
  ['phase', { from: 'research', to: 'interview' }],
  ['answer', { id: 'Q1', answer: 'yes' }],
];

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 8, 0, 0, tick++)).toISOString();

function expectedAfter(n, snapshotEvery) {
  tick = 0;
  const dir = path.join(tmpdir(), 'state');
  const s = Store.open(dir, { clock, snapshotEvery });
  for (const [t, d] of SCRIPT.slice(0, n)) s.commit(t, d);
  return canon(Store.open(dir, { clock }).state);
}

for (const snapshotEvery of [3, 20]) {
  for (const point of ['before-append', 'partial-append', 'after-append', 'before-rename']) {
    test(`U2: crash at ${point} on every write rebuilds the right state (snapshotEvery=${snapshotEvery})`, () => {
      for (let k = 0; k < SCRIPT.length; k++) {
        tick = 0;
        const dir = path.join(tmpdir(), 'state');
        let writes = 0;
        const faults = (p) => {
          if (p !== point) return false;
          return writes++ === k;
        };
        const s = Store.open(dir, { clock, snapshotEvery, faults });
        let crashedAt = null;
        for (let i = 0; i < SCRIPT.length; i++) {
          try {
            s.commit(...SCRIPT[i]);
          } catch (e) {
            assert.equal(e.code, 'crash');
            crashedAt = i;
            break;
          }
        }
        const reopened = Store.open(dir, { clock });
        if (crashedAt === null) {
          // before-rename only fires on snapshots, so some k never crash
          assert.equal(canon(reopened.state), expectedAfter(SCRIPT.length, snapshotEvery));
          continue;
        }
        // Durable = appended in full. before-append / partial-append lose the event in flight; after-append and before-rename keep it.
        const kept = point === 'before-append' || point === 'partial-append' ? crashedAt : crashedAt + 1;
        assert.equal(canon(reopened.state), expectedAfter(kept, snapshotEvery), `crash ${point} #${k} at event ${crashedAt}`);
        if (point === 'partial-append') assert.equal(reopened.recovered[0]?.kind, 'torn-line');
        // the store keeps working after recovery
        reopened.commit('note', { kind: 'after', text: 'recovered' });
        assert.equal(Store.open(dir, { clock }).state.notes.at(-1).text, 'recovered');
      }
    });
  }
}

test('U2: each answer is on disk before the next question is recorded', () => {
  const dir = path.join(tmpdir(), 'state');
  const s = Store.open(dir);
  s.commit('created', { name: 'f', sessionFolder: '/x', prdSha: 'a' });
  s.commit('question', { question: { id: 'Q1', text: 'a?' } });
  s.commit('answer', { id: 'Q1', answer: 'yes' });
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines.at(-1)).type, 'answer');
  assert.equal(Store.open(dir).state.questions[0].answer, 'yes');
});

test('U5/S1.6: editing the event log by hand is detected and load refuses', () => {
  const dir = path.join(tmpdir(), 'state');
  const s = Store.open(dir, { snapshotEvery: 2 });
  s.commit('created', { name: 'f', sessionFolder: '/x', prdSha: 'a' });
  s.commit('fact', { id: 'F1', text: 'x', source: 's' });
  s.commit('fact', { id: 'F2', text: 'y', source: 's' });
  const p = path.join(dir, 'events.jsonl');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"text":"x"', '"text":"z"'));
  assert.throws(() => Store.open(dir), (e) => e.code === 'tamper');
});

test('U5: a sequence gap in the log is detected', () => {
  const dir = path.join(tmpdir(), 'state');
  const s = Store.open(dir, { snapshotEvery: 100 });
  s.commit('created', { name: 'f', sessionFolder: '/x', prdSha: 'a' });
  s.commit('fact', { id: 'F1', text: 'x', source: 's' });
  s.commit('fact', { id: 'F2', text: 'y', source: 's' });
  const p = path.join(dir, 'events.jsonl');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.splice(1, 1);
  fs.writeFileSync(p, lines.join('\n'));
  assert.throws(() => Store.open(dir), (e) => e.code === 'tamper');
});

test('J4/S1.6: an appended event with the right seq (e.g. forcing a node done) breaks the keyed chain', () => {
  const dir = path.join(tmpdir(), 'state');
  const s = Store.open(dir, { snapshotEvery: 2 });
  s.commit('created', { name: 'f', sessionFolder: '/x', prdSha: 'a' });
  s.commit('fact', { id: 'F1', text: 'x', source: 's' });
  s.commit('fact', { id: 'F2', text: 'y', source: 's' });
  const p = path.join(dir, 'events.jsonl');
  fs.appendFileSync(p, JSON.stringify({ seq: 4, ts: 't', type: 'note', data: { kind: 'x', text: 'forged' } }) + '\n');
  assert.throws(() => Store.open(dir), (e) => e.code === 'tamper' && /chain mismatch/.test(e.message));
});
