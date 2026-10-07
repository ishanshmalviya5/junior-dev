// U1 (every phase guard), U17 (pause / resettle), U13 (docs location + exclude), U16 (resume picker).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Run, listFeatures, resumeChoice } from '../lib/engine/run.js';
import { pause, resettle, resume, PHASES } from '../lib/engine/phases.js';
import * as Locks from '../lib/engine/locks.js';
import * as G from '../lib/engine/git.js';
import { tmpdir, gitRepo, PRD, REQUIREMENTS, VP, SPECS, PLAN } from './helpers.js';

function settle(run, repo) {
  run.set('repos', [{ path: repo, mode: 'in-place', branch: 'junior-dev/greet', workPath: repo, baseRef: G.head(repo) }]);
  run.set('permissions', { push: false, pr: false, remoteWrites: [], debugEnv: null });
  run.set('budget', { timeMin: 60, tokens: 1e6 });
  const m = { provider: 'p', model: 'm' };
  run.set('models', { planner: m, builder: m, checker: m, reviewer: m });
  run.set('crossModel', { enabled: false });
  run.set('dial', 'balanced');
}

/** Drive a run to `target`, asserting each guard refuses first when its condition is missing. */
function driveTo(target, { refuseFirst = true } = {}) {
  const session = tmpdir();
  const repo = path.join(session, 'app');
  gitRepo(path.join(session), { 'README.md': 'session\n' });
  gitRepo(repo, { 'index.js': 'export {}\n' });
  const run = Run.create({ sessionFolder: session, prdText: PRD, sessionId: 'S1' });
  const steps = {
    research: () => {},
    interview: () => {
      if (refuseFirst) assert.equal(run.advance('interview').ok, false, 'research guard');
      run.addFact('repo is ESM', 'package.json');
    },
    prd_parity: () => {
      const q = run.recordQuestion({ question: 'push?', options: ['yes', 'no'] });
      if (refuseFirst) assert.match(run.advance('prd_parity').reasons[0], /unanswered/);
      run.recordAnswer(q, 'no');
    },
    requirements: () => {
      if (refuseFirst) assert.match(run.advance('requirements').reasons[0], /parity/);
      run.parity('prd', true);
    },
    verification_plan: () => {
      if (refuseFirst) assert.match(run.advance('verification_plan').reasons[0], /does not exist/);
      run.writeDoc('requirements', REQUIREMENTS.replace('### What needs you', '### Nope'));
      if (refuseFirst) assert.match(run.advance('verification_plan').reasons.join(), /Highlights incomplete/);
      run.writeDoc('requirements', REQUIREMENTS);
      if (refuseFirst) assert.match(run.advance('verification_plan').reasons.join(), /no parity yes/);
      run.parity('requirements', true);
    },
    specs: () => {
      run.writeDoc('verificationPlan', VP.replace('| U2 | automated | export test | B1 | |\n', ''));
      if (refuseFirst) assert.match(run.advance('specs').reasons.join(), /requirements without a check: B1/);
      run.writeDoc('verificationPlan', VP);
      run.parity('verificationPlan', true);
    },
    implementation_plan: () => {
      run.writeDoc('specs', SPECS.replace(' [B1]', ''));
      if (refuseFirst) assert.match(run.advance('implementation_plan').reasons.join(), /citing no requirement|no spec item cites/);
      run.writeDoc('specs', SPECS);
    },
    preflight: () => {
      run.writeDoc('implementationPlan', PLAN);
      if (refuseFirst) assert.match(run.advance('preflight').reasons.join(), /work tree/);
      assert.ok(run.tree('init', { requirements: run.requirementIds(), title: 'greet' }).ok);
      assert.ok(
        run.tree('split', 'N', [
          { title: 'greet', doneWhen: ['works'], covers: ['N#A1', 'N#A2'], traces: { requirements: ['A1', 'A2'] }, checks: [{ command: 'true' }] },
          { title: 'export', doneWhen: ['exported'], covers: ['N#B1'], traces: { requirements: ['B1'] }, checks: [{ command: 'true' }], dependsOn: ['#1'] },
        ]).ok,
      );
    },
    final_parity: () => {
      if (refuseFirst) assert.match(run.advance('final_parity').reasons[0], /preflight has not run/);
      run.preflight('git', 'git works', false, 'not found');
      if (refuseFirst) assert.match(run.advance('final_parity').reasons[0], /preflight failed/);
      run.preflight('git', 'git works', true, '');
    },
    build: () => {
      if (refuseFirst) {
        const r = run.advance('build');
        assert.ok(r.reasons.some((x) => /no parity yes recorded for final/.test(x)));
        assert.ok(r.reasons.some((x) => /not settled/.test(x)));
      }
      settle(run, repo);
      run.parity('final', true);
      if (refuseFirst) assert.match(run.advance('build').reasons.join(), /no lock held/);
      Locks.acquire(repo, { feature: run.lockKey, sessionId: 'S1' });
      // editing a read doc after its parity yes re-requires parity
      fs.appendFileSync(run.docPath('requirements'), '\n');
      if (refuseFirst) assert.match(run.advance('build').reasons.join(), /requirements changed after its parity yes/);
      run.parity('requirements', true);
      // the final yes covers documents and settings: any change after it refuses the build
      if (refuseFirst) assert.match(run.advance('build').reasons.join(), /final changed after its parity yes/);
      run.parity('final', true);
      run.set('dial', 'bold');
      if (refuseFirst) assert.match(run.advance('build').reasons.join(), /final changed after its parity yes/);
      run.parity('final', true);
    },
  };
  for (const ph of PHASES.slice(1, PHASES.indexOf(target) + 1)) {
    steps[ph]?.();
    const r = run.advance(ph);
    assert.ok(r.ok, `advance to ${ph}: ${r.reasons.join('; ')}`);
  }
  return { run, session, repo };
}

test('U1: every guard refuses when its condition is missing, then allows; refusals are recorded', () => {
  const { run } = driveTo('build');
  assert.equal(run.state.phase, 'build');
  const refused = run.state.history.filter((h) => !h.ok);
  assert.ok(refused.length >= 14, `refusals recorded: ${refused.length}`);
  assert.ok(refused.every((h) => h.reasons.length > 0));
});

test('U1: phases cannot be skipped or reordered', () => {
  const session = tmpdir();
  const run = Run.create({ sessionFolder: session, prdText: PRD });
  assert.match(run.advance('build').reasons[0], /does not follow intake/);
  assert.match(run.advance('interview').reasons[0], /does not follow intake/);
});

test('U1: build → verify refused while items are unfinished or parked; deliver → done needs the report', () => {
  const { run, repo } = driveTo('build');
  assert.match(run.advance('verify').reasons[0], /unfinished items/);
  const q = run.decide({ what: 'pick lib', choice: 'x', change: { nodeId: 'N.1', touchesDocs: true }, proof: {} });
  assert.equal(q.outcome, 'park');
  assert.match(run.advance('verify').reasons[0], /parked items/);
  run.answerQueued([{ id: q.questionId, answer: 'x' }]);
  for (const id of ['N.1', 'N.2']) {
    assert.ok(run.tree('claim', id, 'W').ok);
    assert.ok(run.tree('submit', id, {}).ok);
    assert.ok(run.tree('startChecks', id).ok);
    assert.ok(run.tree('recordChecks', id, [{ checkId: `${id}/k1`, ok: true }]).ok);
  }
  assert.ok(run.tree('startChecks', 'N').ok);
  assert.ok(run.tree('recordChecks', 'N', []).ok);
  assert.equal(run.state.tree.nodes.N.status, 'done');
  assert.ok(run.advance('verify').ok);
  assert.match(run.advance('human_checks').reasons.join(), /check U1 has no result/);
  for (const id of ['U1', 'U2']) run.recordCheck(id, { ok: true, output: 'ok', commit: null });
  assert.ok(run.advance('human_checks').ok);
  assert.match(run.advance('deliver').reasons[0], /human checks without a result: H1/);
  run.recordCheck('H1', { ok: true, output: 'looked fine', by: 'developer' });
  assert.ok(run.advance('deliver').ok);
  assert.match(run.advance('done').reasons.join(), /report.md not written/);
  run.writeReport();
  assert.ok(run.advance('done').ok, run.state.history.at(-1).reasons.join());
  void repo;
});

test('U1: the deliver guard git scan finds a doc file committed by force', () => {
  const { run, repo } = driveTo('build');
  // put the session docs inside the repo and commit one by force
  const g = (...a) => G.git(repo, a);
  const docInRepo = path.join(repo, 'docs', run.name);
  fs.mkdirSync(docInRepo, { recursive: true });
  fs.writeFileSync(path.join(docInRepo, 'x.md'), 'x');
  g('checkout', '-q', '-b', 'junior-dev/greet');
  g('add', '-f', 'docs');
  g('commit', '-q', '-m', 'oops');
  run.state.settings.repos[0].workPath = repo;
  // point the run's dir inside the repo to exercise the scan
  const leaked = G.trackedUnder(repo, path.join('docs', run.name));
  assert.deepEqual(leaked, [`docs/${run.name}/x.md`]);
});

test('U17: a developer message pauses at a checkpoint, resettles to the earliest affected phase, and parity is re-required', () => {
  const { run } = driveTo('build');
  assert.equal(pause(run.store, 'developer changed the export name').ok, true);
  assert.equal(run.state.side, 'paused');
  assert.match(run.advance('verify').reasons[0], /run is paused/);
  // the developer's change edits the requirements; the agent asks to continue in build, the plugin moves it back
  fs.writeFileSync(run.docPath('requirements'), REQUIREMENTS.replace('Hello, <name>!', 'Hi, <name>!'));
  const r = resettle(run.store, 'build', { readDoc: (k) => run.readDoc(k) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, ['requirements']);
  assert.equal(run.state.phase, 'requirements');
  assert.equal(run.state.side, null);
  assert.equal(run.state.parity.requirements.yes, false);
  assert.equal(run.state.parity.final.yes, false);
  assert.match(run.advance('verification_plan').reasons.join(), /no parity yes recorded for requirements/);
});

test('U17: pause outside build/verify is refused; resume clears paused/stopped but not blocked', () => {
  const session = tmpdir();
  const run = Run.create({ sessionFolder: session, prdText: PRD });
  assert.equal(pause(run.store, 'x').ok, false);
  run.store.commit('side', { side: 'stopped', reason: 'budget' });
  assert.equal(resume(run.store).ok, true);
  run.store.commit('side', { side: 'blocked', reason: 'nothing can move' });
  assert.equal(resume(run.store).ok, false);
});

test('U13: docs live in <session>/docs/<feature>/ and are excluded locally in git', () => {
  const session = tmpdir();
  gitRepo(session);
  const run = Run.create({ sessionFolder: session, prdText: PRD });
  assert.equal(run.dir, path.join(session, 'docs', 'add-greeting-helper'));
  assert.ok(fs.existsSync(path.join(run.dir, 'prd.md')));
  const exclude = fs.readFileSync(path.join(session, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/docs\/add-greeting-helper\/$/m);
  assert.equal(G.git(session, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(run.dir, 'prd.md'), 'utf8'), PRD, 'PRD stored verbatim (A2)');
  // rename (D2) keeps exclude correct
  run.rename('greet-helper');
  assert.match(fs.readFileSync(path.join(session, '.git', 'info', 'exclude'), 'utf8'), /^\/docs\/greet-helper\/$/m);
  assert.equal(G.git(session, ['status', '--porcelain']), '');
  assert.equal(Run.open(session, 'greet-helper').state.feature.name, 'greet-helper');
});

test('U16: resume picker — none, direct, pick', () => {
  const session = tmpdir();
  assert.equal(resumeChoice(listFeatures(session)).mode, 'none');
  Run.create({ sessionFolder: session, prdText: PRD, name: 'one' });
  assert.deepEqual(resumeChoice(listFeatures(session)), { mode: 'direct', items: [{ name: 'one', phase: 'intake', side: null, sideReason: null, finished: false }] });
  const two = Run.create({ sessionFolder: session, prdText: PRD, name: 'two' });
  two.store.commit('side', { side: 'stopped', reason: 'budget' });
  const pick = resumeChoice(listFeatures(session));
  assert.equal(pick.mode, 'pick');
  assert.deepEqual(pick.items.map((i) => [i.name, i.side]), [['one', null], ['two', 'stopped']]);
});

test('J1/H1 (review #9): settings changed while paused send the run back to the final parity', () => {
  const { run } = driveTo('build');
  pause(run.store, 'developer allows pushing now');
  run.set('permissions', { push: true, pr: false, remoteWrites: [], debugEnv: null });
  const r = resettle(run.store, 'build', { readDoc: (k) => run.readDoc(k) });
  assert.equal(r.phase, 'final_parity');
  assert.equal(run.state.parity.final.yes, false);
});

test('C6 (review #13): a parity yes cannot be given before its document exists', () => {
  const run = Run.create({ sessionFolder: tmpdir(), prdText: PRD });
  assert.throws(() => run.parity('requirements', true), /does not exist yet/);
});

