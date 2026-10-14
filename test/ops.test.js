// U3 (locks), U10 (fix-loop cap), U11 (budget), U12 (queue batching), U15 (report), U18 (progress), S7 (check runner), S8.2 (rollback guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as Locks from '../lib/engine/locks.js';
import * as G from '../lib/engine/git.js';
import { exceeded, overspent } from '../lib/engine/budget.js';
import { runCheck } from '../lib/engine/checks.js';
import { Run } from '../lib/engine/run.js';
import { renderProgress } from '../lib/engine/progress.js';
import { situation } from '../lib/engine/scheduler.js';
import { tmpdir, gitRepo, PRD } from './helpers.js';

test('U3: a second run on a locked checkout is refused; a dead run\'s lock is replaced; release only by owner', () => {
  const repo = tmpdir();
  gitRepo(repo);
  assert.ok(Locks.acquire(repo, { feature: 'a', sessionId: 'S1' }).ok);
  const r = Locks.acquire(repo, { feature: 'b', sessionId: 'S2' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /locked by run "a"/);
  Locks.release(repo, { feature: 'b' });
  assert.ok(Locks.holds(repo, { feature: 'a' }), 'non-owner cannot release');
  assert.ok(Locks.acquire(repo, { feature: 'a', sessionId: 'S9' }).ok, 'the same run resumed from another chat keeps its lock');
  // dead pid → stale
  fs.writeFileSync(Locks.lockPath(repo), JSON.stringify({ feature: 'a', sessionId: 'S1', pid: 999999, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  const t = Locks.acquire(repo, { feature: 'b', sessionId: 'S2' });
  assert.ok(t.ok && t.replacedStale);
  // live pid but old heartbeat and dead session → stale
  fs.writeFileSync(Locks.lockPath(repo), JSON.stringify({ feature: 'a', sessionId: 'S1', pid: process.pid, startedAt: '2026-01-01T00:00:00Z', heartbeatAt: '2026-01-01T00:00:00Z' }));
  assert.ok(Locks.acquire(repo, { feature: 'c', sessionId: 'S3', sessionLive: () => false }).ok);
  assert.ok(Locks.heartbeat(repo, { feature: 'c', sessionId: 'S3' }));
  Locks.release(repo, { feature: 'c' });
  assert.equal(fs.existsSync(Locks.lockPath(repo)), false);
});

test('U11: time and token limits each trip; per-node overspend is flagged', () => {
  const st = {
    settings: { budget: { tokens: 100, timeMin: 1 } },
    usage: { tokens: 100, costUsd: 0.5, activeMs: 0, byNode: { 'N.1': { tokens: 400 } } },
    history: [{ ok: true, to: 'build', ts: new Date(Date.now() - 120000).toISOString() }],
    tree: { nodes: { 'N.1': { id: 'N.1', budgetShare: 200 }, 'N.2': { id: 'N.2', budgetShare: 200 } } },
  };
  const ex = exceeded(st);
  assert.equal(ex.length, 2);
  assert.match(ex.join(), /tokens 100 ≥ 100/);
  assert.match(ex.join(), /time 2 min ≥ 1 min/);
  assert.deepEqual(overspent(st), ['N.1']);
});

test('S7: the check runner captures exit code and output and enforces timeouts', async () => {
  const ok = await runCheck({ command: 'echo hi && exit 0', cwd: tmpdir() });
  assert.deepEqual([ok.ok, ok.output.trim()], [true, 'hi']);
  const bad = await runCheck({ command: 'echo nope >&2; exit 3', cwd: tmpdir() });
  assert.deepEqual([bad.ok, bad.code, bad.output.trim()], [false, 3, 'nope']);
  const slow = await runCheck({ command: 'sleep 5', cwd: tmpdir() }, { timeoutMs: 200 });
  assert.equal(slow.ok, false);
  assert.match(slow.output, /timed out/);
  assert.equal((await runCheck({ command: null })).ok, false);
});

test('S8.2: rollback and commit refuse to touch a non junior-dev branch; rollback discards a failed attempt', () => {
  const repo = tmpdir();
  const g = gitRepo(repo, { 'a.txt': 'a\n' });
  assert.throws(() => G.rollback(repo, 'HEAD'), /not a junior-dev/);
  assert.throws(() => G.commitAll(repo, 'x'), /not a junior-dev/);
  g('checkout', '-q', '-b', 'junior-dev/t');
  const base = G.head(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'broken\n');
  fs.writeFileSync(path.join(repo, 'junk.txt'), 'x');
  G.rollback(repo, base);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.existsSync(path.join(repo, 'junk.txt')), false);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
  const sha = G.commitAll(repo, 'jd(N.1): add b');
  assert.ok(sha && sha !== base);
  assert.equal(G.commitAll(repo, 'nothing'), null);
});

function runWithTree(fixCap = 3) {
  const session = tmpdir();
  const run = Run.create({ sessionFolder: session, prdText: PRD });
  run.store.commit('doc', { key: 'requirements', sha: 'x', ids: ['A1', 'B1'] });
  run.set('fixCap', fixCap);
  run.tree('init', { requirements: ['A1', 'B1'], title: 'greet' });
  run.tree('split', 'N', [
    { title: 'core', doneWhen: ['x'], covers: ['N#A1'], traces: { requirements: ['A1'] }, kind: 'behaviour', checks: [{ command: 'true' }] },
    { title: 'export', doneWhen: ['y'], covers: ['N#B1'], traces: { requirements: ['B1'] }, kind: 'behaviour', checks: [{ command: 'true' }] },
  ]);
  return run;
}

test('U10: the fix-loop cap is a setting (default 3) and honoured', () => {
  for (const cap of [1, 2, 3]) {
    const run = runWithTree(cap);
    for (let i = 0; i < cap; i++) {
      run.tree('claim', 'N.1', 'W');
      run.tree('submit', 'N.1', {});
      run.tree('startChecks', 'N.1');
      run.tree('recordChecks', 'N.1', [{ checkId: 'N.1/k1', ok: false }]);
    }
    assert.equal(run.state.tree.nodes['N.1'].status, 'blocked', `cap ${cap}`);
  }
  assert.equal(Run.create({ sessionFolder: tmpdir(), prdText: PRD }).state.settings.fixCap, 3);
});

test('U12: queued questions are batched only when nothing else is runnable', () => {
  const run = runWithTree();
  run.decide({ what: 'q1', choice: 'a', change: { nodeId: 'N.1', touchesDocs: true }, proof: {} });
  assert.equal(situation(run.state.tree), 'runnable', 'N.2 still runnable: no batch yet');
  run.tree('claim', 'N.2', 'W');
  run.tree('submit', 'N.2', {});
  run.tree('startChecks', 'N.2');
  run.tree('recordChecks', 'N.2', [{ checkId: 'N.2/k1', ok: true }]);
  assert.equal(situation(run.state.tree), 'stuck', 'now the batch is due');
  assert.equal(run.openQueue().length, 1);
});

test('U15: the report has every section, for done, stopped and blocked endings, and is written to report.md', () => {
  const run = runWithTree();
  run.store.commit('check_def', { id: 'U1', kind: 'automated', requirementIds: ['A1'], command: 'true' });
  run.store.commit('check_def', { id: 'H1', kind: 'human', requirementIds: ['B1'], text: 'look at it' });
  run.recordCheck('U1', { ok: true, output: 'pass', commit: 'abcdef1234' });
  run.blocker({ nodeId: 'N.2', what: 'export blocked', why: 'missing access', how: 'preflight', fixes: ['grant access'] });
  run.decide({ what: 'lib', choice: 'none', change: { nodeId: 'N.1' }, proof: { source: true, test: true } });
  run.note('suggestion', 'repo1: add a typecheck script');
  for (const [side, re] of [[null, /ending: \*\*in progress/], ['stopped', /ending: \*\*stopped/], ['blocked', /ending: \*\*blocked/]]) {
    if (side) run.store.commit('side', { side, reason: 'x' });
    const md = run.writeReport();
    assert.match(md, re);
    for (const h of ['## What was built', '## Requirement → check → result', '## Blockers', '## Human checks', '## Decisions', '## Permissions used', '## Budget used', '## Branches and PRs']) assert.ok(md.includes(h), h);
    assert.match(md, /\| A1 \| U1 \| automated \| pass \| abcdef12/);
    assert.match(md, /\| B1 \| H1 \| human \| not run/);
    assert.match(md, /export blocked/);
    assert.match(md, /## Risk\nLow: every call is inside one leaf, every call can be undone\./);
    assert.ok(md.trimEnd().split('\n## ').at(-1).startsWith('Suggestions for your repo'), 'suggestions come last');
    assert.match(md, /- repo1: add a typecheck script/);
    assert.ok(fs.existsSync(path.join(run.dir, 'report.md')));
    assert.ok(fs.existsSync(path.join(run.dir, 'ledger.md')));
  }
});

test('U18: progress checklist and bar are correct, and a step back is marked when the tree grows', () => {
  const run = runWithTree();
  let p = run.progress();
  assert.deepEqual(p.bar, { done: 0, total: 2, pct: 0 });
  run.tree('claim', 'N.1', 'W');
  run.tree('submit', 'N.1', {});
  run.tree('startChecks', 'N.1');
  run.tree('recordChecks', 'N.1', [{ checkId: 'N.1/k1', ok: true }]);
  p = run.progress();
  assert.deepEqual(p.bar, { done: 1, total: 2, pct: 50 });
  run.tree('claim', 'N.2', 'W');
  run.tree('split', 'N.2', [
    { title: 'x', doneWhen: ['a'], covers: ['N.2#c1'], traces: { requirements: ['B1'] }, kind: 'behaviour', checks: [{ command: 'true' }] },
    { title: 'y', doneWhen: ['b'], covers: ['N.2#c1'], traces: { requirements: ['B1'] }, kind: 'behaviour', checks: [{ command: 'true' }] },
  ]);
  p = run.progress();
  assert.deepEqual(p.bar, { done: 1, total: 3, pct: 33 });
  assert.equal(p.grewBy, 1);
  const text = renderProgress(p);
  assert.match(text, /plan grew: \+1 items/);
  assert.match(text, /\[#{7}-{13}\] 33% \(1\/3\)/);
  assert.match(text, /\[x\] core — 1\/1/);
});
