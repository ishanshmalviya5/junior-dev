// T-level checks in-process: the real tools, gate and loop with scripted workers (fake AI),
// toy git repos with local bare remotes, and a fake `gh` on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hub } from '../lib/host/hub.js';
import { rootTools, workerTools, latestUserText } from '../lib/host/tools.js';
import { toAskPayload } from '../lib/host/services.js';
import { judge } from '../lib/host/gate.js';
import { progressFor } from '../lib/index.js';
import { Run } from '../lib/engine/run.js';
import { tmpdir, gitRepo } from './helpers.js';

process.env.JD_WORKTREES_ROOT = tmpdir('jd-wt-');
process.env.JD_HOME = tmpdir('jd-home-');
process.env.JD_RETRY_ASK_MS = '10';

const T = Object.fromEntries([...rootTools, ...workerTools].map((t) => [t.name, t]));
const sig = () => new AbortController().signal;

const PRD_TEXT = `# Greeting helper\n\nAdd greet(name) returning "Hello, <name>!" and export it from index.js. See /tmp/notes.md for background.\n`;

function makeWorld({ repos = 1, push = false, pr = false, crossModel = false, human = true } = {}) {
  const session = tmpdir('jd-session-');
  const binDir = path.join(session, '.bin');
  fs.mkdirSync(binDir);
  const ghLog = path.join(session, 'gh.log');
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\necho "$@" >> "${ghLog}"\nif [ "$1" = "pr" ] && [ "$2" = "create" ]; then n=$(grep -c "^pr create" "${ghLog}"); echo "https://github.com/example/repo/pull/$n"; fi\n`, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH.split(':').filter((p) => !p.includes('jd-session-')).join(':')}`;
  const repoPaths = [];
  for (let i = 0; i < repos; i++) {
    const repo = path.join(session, `repo${i + 1}`);
    gitRepo(repo, { 'package.json': '{"type":"module"}\n', 'index.js': 'export {};\n' });
    const bare = path.join(session, `remote${i + 1}.git`);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    repoPaths.push(repo);
  }
  const root = { id: `ROOT-${path.basename(session)}`, session: { header: { cwd: session }, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: PRD_TEXT }] }] } };
  const worker = { id: `W-${path.basename(session)}`, session: { header: { cwd: session, delegationDepth: 1, origin: 'subagent', parentSession: root.id } } };
  const calls = { asks: [], notify: [], spawns: [] };
  const answers = { human: () => 'Pass' };
  const scripts = { reviewer: async () => '{"findings":[]}' }; // role or nodeId → async (ctx) => void
  hub.host = { logger: () => console };
  hub.overrides = {
    async ask(_h, questions) {
      calls.asks.push(questions.map((q) => q.id));
      return questions.map((q) => {
        if (q.id.startsWith('HC:')) return { id: q.id, selected: [answers.human(q)], custom: answers.human(q) === 'Fail' ? 'button is red' : null };
        if (q.header === 'Parity') return { id: q.id, selected: ['Yes'], custom: null };
        return { id: q.id, selected: [q.options?.[0]?.label ?? 'ok'], custom: q.options?.length ? null : 'free answer' };
      });
    },
    async notifyRoot(_h, text) {
      calls.notify.push(text);
    },
    async checkModel(m) {
      return { ok: true, detail: `${m.provider}/${m.model}` };
    },
    async listModels() {
      return [{ provider: 'fake', model: 'm1' }];
    },
    async setFullAccess() {
      return true;
    },
    subscriptionSettings() {
      return { providers: ['fake', 'other'], subscriptionOnly: true, cascadingFallback: false };
    },
    async tokensOf() {
      return 0;
    },
    async spawnWorker(h, { role, prompt, model, register }) {
      calls.spawns.push({ role, model, nodeId: h.worker?.nodeId ?? null, checkId: h.worker?.checkId ?? null, register });
      hub.byWorker.set(worker.id, h.key);
      if (register !== false && h.worker) h.worker.childId = worker.id;
      const key = h.worker?.nodeId ? `${role}:${h.worker.nodeId}` : role;
      const fn = scripts[key] ?? scripts[role] ?? (async () => {});
      const exec = (name, args) => T[name].execute(args, { agent: worker, signal: sig() });
      try {
        const out = await fn({ h, exec, prompt, role, model, run: h.run, work: (r) => r.workPath });
        return { stopReason: 'completed', text: typeof out === 'string' ? out : '', tokens: 1000 };
      } catch (e) {
        return { stopReason: 'error', text: e.message, tokens: 10 };
      }
    },
  };
  const rootExec = (name, args = {}) => T[name].execute(args, { agent: root, signal: sig() });
  const m = { provider: 'fake', model: 'm1' };

  async function settleToFinal() {
    const j = (s) => JSON.parse(s);
    assert.equal(j(await rootExec('jd_start')).phase, 'research');
    await rootExec('jd_fact', { text: 'repo is ESM', source: 'package.json' });
    assert.ok(j(await rootExec('jd_advance', { to: 'interview' })).ok);
    await rootExec('jd_ask', { question: 'Should greet trim the name?', options: ['No', 'Yes'], recommended: 'No' });
    await rootExec('jd_set', { key: 'repos', value: repoPaths.map((p) => ({ path: p, mode: 'worktree' })) });
    await rootExec('jd_set', { key: 'permissions', value: { push, pr, remoteWrites: [], debugEnv: null } });
    await rootExec('jd_set', { key: 'budget', value: { timeMin: 30, tokens: 1e7 } });
    await rootExec('jd_set', { key: 'models', value: { planner: m, builder: m, checker: m } });
    await rootExec('jd_set', { key: 'crossModel', value: crossModel ? { enabled: true, model: { provider: 'other', model: 'x' } } : { enabled: false } });
    await rootExec('jd_set', { key: 'dial', value: 'balanced' });
    assert.ok(j(await rootExec('jd_advance', { to: 'prd_parity' })).ok);
    assert.equal(j(await rootExec('jd_parity', { key: 'prd', restatement: 'greet + export' })).parity, true);
    assert.ok(j(await rootExec('jd_advance', { to: 'requirements' })).ok);
    const reqs = `# Greet — Requirements\n## Highlights\n### What gets built\n- greet\n### What doesn't\n- i18n\n### Decisions & assumptions\n- none\n### What needs you\n- hand check\n## Requirements\n- **A1 Greet.** greet(name) returns "Hello, <name>!".\n- **B1 Export.** index.js exports greet.\n`;
    assert.equal(j(await rootExec('jd_write_doc', { key: 'requirements', content: reqs })).ok, true);
    await rootExec('jd_parity', { key: 'requirements', restatement: 'A1 greet, B1 export' });
    assert.ok(j(await rootExec('jd_advance', { to: 'verification_plan' })).ok);
    const r1 = repoPaths[0];
    const vp = `# VP\n## Highlights\n### What gets built\n- checks\n### What doesn't\n- none\n### Decisions & assumptions\n- none\n### What needs you\n- H1\n## Checks\n| ID | Kind | Check | Proves | Command |\n|---|---|---|---|---|\n| U1 | automated | greet works | A1 | \`node -e "import('./greet.js').then(m=>process.exit(m.greet('Bo')==='Hello, Bo!'?0:1))"\` |\n| U2 | automated | export works | B1 | \`node -e "import('./index.js').then(m=>process.exit(typeof m.greet==='function'?0:1))"\` |\n${human ? '| H1 | human | read the greeting | A1 | |\n' : ''}`;
    assert.equal(j(await rootExec('jd_write_doc', { key: 'verificationPlan', content: vp })).ok, true);
    await rootExec('jd_parity', { key: 'verificationPlan', restatement: 'U1 U2 H1' });
    assert.ok(j(await rootExec('jd_advance', { to: 'specs' })).ok);
    await rootExec('jd_write_doc', { key: 'specs', content: '# Specs\n- **S1 greet.** greet.js exports greet [A1]\n- **S2 export.** index.js re-exports greet [B1]\n' });
    assert.ok(j(await rootExec('jd_advance', { to: 'implementation_plan' })).ok);
    await rootExec('jd_write_doc', { key: 'implementationPlan', content: '# Plan\n| Step | Work | Specs | Checks |\n|---|---|---|---|\n| P1 | greet | S1 | U1 |\n| P2 | export | S2 | U2 |\n' });
    assert.ok(j(await rootExec('jd_tree', { op: 'init' })).ok);
    const greetCheck = `node -e "import('./greet.js').then(m=>process.exit(m.greet('Al')==='Hello, Al!'?0:1))"`;
    const exportCheck = `node -e "import('./index.js').then(m=>process.exit(typeof m.greet==='function'?0:1))"`;
    const split = j(
      await rootExec('jd_tree', {
        op: 'split',
        nodeId: 'N',
        children: [
          { title: 'greet()', doneWhen: ['greet returns the greeting'], covers: ['N#A1'], traces: { requirements: ['A1'], checks: ['U1'] }, checks: [{ command: greetCheck, cwd: r1 }], provides: [{ name: 'greet', description: 'greet(name): string' }], risk: 'high' },
          { title: 'export', doneWhen: ['index.js exports greet'], covers: ['N#B1'], traces: { requirements: ['B1'], checks: ['U2'] }, checks: [{ command: exportCheck, cwd: r1 }], dependsOn: ['#1'], uses: ['C:N.1:greet'] },
        ],
      }),
    );
    assert.ok(split.ok, JSON.stringify(split));
    assert.ok(j(await rootExec('jd_advance', { to: 'preflight' })).ok, 'to preflight');
    const pf = j(await rootExec('jd_preflight', { items: [{ what: 'node works', command: 'node --version' }] }));
    assert.ok(pf.ok, JSON.stringify(pf));
    assert.ok(j(await rootExec('jd_advance', { to: 'final_parity' })).ok);
    const prep = j(await rootExec('jd_prepare'));
    assert.equal(prep.prepared.length, repoPaths.length);
    await rootExec('jd_parity', { key: 'final', restatement: 'everything' });
  }

  return { session, repoPaths, root, worker, calls, answers, scripts, rootExec, settleToFinal, ghLog, handle: () => hub.runs.get(hub.bySession.get(root.id)) };
}

/** Default scripted builders: write the code, then submit. */
function honestBuilders(w) {
  w.scripts['builder:N.1'] = async ({ exec, run }) => {
    fs.writeFileSync(path.join(run.state.settings.repos[0].workPath, 'greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
    await exec('jd_submit', { summary: 'greet added' });
  };
  w.scripts['builder:N.2'] = async ({ exec, run }) => {
    fs.writeFileSync(path.join(run.state.settings.repos[0].workPath, 'index.js'), "export { greet } from './greet.js';\n");
    await exec('jd_submit', { summary: 'export added' });
  };
}

async function runToEnd(w) {
  const out = await w.rootExec('jd_run');
  assert.match(out, /started/);
  await w.handle().loop;
  return w.handle().run;
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('T2 + T10: scripted full run on one repo, intake → done; PRD verbatim; questions only from root; commits on junior-dev/<feature>; report', async () => {
  const w = makeWorld();
  honestBuilders(w);
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
  assert.equal(fs.readFileSync(path.join(run.dir, 'prd.md'), 'utf8'), PRD_TEXT.trim(), 'PRD stored verbatim (the path inside is not read as the PRD)');
  const wt = run.state.settings.repos[0].workPath;
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), `junior-dev/${run.name}`);
  assert.match(git(wt, 'log', '--format=%s'), /jd\(N\.2\): export\njd\(N\.1\): greet\(\)/);
  assert.equal(git(w.repoPaths[0], 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'worktree mode leaves the developer checkout alone');
  const report = fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8');
  assert.match(report, /ending: \*\*done\*\*/);
  assert.match(report, /\| A1 \| U1 \| automated \| pass/);
  assert.match(report, /\| A1 \| H1 \| human \| pass/);
  assert.equal(w.calls.notify.length, 1);
  assert.match(w.calls.notify[0], /ended: done/);
  assert.ok(w.calls.spawns.every((s) => s.role !== 'ask'), 'workers never ask');
  assert.ok(run.state.history.some((h) => h.to === 'preflight' && h.ok) && run.state.history.findIndex((h) => h.to === 'preflight' && h.ok) < run.state.history.findIndex((h) => h.to === 'final_parity' && h.ok), 'preflight before final parity');
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.deepEqual(run.state.delivery.branches.map((b) => b.pushed), [false], 'no push permission: local branch');
  assert.equal(progressFor(w.root.id).phase, 'done');
  const reg = JSON.parse(fs.readFileSync(path.join(process.env.JD_HOME, 'active.json'), 'utf8'));
  assert.equal(reg[w.root.id], undefined, 'a finished run leaves the active list');
});

test('T3: a crash mid-build loses only the step in flight; invoking again resumes from the checkpoint', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  let crashed = false;
  const realN2 = w.scripts['builder:N.2'];
  w.scripts['builder:N.2'] = async (c) => {
    if (!crashed) {
      crashed = true;
      fs.writeFileSync(path.join(c.run.state.settings.repos[0].workPath, 'index.js'), 'half-written garbage');
      // simulate DSH dying mid-step: this worker never returns
      await new Promise(() => {});
    }
    return realN2(c);
  };
  await w.settleToFinal();
  await w.rootExec('jd_run');
  const name = w.handle().run.name;
  for (let i = 0; i < 500 && !(crashed && Run.open(w.session, name).state.tree.nodes['N.2'].status === 'working'); i++) await new Promise((r) => setTimeout(r, 20));
  // "restart": drop the in-memory hub, reopen from disk (the hung loop is abandoned like a dead process)
  hub.runs.clear();
  hub.bySession.clear();
  const reopened = Run.open(w.session, name);
  assert.equal(reopened.state.tree.nodes['N.1'].status, 'done', 'completed work survived');
  const status = JSON.parse(await w.rootExec('jd_status'));
  assert.equal(status.phase, 'build');
  assert.match(status.next, /not running.*jd_run/);
  const run = await runToEnd(w);
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
  assert.ok(run.state.notes.some((n) => n.kind === 'recovery'));
  assert.equal(fs.readFileSync(path.join(run.state.settings.repos[0].workPath, 'index.js'), 'utf8'), "export { greet } from './greet.js';\n");
});

test('T4 + T6: without push permission the gate blocks a worker push; workers cannot ask; the state dir is protected', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  const denials = [];
  w.scripts['builder:N.1'] = async ({ exec, run, h }) => {
    for (const call of [
      { name: 'bash', arguments: { command: `git push origin junior-dev/${run.name}` } },
      { name: 'ask_user_question', arguments: { questions: [] } },
      { name: 'bash', arguments: { command: `echo x >> ${path.join(run.dir, 'state', 'events.jsonl')}` } },
      { name: 'write', arguments: { path: path.join(run.dir, 'requirements.md'), content: 'x' } },
      { name: 'bash', arguments: { command: 'git fetch origin' } },
    ]) {
      denials.push(judge({ ...call, agent: w.worker }, h));
    }
    fs.writeFileSync(path.join(run.state.settings.repos[0].workPath, 'greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
    await exec('jd_submit', { summary: 'ok' });
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.match(denials[0].reason, /pushing was not permitted/);
  assert.match(denials[1].reason, /workers never ask/);
  assert.match(denials[2].reason, /state is written only by the plugin/);
  assert.match(denials[3].reason, /written with jd_write_doc/);
  assert.equal(denials[4], null, 'remote reads pass');
  assert.equal(run.state.phase, 'done');
  assert.equal(git(path.join(w.session, 'remote1.git'), 'branch', '--list').trim(), '', 'nothing reached the remote');
});

test('T5: with push + PR permission across two repos: two branches pushed, two PRs cross-linked, no doc files', async () => {
  const w = makeWorld({ repos: 2, push: true, pr: true, human: false });
  honestBuilders(w);
  const n1 = w.scripts['builder:N.1'];
  w.scripts['builder:N.1'] = async (c) => {
    fs.writeFileSync(path.join(c.run.state.settings.repos[1].workPath, 'NOTE.md'), 'greet lives in repo1\n');
    return n1(c);
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.equal(run.state.phase, 'done', `${run.state.sideReason ?? ''} ${JSON.stringify(run.state.blockers)}`);
  for (let i = 1; i <= 2; i++) {
    assert.match(git(path.join(w.session, `remote${i}.git`), 'branch', '--list'), new RegExp(`junior-dev/${run.name}`));
    const files = git(path.join(w.session, `remote${i}.git`), 'ls-tree', '-r', '--name-only', `junior-dev/${run.name}`);
    assert.doesNotMatch(files, /docs\//);
  }
  const gh = fs.readFileSync(w.ghLog, 'utf8');
  assert.equal((gh.match(/^pr create/gm) ?? []).length, 2);
  assert.equal((gh.match(/^pr edit/gm) ?? []).length, 2, 'cross-linked');
  assert.match(gh, /Related PRs: https:\/\/github.com\/example\/repo\/pull\/2/);
  assert.equal(run.state.delivery.prs.length, 2);
});

test('T7: cross-model verification runs in a fresh worker on the chosen model; findings go through the fix loop', async () => {
  const w = makeWorld({ crossModel: true, human: false });
  honestBuilders(w);
  let reviews = 0;
  w.scripts.reviewer = async () => (++reviews === 1 ? '{"findings":[{"requirement":"A1","problem":"no trailing newline handling","severity":"low"}]}' : '{"findings":[]}');
  w.scripts.fixer = async ({ exec }) => {
    await exec('jd_submit', { summary: 'addressed review' });
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  const rev = w.calls.spawns.filter((s) => s.role === 'reviewer');
  assert.equal(rev.length, 2);
  assert.deepEqual(rev[0].model, { provider: 'other', model: 'x' });
  assert.ok(w.calls.spawns.some((s) => s.role === 'fixer' && s.checkId === 'RV1'));
  assert.ok(run.state.notes.some((n) => n.kind === 'review_done'));
  assert.equal(run.state.phase, 'done');
});

test('v2-05: review runs without cross-model, on the checker model, once per repo', async () => {
  const w = makeWorld({ repos: 2, human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const run = await runToEnd(w);
  const rev = w.calls.spawns.filter((s) => s.role === 'reviewer');
  assert.equal(rev.length, 2);
  assert.deepEqual(rev[0].model, { provider: 'fake', model: 'm1' });
  assert.equal(run.state.phase, 'done');
});

test('v2-05: both axes are reported separately in the report and the PR body', async () => {
  const w = makeWorld({ human: false, push: true, pr: true });
  honestBuilders(w);
  w.scripts.reviewer = async () => '{"findings":[{"axis":"standards","problem":"swallowed error","where":"greet.js:1","severity":"low"},{"axis":"spec","kind":"scope creep","requirement":"A1","problem":"added a shout() helper","severity":"low"}]}';
  await w.settleToFinal();
  const run = await runToEnd(w);
  const report = fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8');
  assert.match(report, /### Standards\n- repo1: \(low\) swallowed error/);
  assert.match(report, /### Spec\n- repo1: \(low, scope creep\) added a shout\(\) helper/);
  assert.ok(report.indexOf('### Standards') < report.indexOf('### Spec'));
  const gh = fs.readFileSync(w.ghLog, 'utf8');
  assert.match(gh, /### Standards/);
  assert.match(gh, /### Spec/);
});

test('v2-05: a standards finding is routed to the fix loop; the reviewer brief lists the standards files', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  fs.writeFileSync(path.join(w.repoPaths[0], 'CLAUDE.md'), '# rules\n');
  git(w.repoPaths[0], 'add', 'CLAUDE.md');
  git(w.repoPaths[0], 'commit', '-q', '-m', 'add rules');
  let reviews = 0;
  const briefs = [];
  w.scripts.reviewer = async ({ prompt }) => {
    briefs.push(prompt);
    return ++reviews === 1 ? '{"findings":[{"axis":"standards","problem":"breaks the naming rule","severity":"med"}]}' : '{"findings":[]}';
  };
  w.scripts.fixer = async ({ exec }) => exec('jd_submit', { summary: 'renamed' });
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.ok(w.calls.spawns.some((s) => s.role === 'fixer' && s.checkId === 'RV1'));
  assert.equal(reviews, 2);
  assert.match(briefs[0], /standards files[^\n]*CLAUDE\.md/);
  assert.equal(run.state.notes.filter((n) => n.kind === 'review_standards').length, 0);
  assert.equal(run.state.phase, 'done');
});

test('v2-05: scope creep is reported, not fixed, and does not block delivery', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  w.scripts.reviewer = async () => '{"findings":[{"axis":"spec","kind":"scope creep","problem":"unrequested logging","severity":"low"}]}';
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.ok(!w.calls.spawns.some((s) => s.role === 'fixer'));
  assert.equal(run.state.notes.filter((n) => n.kind === 'review_spec').length, 1);
  assert.equal(run.state.blockers.length, 0);
  assert.equal(run.state.phase, 'done');
});

test('T8: hand checks come as one checklist; a failure goes through the fix loop and is not re-presented', async () => {
  const w = makeWorld();
  honestBuilders(w);
  w.answers.human = () => 'Fail';
  w.scripts.fixer = async ({ exec }) => exec('jd_submit', { summary: 'made the button blue' });
  await w.settleToFinal();
  const run = await runToEnd(w);
  const humanAsks = w.calls.asks.filter((ids) => ids.some((id) => id.startsWith('HC:')));
  assert.equal(humanAsks.length, 1, 'presented once');
  assert.ok(w.calls.spawns.some((s) => s.role === 'fixer' && s.checkId === 'H1'));
  assert.ok(run.state.notes.some((n) => n.kind === 'human_fix' && /a fix was committed and every automated check still passes \(not re-checked by hand\)/.test(n.text)));
  assert.equal(run.state.phase, 'done');
});

test('T9: an unfixable item is logged as a blocker and skipped; the rest is delivered; the report lists it', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  w.scripts['builder:N.2'] = async ({ exec }) => {
    await exec('jd_block', { what: 'index.js is generated by a tool we cannot run', why: 'codegen binary missing', how: 'tried to edit index.js', fixes: ['install the codegen tool'] });
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.equal(run.state.tree.nodes['N.2'].status, 'blocked');
  assert.equal(run.state.tree.nodes['N.1'].status, 'done');
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
  const report = fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8');
  assert.match(report, /index.js is generated by a tool we cannot run/);
  assert.match(report, /\| B1 \| U2 \| automated \| FAIL/, report);
  assert.match(report, /ending: \*\*done, with blockers\*\*/);
});

test('T11: a contract change mid-build sends the dependent done item to recheck, and it re-runs', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const h = w.handle();
  let changed = null;
  h.run.store.onCommit((ev, st) => {
    if (changed || ev.type !== 'tree' || st.tree.nodes['N.2']?.status !== 'done') return;
    changed = 'pending';
    queueMicrotask(async () => {
      h.worker = { id: 'Wx', nodeId: 'N.1' };
      hub.byWorker.set(w.worker.id, h.key);
      changed = JSON.parse(await T.jd_contract.execute({ contractId: 'C:N.1:greet', description: 'greet(name, punct = "!")' }, { agent: w.worker, signal: sig() }));
      h.worker = null;
    });
  });
  const run = await runToEnd(w);
  assert.deepEqual(changed.recheck.sort(), ['N', 'N.2']);
  assert.equal(run.state.tree.nodes['N.2'].status, 'done');
  assert.ok(run.state.tree.nodes['N.2'].evidence.length >= 2, 'N.2 checks ran again');
  assert.equal(run.state.phase, 'done');
});

test('U17/H1 live: jd_pause during the loop pauses at the next checkpoint and notifies; resettle + jd_run continues', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  const n1 = w.scripts['builder:N.1'];
  w.scripts['builder:N.1'] = async (c) => {
    await w.rootExec('jd_pause', { reason: 'developer wants greet to trim' });
    return n1(c);
  };
  await w.settleToFinal();
  await w.rootExec('jd_run');
  await w.handle().loop;
  const run = w.handle().run;
  assert.equal(run.state.side, 'paused');
  assert.equal(run.state.tree.nodes['N.1'].status, 'done', 'the step in flight finished first');
  assert.match(w.calls.notify.at(-1), /Paused at a checkpoint/);
  await assert.rejects(w.rootExec('jd_run'), /paused/);
  assert.equal(JSON.parse(await w.rootExec('jd_resettle', { target: 'build' })).phase, 'build', 'nothing changed, so the run continues in build');
  const done = await runToEnd(w);
  assert.equal(done.state.phase, 'done');
});

test('budget: reaching the token limit stops the run with a report; raising it and jd_run resumes', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  w.handle().run.set('budget', { tokens: 1500 });
  const run = await runToEnd(w);
  assert.equal(run.state.side, 'stopped');
  assert.match(run.state.sideReason, /budget reached: tokens/);
  assert.match(w.calls.notify.at(-1), /ended: stopped/);
  await w.rootExec('jd_set', { key: 'budget', value: { tokens: 1e7 } });
  const done = await runToEnd(w);
  assert.equal(done.state.phase, 'done');
});

test('stuck batch: a parked item asks its question once nothing else runs, then continues', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  let first = true;
  const n1 = w.scripts['builder:N.1'];
  w.scripts['builder:N.1'] = async (c) => {
    if (first) {
      first = false;
      const r = JSON.parse(await c.exec('jd_decide', { what: 'greeting punctuation', options: ['!', '.'], choice: '!', why: 'PRD says !', question: 'Exclamation mark or full stop?', change: { touchesDocs: true } }));
      assert.equal(r.outcome, 'park');
      return;
    }
    return n1(c);
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.ok(w.calls.asks.some((ids) => ids.includes('QQ:QQ1')));
  assert.equal(run.state.phase, 'done');
  assert.equal(run.state.ledger[0].outcome, 'park');
  assert.equal(run.openQueue().length, 0);
});

test('jd_* root tools refuse workers, and worker tools refuse the root', async () => {
  const w = makeWorld();
  await assert.rejects(T.jd_status.execute({}, { agent: w.worker, signal: sig() }), /developer-facing agent only/);
  await assert.rejects(T.jd_submit.execute({ summary: 'x' }, { agent: w.root, signal: sig() }), /workers only/);
  await assert.rejects(w.rootExec('jd_run'), /No junior-dev run/);
  hub.overrides = null;
});

test('real-DSH regressions: the ask payload is lossless JSON; the PRD is the developer message, not injected context', () => {
  const p = toAskPayload([{ id: 'Q1', question: 'x?', header: 'a very long header', detail: undefined, options: [{ label: 'A', description: undefined }, { label: 'B (Recommended)' }], multiSelect: false }]);
  assert.deepEqual(p, [{ id: 'Q1', question: 'x?', header: 'a very long ', options: [{ label: 'A' }, { label: 'B (Recommended)' }] }]);
  assert.equal(JSON.stringify(p).includes('undefined'), false);
  const agent = { session: { deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '# PRD\nBuild greet.' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context: this snapshot ...' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] },
  ] } };
  assert.equal(latestUserText(agent), '# PRD\nBuild greet.');
});

// ---------------------------------------------------------------- review regressions (X1)

test('X1#4: a crash after a commit but before its checks were recorded rolls back to the recorded base', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const run = w.handle().run;
  // simulate: worker started (bases recorded), claimed, then an unproven commit, then the process died
  run.advance('build');
  const wt = run.state.settings.repos[0].workPath;
  const base = git(wt, 'rev-parse', 'HEAD');
  const wid = run.workerStart({ role: 'builder', nodeId: 'N.1', bases: { [wt]: base } });
  run.tree('claim', 'N.1', wid);
  fs.writeFileSync(path.join(wt, 'greet.js'), 'export const greet = () => "unproven";\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'unproven');
  const done = await runToEnd(w);
  assert.equal(done.state.phase, 'done', done.state.sideReason ?? '');
  assert.doesNotMatch(git(wt, 'log', '--format=%s'), /unproven/);
  assert.ok(done.state.notes.some((n) => n.kind === 'recovery'));
});

test('X1#11/#12: a fix that does not fix, or breaks another check, is rolled back and logged; nothing silent', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  // N.2 "passes" its own check but U2 needs greet exported AND the fixers only break things
  w.scripts.fixer = async ({ exec, run }) => {
    fs.writeFileSync(path.join(run.state.settings.repos[0].workPath, 'greet.js'), 'export const greet = () => "broken";\n');
    await exec('jd_submit', { summary: 'tried' });
  };
  await w.settleToFinal();
  // make U2 impossible: its command checks a symbol nobody provides
  w.handle().run.store.commit('check_def', { ...w.handle().run.state.checks.U2, command: `node -e "import('./index.js').then(m=>process.exit(m.nope?0:1))"` });
  w.handle().run.parity('final', true);
  const run = await runToEnd(w);
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
  const wt = run.state.settings.repos[0].workPath;
  assert.equal(fs.readFileSync(path.join(wt, 'greet.js'), 'utf8'), 'export const greet = (n) => `Hello, ${n}!`;\n', 'breaking fixes were rolled back');
  assert.doesNotMatch(git(wt, 'log', '--format=%s'), /jd\(fix/);
  assert.ok(run.state.blockers.some((b) => b.checkId === 'U2'));
  assert.equal(run.state.checks.U1.results.at(-1).ok, true);
});

test('X1#10: a pause requested during verification pauses there (not silently skipped)', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  let asked = false;
  w.scripts.fixer = async ({ exec }) => {
    if (!asked) {
      asked = true;
      await w.rootExec('jd_pause', { reason: 'change during verify' });
    }
    await exec('jd_submit', { summary: 'noop' });
  };
  await w.settleToFinal();
  w.handle().run.store.commit('check_def', { ...w.handle().run.state.checks.U2, command: 'false' });
  w.handle().run.parity('final', true);
  await w.rootExec('jd_run');
  await w.handle().loop;
  const run = w.handle().run;
  assert.equal(run.state.side, 'paused');
  assert.equal(run.state.phase, 'verify');
  assert.match(w.calls.notify.at(-1), /Paused at a checkpoint/);
});

test('X1#3/#16: resume while the loop runs reuses the same store; after a restart the gate re-attaches from the registry', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const h = w.handle();
  const store = h.run.store;
  const res = JSON.parse(await w.rootExec('jd_resume', { name: h.run.name }));
  assert.equal(res.resumed, h.run.name);
  assert.equal(w.handle().run.store, store, 'no second writer');
  // restart: in-memory hub gone; the first gated call of that session re-attaches
  hub.runs.clear();
  hub.bySession.clear();
  const d = judge({ name: 'bash', arguments: { command: 'git push origin main' }, agent: w.root });
  assert.equal(d?.kind, 'deny', 'gate active right after a restart');
});

test('X1#8/#14/#15: jd_run before prepare is refused without blocking; no single questions after final parity; only the assigned worker acts', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const run = w.handle().run;
  // an unprepared run: drop the workspace and re-give the final yes
  run.set('repos', run.state.settings.repos.map(({ workPath, branch, ...r }) => r));
  run.parity('final', true);
  await assert.rejects(w.rootExec('jd_run'), /cannot start the build/);
  assert.equal(run.state.side, null, 'not blocked: the developer can prepare and retry');
  await w.rootExec('jd_prepare');
  await w.rootExec('jd_parity', { key: 'final', restatement: 'again' });
  w.scripts['builder:N.1'] = async ({ exec, h, run: r }) => {
    const other = { id: 'OTHER', session: { header: { cwd: w.session, delegationDepth: 1, origin: 'subagent' } } };
    hub.byWorker.set('OTHER', h.key);
    await assert.rejects(T.jd_submit.execute({ summary: 'x' }, { agent: other, signal: sig() }), /Only the worker assigned/);
    fs.writeFileSync(path.join(r.state.settings.repos[0].workPath, 'greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
    await exec('jd_submit', { summary: 'ok' });
  };
  const done = await runToEnd(w);
  assert.equal(done.state.phase, 'done', done.state.sideReason ?? '');
  await assert.rejects(w.rootExec('jd_ask', { question: 'late?' }), /No single questions after the final parity|already|done/);
});

test('spending guard: subscription models need the no-extra-credits guardrail; paid models need an explicit yes', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  hub.overrides.subscriptionSettings = () => ({ providers: ['fake'], subscriptionOnly: false, cascadingFallback: false });
  await assert.rejects(w.settleToFinal(), /preflight|ok/);
  const run = w.handle().run;
  const spend = run.state.preflight.find((p) => p.id === 'spend:planner');
  assert.equal(spend.ok, false);
  assert.match(spend.detail, /Subscription only/);
  hub.overrides.subscriptionSettings = () => ({ providers: [], subscriptionOnly: true, cascadingFallback: false });
  const r = JSON.parse(await w.rootExec('jd_preflight', { items: [] }));
  assert.equal(r.ok, false, 'a non-subscription (pay-per-token) model is refused without permission');
  assert.match(r.results.find((x) => x.id === 'spend:builder').detail, /bills per token/);
  hub.overrides.subscriptionSettings = () => ({ providers: ['fake'], subscriptionOnly: true, cascadingFallback: false });
  assert.equal(JSON.parse(await w.rootExec('jd_preflight', { items: [] })).ok, true);
});

test('spending guard: "out of subscription" stops the run at once, undoes the attempt, and jd_run resumes later', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  let exhausted = true;
  const n1 = w.scripts['builder:N.1'];
  w.scripts['builder:N.1'] = async (c) => {
    if (exhausted) {
      fs.writeFileSync(path.join(c.run.state.settings.repos[0].workPath, 'partial.js'), 'x');
      throw new Error('no usable subscription account for this provider');
    }
    return n1(c);
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.equal(run.state.side, 'stopped');
  assert.match(run.state.sideReason, /subscription limit reached — no extra credits were used/);
  assert.equal(run.state.tree.nodes['N.1'].attempts, 0, 'not counted as a failed attempt');
  assert.equal(w.calls.spawns.filter((s) => s.role === 'builder').length, 1, 'no retries against an exhausted subscription');
  assert.equal(fs.existsSync(path.join(run.state.settings.repos[0].workPath, 'partial.js')), false);
  exhausted = false;
  const done = await runToEnd(w);
  assert.equal(done.state.phase, 'done', done.state.sideReason ?? '');
});

test('R1 finding: jd_set and jd_tree accept JSON text as well as objects', async () => {
  const w = makeWorld({ human: false });
  await w.rootExec('jd_start');
  await w.rootExec('jd_set', { key: 'budget', value: '{"timeMin":30,"tokens":1500000}' });
  await w.rootExec('jd_set', { key: 'dial', value: 'balanced' });
  const st = w.handle().run.state.settings;
  assert.deepEqual(st.budget, { timeMin: 30, tokens: 1500000 });
  assert.equal(st.dial, 'balanced');
});

test('R1 finding: a fixer that logs a blocker ends the fix loop for that check (no wasted rounds)', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  w.scripts.fixer = async ({ exec }) => exec('jd_block', { what: 'check command is broken', why: 'unfixable from code', how: 'ran it' });
  await w.settleToFinal();
  w.handle().run.store.commit('check_def', { ...w.handle().run.state.checks.U2, command: 'false' });
  w.handle().run.parity('final', true);
  const run = await runToEnd(w);
  assert.equal(w.calls.spawns.filter((s) => s.role === 'fixer' && s.checkId === 'U2').length, 1);
  assert.equal(run.state.blockers.filter((b) => b.checkId === 'U2').length, 1);
  assert.equal(run.state.phase, 'done');
});

test('U9/J4 (iOS research): the gate holds iOS uploads without permission and refuses Xcode MCP writes into the state dir or docs', () => {
  const session = tmpdir('jd-session-');
  const run = Run.create({ sessionFolder: session, prdText: PRD_TEXT });
  const h = { run };
  const agent = { id: 'W-ios', session: { header: { cwd: session, delegationDepth: 1, origin: 'subagent' } } };
  const judgeAs = (name, args) => judge({ name, arguments: args, agent }, h);
  const stateDir = path.join(run.dir, 'state');
  const rel = path.relative(session, run.dir);
  const uploads = ['xcrun altool --upload-app -f App.ipa -t ios', 'xcrun notarytool submit App.zip --wait', 'bundle exec fastlane beta', 'xcodebuild -exportArchive -archivePath a.xcarchive -exportOptionsPlist e.plist', 'xcrun iTMSTransporter -m upload -assetFile a.ipa'];

  run.set('permissions', { push: false, pr: false, remoteWrites: [], debugEnv: null });
  for (const command of uploads) assert.match(judgeAs('bash', { command })?.reason ?? '', /was not permitted in the interview/, command);
  assert.equal(judgeAs('bash', { command: 'xcodebuild -scheme App test' }), null, 'local builds pass');
  assert.equal(judgeAs('mcp__xcode__UpdateTargetBuildSetting', { tabIdentifier: 'w1', targetName: 'App', buildSettingName: 'SWIFT_VERSION', buildSettingValue: '6.0' }), null, 'a local project setting');

  const stateWrites = [
    ['mcp__xcode__XcodeWrite', { tabIdentifier: 'w1', filePath: path.join(stateDir, 'events.jsonl'), content: '{}' }],
    ['mcp__xcode__XcodeWrite', { tabIdentifier: 'w1', filePath: `Project/${rel}/state/snapshot.json`, content: '{}' }],
    ['mcp__xcode__XcodeUpdate', { filePath: path.relative(session, path.join(stateDir, 'snapshot.json')), oldString: 'a', newString: 'b' }],
    ['mcp__xcode__XcodeRM', { path: `${run.name}/state`, recursive: true }],
    ['mcp__xc__XcodeMV', { sourcePath: 'App/x.json', destinationPath: stateDir }],
    ['mcp__xcode__XcodeMakeDir', { directoryPath: path.join(stateDir, 'x') }],
    ['mcp__xcode__XcodeInsertFile', { sourceFilePath: path.join(stateDir, 'events.jsonl'), targetPath: 'App' }],
    ['mcp__xcode__XcodeMessageSend', { message: 'file.write', params: JSON.stringify({ path: path.join(stateDir, 'events.jsonl') }) }],
  ];
  for (const [name, args] of stateWrites) assert.match(judgeAs(name, args)?.reason ?? '', /state is written only by the plugin/, `${name} ${JSON.stringify(args)}`);
  assert.match(judgeAs('mcp__xcode__XcodeWrite', { filePath: path.join(run.dir, 'requirements.md'), content: 'x' })?.reason ?? '', /written with jd_write_doc/);
  assert.match(judgeAs('mcp__xcode__XcodeUpdate', { filePath: `Project/${rel}/specs.md`, oldString: 'a', newString: 'b' })?.reason ?? '', /written with jd_write_doc/);
  assert.equal(judgeAs('mcp__xcode__XcodeWrite', { filePath: 'App/Sources/Greet.swift', content: 'let file = "snapshot.json"\n' }), null, 'ordinary project files pass');
  assert.equal(judgeAs('mcp__xcode__XcodeRead', { filePath: path.join(stateDir, 'snapshot.json') }), null, 'reads pass');

  run.set('permissions', { push: false, pr: false, remoteWrites: ['altool-upload', 'notarytool-submit', 'fastlane', 'xcodebuild-export', 'transporter'], debugEnv: null });
  for (const command of uploads) assert.equal(judgeAs('bash', { command }), null, `permitted: ${command}`);
  assert.match(judgeAs('mcp__xcode__XcodeWrite', { filePath: path.join(stateDir, 'events.jsonl'), content: '{}' })?.reason ?? '', /state is written only by the plugin/, 'no permission opens the state dir');
});

test('v2-02: every brief carries its role\'s practice skill, and no skill tells a worker to ask the user', async () => {
  const { workerBrief, fixBrief, reviewBrief, SKILL_TEXT } = await import('../lib/host/prompts.js');
  const run = { name: 'feat', dir: '/tmp/feat-docs' };
  const node = { id: 'N.1', title: 't', goal: 'g', doneWhen: [{ id: 'N.1#1', text: 'works' }], traces: { requirements: ['A1'] }, checks: [], provides: [], uses: [] };
  const base = { node, run, contracts: [], workPaths: ['/tmp/repo'] };
  const brief = {
    planner: workerBrief({ ...base, role: 'planner' }),
    builder: workerBrief({ ...base, role: 'builder' }),
    fixer: fixBrief({ run, check: { id: 'U1', kind: 'automated', requirementIds: ['A1'] }, output: 'boom', workPaths: ['/tmp/repo'] }),
    reviewer: reviewBrief({ run, workPaths: ['/tmp/repo'], diffStat: 'a.js' }),
  };
  const expected = { planner: ['slicing'], builder: ['red-first-building', 'test-quality'], fixer: ['debugging'], reviewer: ['review-axes'] };
  for (const [role, names] of Object.entries(expected)) {
    for (const n of names) assert.ok(brief[role].includes(SKILL_TEXT[n]), `${role} brief contains ${n}`);
    for (const n of Object.keys(SKILL_TEXT)) if (!names.includes(n)) assert.ok(!brief[role].includes(SKILL_TEXT[n]), `${role} brief omits ${n}`);
  }
  const dir = path.join(import.meta.dirname, '..', 'skills');
  const names = fs.readdirSync(dir);
  assert.deepEqual(names.sort(), Object.keys(SKILL_TEXT).sort());
  for (const n of names) {
    const raw = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw)?.[1] ?? '';
    assert.match(fm, new RegExp(`^name: ${n}$`, 'm'));
    assert.match(n, /^[a-z]+(-[a-z]+)*$/);
    assert.match(fm, /^description: \S/m);
    assert.doesNotMatch(raw.replace(/(cannot|never) ask/gi, ""), /ask[_ ](the )?(user|developer|human)|ask_user_question|quiz the user/i, `${n} never tells a worker to ask`);
  }
  assert.ok(fs.existsSync(path.join(dir, '..', 'CREDITS.md')));
});
