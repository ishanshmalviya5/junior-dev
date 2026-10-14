// U4 (ripple rules R1–R7), U5 (tools reject invalid calls), U6 (proven done), U7 (scheduler).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../lib/engine/tree.js';
import { next, situation, actionFor } from '../lib/engine/scheduler.js';
import { initialState, reduce } from '../lib/engine/reducer.js';

const REQS = ['A1', 'A2', 'B1'];
const ctx = { requirements: REQS, fixCap: 3 };

/** Minimal in-memory runner: applies ops like Run.tree does. */
function harness() {
  const state = initialState();
  let seq = 0;
  const apply = (op, ...args) => {
    const fn = T[op];
    const res = ['split', 'add'].includes(op) ? fn(state.tree, ...args, ctx) : op === 'recordChecks' ? fn(state.tree, args[0], args[1], ctx) : fn(state.tree, ...args);
    if (res.ok) reduce(state, { seq: ++seq, ts: 't', type: 'tree', data: { patch: res.patch } });
    return res;
  };
  return { state, apply, node: (id) => state.tree.nodes[id] };
}

const leaf = (title, covers, reqs, extra = {}) => ({ title, doneWhen: [`${title} works`], covers, traces: { requirements: reqs }, kind: 'behaviour', checks: [{ command: 'true' }], ...extra });

function base() {
  const h = harness();
  assert.ok(h.apply('init', { requirements: REQS, title: 'F' }).ok);
  const r = h.apply('split', 'N', [
    leaf('core', ['N#A1', 'N#A2'], ['A1', 'A2'], { provides: [{ name: 'greet()' }] }),
    leaf('export', ['N#B1'], ['B1'], { dependsOn: ['#1'], uses: ['C:N.1:greet()'] }),
  ]);
  assert.ok(r.ok, r.reasons?.join('; '));
  return h;
}

function finish(h, id) {
  assert.ok(h.apply('claim', id, 'W').ok);
  assert.ok(h.apply('submit', id, {}).ok);
  assert.ok(h.apply('startChecks', id).ok);
  const checks = h.node(id).checks.map((c) => ({ checkId: c.id, ok: true }));
  const r = h.apply('recordChecks', id, checks);
  assert.ok(r.ok);
  assert.equal(h.node(id).status, 'done');
}

test('R1 Cover: a split must cover every parent criterion, and children may only cover parent criteria', () => {
  const h = harness();
  h.apply('init', { requirements: REQS });
  const gap = h.apply('split', 'N', [leaf('a', ['N#A1'], ['A1'])]);
  assert.equal(gap.ok, false);
  assert.equal(gap.rule, 'R1');
  assert.match(gap.reasons.join(), /not covered by any child: N#A2, N#B1/);
  const bad = h.apply('split', 'N', [leaf('a', ['N#A1', 'N#A2', 'N#B1', 'N#Z9'], REQS)]);
  assert.match(bad.reasons.join(), /N#Z9, which is not a done-when criterion/);
});

test('R1 Cover: removing a child that leaves a gap is refused; removing a redundant one is allowed', () => {
  const h = base();
  const r = h.apply('remove', 'N.2');
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /N#B1/);
  assert.ok(h.apply('add', 'N', leaf('extra', ['N#B1'], ['B1'])).ok);
  assert.ok(h.apply('remove', 'N.3').ok);
});

test('R2 Trace: an item with no requirement, an unknown one, or one outside its parent is refused (scope creep)', () => {
  const h = base();
  assert.match(h.apply('add', 'N', leaf('x', [], [])).reasons.join(), /traces to no requirement/);
  assert.match(h.apply('add', 'N', leaf('x', [], ['Z1'])).reasons.join(), /unknown requirements: Z1/);
  // split N.2 (traces B1 only); a child tracing A1 is outside its parent
  assert.ok(h.apply('claim', 'N.1', 'W'));
  const r = h.apply('split', 'N.1', [leaf('y', ['N.1#c1'], ['B1'])]);
  assert.equal(r.rule, 'R2');
  assert.match(r.reasons.join(), /outside its parent N\.1 \(scope creep\)/);
});

test('R3 Roll-up: parent done only after all children done AND its integration check passes; a reopened child reopens ancestors', () => {
  const h = harness();
  h.apply('init', { requirements: REQS, integrationChecks: [{ command: 'true' }] });
  h.apply('split', 'N', [leaf('core', ['N#A1', 'N#A2'], ['A1', 'A2']), leaf('export', ['N#B1'], ['B1'])]);
  finish(h, 'N.1');
  assert.equal(h.node('N').status, 'split');
  finish(h, 'N.2');
  assert.equal(h.node('N').status, 'ready', 'integration due');
  assert.equal(actionFor(h.node('N')), 'integrate');
  assert.ok(h.apply('startChecks', 'N').ok);
  assert.ok(h.apply('recordChecks', 'N', [{ checkId: 'N/k1', ok: true }]).ok);
  assert.equal(h.node('N').status, 'done');
  const r = h.apply('reopen', 'N.1', 'bug found');
  assert.ok(r.ok);
  assert.equal(h.node('N.1').status, 'recheck');
  assert.equal(h.node('N').status, 'split', 'the parent left done and waits for its children again');
  assert.deepEqual(r.affected.sort(), ['N', 'N.1']);
});

test('R3: a branch whose children are all resolved with one blocked becomes blocked', () => {
  const h = base();
  finish(h, 'N.1');
  assert.ok(h.apply('block', 'N.2', 'B1').ok);
  assert.equal(h.node('N').status, 'blocked');
  assert.equal(situation(h.state.tree), 'resolved');
});

test('R4 Contracts: changing a contract sends its done users (and their done ancestors) to recheck; only the owner may change it', () => {
  const h = base();
  finish(h, 'N.1');
  finish(h, 'N.2');
  assert.match(h.apply('changeContract', 'C:N.1:greet()', { description: 'v2', byNodeId: 'N.2' }).reasons.join(), /does not own/);
  const r = h.apply('changeContract', 'C:N.1:greet()', { description: 'greet(name, punct)', byNodeId: 'N.1' });
  assert.ok(r.ok);
  assert.equal(h.state.tree.contracts['C:N.1:greet()'].version, 2);
  assert.equal(h.node('N.2').status, 'recheck');
  assert.equal(h.node('N.1').status, 'done', 'the owner is not sent to recheck');
  assert.deepEqual(r.affected.sort(), ['N', 'N.2']);
  assert.equal(h.node('N').status, 'split');
});

test('R5 Order: an item is not ready until its dependency is done; loops are refused; a reopened dependency un-readies dependents', () => {
  const h = base();
  assert.equal(h.node('N.1').status, 'ready');
  assert.equal(h.node('N.2').status, 'new');
  finish(h, 'N.1');
  assert.equal(h.node('N.2').status, 'ready');
  const loop = h.apply('setDeps', 'N.1', ['N.2']);
  assert.equal(loop.rule, 'R5');
  assert.match(loop.reasons[0], /dependency loop/);
  h.apply('reopen', 'N.1', 'regression');
  assert.equal(h.node('N.2').status, 'new');
  assert.match(h.apply('setDeps', 'N.1', ['N.9']).reasons[0], /unknown nodes: N.9/);
});

test('R6 Push-down: removing a criterion during resettle is caught by cover on the next split/add', () => {
  const h = base();
  // simulate a resettle that rewrote N.1's criteria, then a split that ignores them
  h.apply('claim', 'N.1', 'W');
  const r = h.apply('split', 'N.1', [leaf('half', ['N.1#c9'], ['A1'])]);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /not a done-when criterion of N\.1|not covered/);
});

test('U5: invalid tool calls are refused with reasons; illegal state jumps are refused', () => {
  const h = base();
  assert.match(h.apply('submit', 'N.1', {}).reasons[0], /expected working/);
  assert.match(h.apply('claim', 'N.2', 'W').reasons[0], /N.2 is new/);
  assert.match(h.apply('recordChecks', 'N.1', [{ checkId: 'x', ok: true }]).reasons[0], /only while checking/);
  assert.match(h.apply('remove', 'N').reasons[0], /cannot remove the root/);
  assert.match(h.apply('split', 'N', [leaf('z', ['N#A1'], ['A1'])]).reasons[0], /already split/);
  const noCheck = h.apply('add', 'N', { title: 'z', doneWhen: ['x'], covers: ['N#A1'], traces: { requirements: ['A1'] } });
  assert.match(noCheck.reasons.join(), /leaf with no check/);
  assert.ok(h.apply('add', 'N', { title: 'z', doneWhen: ['x'], covers: ['N#A1'], traces: { requirements: ['A1'] }, needsSplit: true }).ok);
});

test('U6: done only via recorded passing checks; failures retry up to the cap, then block', () => {
  const h = base();
  h.apply('claim', 'N.1', 'W');
  h.apply('submit', 'N.1', {});
  h.apply('startChecks', 'N.1');
  assert.ok(h.apply('recordChecks', 'N.1', [{ checkId: 'N.1/k1', ok: false, output: 'boom' }]).ok);
  assert.equal(h.node('N.1').status, 'ready');
  assert.equal(h.node('N.1').attempts, 1);
  for (let i = 2; i <= 3; i++) {
    h.apply('claim', 'N.1', 'W');
    h.apply('submit', 'N.1', {});
    h.apply('startChecks', 'N.1');
    h.apply('recordChecks', 'N.1', [{ checkId: 'N.1/k1', ok: false }]);
  }
  assert.equal(h.node('N.1').status, 'blocked');
  assert.match(h.node('N.1').statusWhy, /failed 3 times \(cap 3\)/);
  // no API sets done directly
  assert.equal(typeof T.setDone, 'undefined');
  // a passing result for some other check id does not count
  const h2 = base();
  h2.apply('claim', 'N.1', 'W');
  h2.apply('submit', 'N.1', {});
  h2.apply('startChecks', 'N.1');
  h2.apply('recordChecks', 'N.1', [{ checkId: 'other', ok: true }]);
  assert.notEqual(h2.node('N.1').status, 'done');
});

test('U7: scheduler picks the longest dependent chain first, then risk, then id; one at a time', () => {
  const h = harness();
  h.apply('init', { requirements: REQS });
  h.apply('split', 'N', [
    leaf('lowrisk', ['N#A1'], ['A1'], { risk: 'low' }),
    leaf('highrisk', ['N#A2'], ['A2'], { risk: 'high' }),
    leaf('base', ['N#B1'], ['B1'], { risk: 'low' }),
    leaf('needs-base', ['N#B1'], ['B1'], { dependsOn: ['#3'] }),
  ]);
  assert.equal(next(h.state.tree).id, 'N.3', 'chain length 2 wins');
  finish(h, 'N.3');
  assert.equal(next(h.state.tree).id, 'N.2', 'then high risk');
  h.apply('claim', 'N.2', 'W');
  assert.equal(situation(h.state.tree), 'runnable');
  assert.equal(h.apply('claim', 'N.2', 'W2').ok, false, 'a claimed item cannot be claimed again');
});

test('U7/S8.3: situation reports stuck when only parked items remain, done when all done', () => {
  const h = base();
  h.apply('park', 'N.1', 'QQ1');
  assert.equal(situation(h.state.tree), 'stuck');
  h.apply('unpark', 'N.1');
  assert.equal(h.node('N.1').status, 'ready');
  finish(h, 'N.1');
  finish(h, 'N.2');
  assert.equal(h.node('N').status, 'ready');
  h.apply('startChecks', 'N');
  h.apply('recordChecks', 'N', []);
  assert.equal(situation(h.state.tree), 'done');
});

test('R3 (review #6): after a contract change the parent waits for the rechecked child before integrating', () => {
  const h = base();
  finish(h, 'N.1');
  finish(h, 'N.2');
  h.apply('changeContract', 'C:N.1:greet', { description: 'v2', byNodeId: 'N.1' });
  // contract id in base() is C:N.1:greet()
  h.apply('changeContract', 'C:N.1:greet()', { description: 'v2', byNodeId: 'N.1' });
  assert.equal(h.node('N.2').status, 'recheck');
  assert.equal(h.node('N').status, 'split');
  assert.equal(next(h.state.tree).id, 'N.2', 'the child goes first');
  assert.equal(h.apply('startChecks', 'N').ok, false);
});

test('E6 (review #7): a blocked dependency blocks its dependents, so the run can still finish the rest', () => {
  const h = harness();
  h.apply('init', { requirements: REQS });
  h.apply('split', 'N', [leaf('a', ['N#A1'], ['A1']), leaf('b', ['N#A2'], ['A2'], { dependsOn: ['#1'] }), leaf('c', ['N#B1'], ['B1'])]);
  h.apply('block', 'N.1', 'B1');
  assert.equal(h.node('N.2').status, 'blocked');
  assert.match(h.node('N.2').statusWhy, /depends on blocked N\.1/);
  finish(h, 'N.3');
  assert.equal(situation(h.state.tree), 'resolved');
});

test('v2-03 U-check: a leaf needs a valid kind (behaviour | refactor); needsSplit items are exempt', () => {
  const h = harness();
  assert.ok(h.apply('init', { requirements: REQS, title: 'F' }).ok);
  const noKind = { ...leaf('a', ['N#A1', 'N#A2', 'N#B1'], REQS) };
  delete noKind.kind;
  const r = h.apply('split', 'N', [noKind]);
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'K1');
  assert.match(r.reasons[0], /without a valid kind/);
  const bad = h.apply('split', 'N', [leaf('a', ['N#A1', 'N#A2', 'N#B1'], REQS, { kind: 'feature' })]);
  assert.equal(bad.ok, false);
  assert.ok(h.apply('split', 'N', [leaf('a', ['N#A1', 'N#A2'], ['A1', 'A2'], { kind: 'refactor' }), { title: 'later', doneWhen: ['x'], covers: ['N#B1'], traces: { requirements: ['B1'] }, needsSplit: true }]).ok);
  assert.equal(h.node('N.1').leafKind, 'refactor');
  const spec = { title: 'z', doneWhen: ['x'], covers: ['N#A1'], traces: { requirements: ['A1'] }, checks: [{ command: 'true' }] };
  assert.equal(h.apply('add', 'N', spec).ok, false, 'add also needs a kind');
  assert.ok(h.apply('add', 'N', { ...spec, kind: 'behaviour' }).ok);
});

test('v2-03 U-check: setChecks rewrites a working leaf\'s checks only', () => {
  const h = base();
  assert.equal(h.apply('setChecks', 'N.1', [{ command: 'false' }]).ok, false, 'not working yet');
  assert.ok(h.apply('claim', 'N.1', 'W').ok);
  assert.equal(h.apply('setChecks', 'N.1', []).ok, false);
  assert.ok(h.apply('setChecks', 'N.1', [{ command: 'false' }]).ok);
  assert.equal(h.node('N.1').checks[0].command, 'false');
});

test('U6b (v2-09): leaf checks accept the tool form (structured or text); a tool check with no pass rule is refused', () => {
  const h = harness();
  assert.ok(h.apply('init', { requirements: REQS, title: 'F' }).ok);
  const bad = h.apply('split', 'N', [leaf('all', ['N#A1', 'N#A2', 'N#B1'], REQS, { checks: [{ tool: 'xcode_build', arguments: {} }] })]);
  assert.ok(!bad.ok);
  assert.match(bad.reasons.join(), /no pass rule/);
  const r = h.apply('split', 'N', [
    leaf('all', ['N#A1', 'N#A2', 'N#B1'], REQS, { checks: [{ tool: 'xcode_build', arguments: { scheme: 'App' }, pass: 'build_ok' }, { command: 'tool:xcode_test {} pass:tests_ok' }] }),
  ]);
  assert.ok(r.ok, r.reasons?.join('; '));
  const [a, b] = h.node('N.1').checks;
  assert.deepEqual([a.tool, a.arguments, a.pass, a.command], ['xcode_build', { scheme: 'App' }, 'build_ok', null]);
  assert.deepEqual([b.tool, b.pass], ['xcode_test', 'tests_ok']);
});
