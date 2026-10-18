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
import { renderReport } from '../lib/engine/report.js';
import { tmpdir, gitRepo } from './helpers.js';

process.env.JD_WORKTREES_ROOT = tmpdir('jd-wt-');
process.env.JD_HOME = tmpdir('jd-home-');
process.env.JD_RETRY_ASK_MS = '10';

const T = Object.fromEntries([...rootTools, ...workerTools].map((t) => [t.name, t]));
const sig = () => new AbortController().signal;

const PRD_TEXT = `# Greeting helper\n\nAdd greet(name) returning "Hello, <name>!" and export it from index.js. See /tmp/notes.md for background.\n`;

function makeWorld({ repos = 1, push = false, pr = false, crossModel = false, human = true, repoFiles = () => ({}), plan = null } = {}) {
  const session = tmpdir('jd-session-');
  const binDir = path.join(session, '.bin');
  fs.mkdirSync(binDir);
  const ghLog = path.join(session, 'gh.log');
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\necho "$@" >> "${ghLog}"\nif [ "$1" = "pr" ] && [ "$2" = "create" ]; then n=$(grep -c "^pr create" "${ghLog}"); echo "https://github.com/example/repo/pull/$n"; fi\n`, { mode: 0o755 });
  // fake npm for workspace setup (v2-13): logs its args, "installs" by creating node_modules; fails while npm-fail exists
  const npmLog = path.join(session, 'npm.log');
  fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\necho "$PWD $@" >> "${npmLog}"\nif [ -e "${path.join(session, 'npm-fail')}" ]; then echo "npm ERR! network unreachable" >&2; exit 1; fi\nmkdir -p node_modules\n`, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH.split(':').filter((p) => !p.includes('jd-session-')).join(':')}`;
  const repoPaths = [];
  for (let i = 0; i < repos; i++) {
    const repo = path.join(session, `repo${i + 1}`);
    gitRepo(repo, { 'package.json': '{"type":"module"}\n', 'index.js': 'export {};\n', ...repoFiles(i) });
    const bare = path.join(session, `remote${i + 1}.git`);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    repoPaths.push(repo);
  }
  const root = { id: `ROOT-${path.basename(session)}`, session: { header: { cwd: session }, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: PRD_TEXT }] }] } };
  const worker = { id: `W-${path.basename(session)}`, session: { header: { cwd: session, delegationDepth: 1, origin: 'subagent', parentSession: root.id } } };
  const calls = { asks: [], notify: [], spawns: [] };
  const answers = { human: () => 'Pass', queued: () => null };
  const scripts = { reviewer: async () => '{"findings":[]}' }; // role or nodeId → async (ctx) => void
  hub.host = { logger: () => console };
  hub.overrides = {
    async ask(_h, questions) {
      calls.asks.push(questions.map((q) => q.id));
      return questions.map((q) => {
        if (q.id.startsWith('HC:')) return { id: q.id, selected: [answers.human(q)], custom: answers.human(q) === 'Fail' ? 'button is red' : null };
        if (q.id.startsWith('QQ:') && answers.queued(q)) return { id: q.id, selected: [answers.queued(q)], custom: null };
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
    const P = plan?.(repoPaths);
    const vpRows = P?.vpRows ?? `| U1 | automated | greet works | A1 | \`node -e "import('./greet.js').then(m=>process.exit(m.greet('Bo')==='Hello, Bo!'?0:1))"\` |\n| U2 | automated | export works | B1 | \`node -e "import('./index.js').then(m=>process.exit(typeof m.greet==='function'?0:1))"\` |\n`;
    const vp = `# VP\n## Highlights\n### What gets built\n- checks\n### What doesn't\n- none\n### Decisions & assumptions\n- none\n### What needs you\n- H1\n## Checks\n| ID | Kind | Check | Proves | Command |\n|---|---|---|---|---|\n${vpRows}${human ? '| H1 | human | read the greeting | A1 | |\n' : ''}`;
    assert.equal(j(await rootExec('jd_write_doc', { key: 'verificationPlan', content: vp })).ok, true);
    await rootExec('jd_parity', { key: 'verificationPlan', restatement: 'U1 U2 H1' });
    assert.ok(j(await rootExec('jd_advance', { to: 'specs' })).ok);
    await rootExec('jd_write_doc', { key: 'specs', content: '# Specs\n- **S1 greet.** greet.js exports greet [A1]\n- **S2 export.** index.js re-exports greet [B1]\n' });
    assert.ok(j(await rootExec('jd_advance', { to: 'implementation_plan' })).ok);
    await rootExec('jd_write_doc', { key: 'implementationPlan', content: '# Plan\n| Step | Work | Specs | Checks |\n|---|---|---|---|\n| P1 | greet | S1 | U1 |\n| P2 | export | S2 | U2 |\n' + (P?.ipExtra ?? '') });
    assert.ok(j(await rootExec('jd_tree', { op: 'init' })).ok);
    const greetCheck = `node -e "import('./greet.js').then(m=>process.exit(m.greet('Al')==='Hello, Al!'?0:1))"`;
    const exportCheck = `node -e "import('./index.js').then(m=>process.exit(typeof m.greet==='function'?0:1))"`;
    const split = j(
      await rootExec('jd_tree', {
        op: 'split',
        nodeId: 'N',
        children: P?.leaves ?? [
          { title: 'greet()', doneWhen: ['greet returns the greeting'], covers: ['N#A1'], traces: { requirements: ['A1'], checks: ['U1'] }, kind: 'behaviour', checks: [{ command: greetCheck, cwd: r1 }], provides: [{ name: 'greet', description: 'greet(name): string' }], risk: 'high' },
          { title: 'export', doneWhen: ['index.js exports greet'], covers: ['N#B1'], traces: { requirements: ['B1'], checks: ['U2'] }, kind: 'behaviour', checks: [{ command: exportCheck, cwd: r1 }], dependsOn: ['#1'], uses: ['C:N.1:greet'] },
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

  return { session, repoPaths, root, worker, calls, answers, scripts, rootExec, settleToFinal, ghLog, npmLog, handle: () => hub.runs.get(hub.bySession.get(root.id)) };
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

const GREET_CHECK = `node -e "import('./greet.js').then(m=>process.exit(m.greet('Al')==='Hello, Al!'?0:1))"`;
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
      { name: 'subagent', arguments: { prompt: 'do it for me' } },
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
  assert.match(denials[5].reason, /workers work alone/, 'DSH cannot filter subagent out of a child, so the gate denies it');
  assert.equal(judge({ name: 'subagent', arguments: {}, agent: w.root }, w.handle()), null, 'the root agent may still delegate');
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

test('v2-06: the PR body has the risk call and review findings but never the suggestions; the report ends with them', async () => {
  const w = makeWorld({ human: false, push: true, pr: true });
  honestBuilders(w);
  w.scripts.reviewer = async () => '{"findings":[{"axis":"standards","problem":"swallowed error","severity":"low"}],"suggestions":["no typecheck script"]}';
  await w.settleToFinal();
  const run = await runToEnd(w);
  const report = fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8');
  assert.match(report, /## Risk\n(Low|Medium): /);
  assert.match(report, /## Suggestions for your repo\n[^\n]*\n- repo1: no typecheck script\n$/);
  const gh = fs.readFileSync(w.ghLog, 'utf8');
  assert.match(gh, /## Risk/);
  assert.match(gh, /swallowed error/);
  assert.doesNotMatch(gh, /typecheck|Suggestions/);
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
  // R2 finding: plain strings sent as JSON text ("\"bold\"") are unwrapped too
  await w.rootExec('jd_set', { key: 'dial', value: '"bold"' });
  assert.equal(w.handle().run.state.settings.dial, 'bold');
  assert.match(await w.rootExec('jd_set', { key: 'name', value: '"discount-codes"' }), /renamed to discount-codes/);
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
  const rootAgent = { id: 'R-ios', session: { header: { cwd: session } } }; // workers may not use Xcode MCP at all (v2-12); the root agent still may
  const judgeRoot = (name, args) => judge({ name, arguments: args, agent: rootAgent }, h);
  const stateDir = path.join(run.dir, 'state');
  const rel = path.relative(session, run.dir);
  const uploads = ['xcrun altool --upload-app -f App.ipa -t ios', 'xcrun notarytool submit App.zip --wait', 'bundle exec fastlane beta', 'xcodebuild -exportArchive -archivePath a.xcarchive -exportOptionsPlist e.plist', 'xcrun iTMSTransporter -m upload -assetFile a.ipa'];

  run.set('permissions', { push: false, pr: false, remoteWrites: [], debugEnv: null });
  for (const command of uploads) assert.match(judgeAs('bash', { command })?.reason ?? '', /was not permitted in the interview/, command);
  assert.equal(judgeAs('bash', { command: 'xcodebuild -scheme App test' }), null, 'local builds pass');
  assert.equal(judgeRoot('mcp__xcode__UpdateTargetBuildSetting', { tabIdentifier: 'w1', targetName: 'App', buildSettingName: 'SWIFT_VERSION', buildSettingValue: '6.0' }), null, 'a local project setting');

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
  assert.equal(judgeRoot('mcp__xcode__XcodeWrite', { filePath: 'App/Sources/Greet.swift', content: 'let file = "snapshot.json"\n' }), null, 'ordinary project files pass');
  assert.equal(judgeRoot('mcp__xcode__XcodeRead', { filePath: path.join(stateDir, 'snapshot.json') }), null, 'reads pass');

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

test('v2-07: briefs point workers at the repo glossary when it has one, and the protocol covers design-tree order and domain docs', async () => {
  const { workerBrief, fixBrief, reviewBrief, PROTOCOL } = await import('../lib/host/prompts.js');
  const withDoc = tmpdir('jd-gloss-');
  const without = tmpdir('jd-nogloss-');
  const big = tmpdir('jd-biggloss-');
  fs.writeFileSync(path.join(withDoc, 'GLOSSARY.md'), '# g\n\n**Ledger entry**: one booked movement of money.\n');
  fs.writeFileSync(path.join(big, 'CONTEXT.md'), `# c\n${'term\n'.repeat(2000)}`);
  const run = { name: 'feat', dir: '/tmp/feat-docs' };
  const node = { id: 'N.1', title: 't', goal: 'g', doneWhen: [{ id: 'N.1#1', text: 'works' }], traces: { requirements: ['A1'] }, checks: [], provides: [], uses: [] };
  const check = { id: 'U1', kind: 'automated', requirementIds: ['A1'] };
  const briefs = (wp) => [
    workerBrief({ node, run, contracts: [], workPaths: wp, role: 'builder' }),
    fixBrief({ run, check, output: 'boom', workPaths: wp }),
    reviewBrief({ run, workPaths: wp, diffStat: 'a.js' }),
  ];
  for (const b of briefs([withDoc])) {
    assert.ok(b.includes(path.join(withDoc, 'GLOSSARY.md')), 'brief names the glossary file');
    assert.match(b, /use these terms/);
    assert.match(b, /Ledger entry/, 'a small glossary is included');
  }
  for (const b of briefs([without])) assert.doesNotMatch(b, /GLOSSARY|CONTEXT\.md|keeps a glossary/, 'no glossary, no pointer');
  for (const b of briefs([big])) {
    assert.ok(b.includes(path.join(big, 'CONTEXT.md')));
    assert.doesNotMatch(b, /term\nterm\nterm/, 'a large file is only pointed to');
  }
  assert.match(PROTOCOL, /design-tree order/);
  assert.match(PROTOCOL, /GLOSSARY\.md.*CONTEXT\.md.*adr/s);
  assert.match(PROTOCOL, /never create them/);
});

/** Replace fields of a leaf directly in the store (test setup only). */
function setLeaf(run, id, patch) {
  run.store.commit('tree', { op: 'test', patch: { nodes: { [id]: { ...run.state.tree.nodes[id], ...patch } } }, affected: [id] });
}

test('v2-03: an already-green behaviour leaf goes back to the planner once, then parks with a queued question', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  setLeaf(w.handle().run, 'N.1', { checks: [{ id: 'N.1/k1', command: 'true', cwd: null }] });
  const order = [];
  const n1 = w.scripts['builder:N.1'];
  w.scripts['planner:N.1'] = async ({ exec }) => {
    order.push('planner');
    if (order.length === 2) await exec('jd_set_checks', { checks: [{ command: GREET_CHECK, cwd: w.repoPaths[0] }] }); // the developer's answer sent it back
  };
  w.scripts['builder:N.1'] = async (c) => {
    order.push(`builder(queue=${c.run.state.queue.length})`);
    return n1(c);
  };
  const run = await runToEnd(w);
  assert.equal(w.calls.spawns.filter((s) => s.role === 'planner' && s.nodeId === 'N.1').length, 2, 'replanned once, then again after the answer');
  const ev = run.state.leafEvidence['N.1'];
  assert.equal(ev.replans, 1, 'the answer gave a fresh replan');
  assert.equal(ev.parks, 1);
  assert.deepEqual(run.state.queue[0].options, ['Rewrite the check', 'Check is fine, already done', 'Drop the leaf']);
  assert.equal(run.state.queue[0].recommended, 'Rewrite the check');
  assert.equal(ev.before.ok, false, 'the rewritten check was red before the build');
  assert.match(run.state.queue[0].text, /behaviour leaf.*already passes/);
  assert.ok(w.calls.asks.some((ids) => ids.includes('QQ:QQ1')));
  assert.deepEqual(order, ['planner', 'planner', 'builder(queue=1)'], 'the builder starts only after the question was queued, answered and the check rewritten');
  assert.equal(run.state.phase, 'done');
});

test('v2-03: a refactor leaf that is red before the work is refused (parked with a reason) and no builder starts first', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  setLeaf(w.handle().run, 'N.1', { leafKind: 'refactor' }); // greet.js does not exist yet, so its check is red
  const n1 = w.scripts['builder:N.1'];
  let queuedWhenBuilt = -1;
  w.scripts['builder:N.1'] = async (c) => {
    queuedWhenBuilt = c.run.state.queue.length;
    return n1(c);
  };
  const run = await runToEnd(w);
  assert.equal(queuedWhenBuilt, 1, 'the refusal was queued before any builder ran');
  assert.match(run.state.queue[0].text, /refactor leaf.*already fail/);
  assert.equal(run.state.leafEvidence['N.1'].before.ok, false);
  assert.ok(w.calls.asks.some((ids) => ids.includes('QQ:QQ1')));
});

test('v2-03: report.md shows red → green per behaviour leaf and green → green per refactor leaf', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const run0 = w.handle().run;
  const work = run0.state.settings.repos[0].workPath;
  fs.writeFileSync(path.join(work, 'greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'pre');
  setLeaf(run0, 'N.1', { leafKind: 'refactor' }); // already green
  const run = await runToEnd(w);
  const report = fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8');
  assert.match(report, /## Red-first evidence/);
  assert.match(report, /N\.1 greet\(\) \[refactor\]: green → green/);
  assert.match(report, /N\.2 export \[behaviour\]: red → green/);
  assert.equal(run.state.phase, 'done');
});

test('v2-10: the gate denies plugin_manager for workers, and for the root agent from the build on, but not before', async () => {
  const w = makeWorld({ human: false });
  await w.rootExec('jd_start');
  const h = w.handle();
  const asRoot = () => judge({ name: 'plugin_manager', arguments: { action: 'install_bundle' }, agent: w.root }, h);
  assert.equal(asRoot(), null, 'allowed for root in the interview');
  assert.match(judge({ name: 'plugin_manager', arguments: {}, agent: w.worker }, h)?.reason ?? '', /queue a question/);
  for (const phase of ['build', 'verify', 'human_checks', 'deliver']) {
    h.run.state.phase = phase;
    assert.match(asRoot()?.reason ?? '', /queue a question/, phase);
  }
});

test('v2-10: preflight fails a bundle the adapter says is not loaded; the report lists bundles and how to remove them', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  hub.overrides.bundleLoaded = async (_h, b) => ({ ok: false, detail: `${b.name} missing` });
  await w.rootExec('jd_start');
  await w.rootExec('jd_set', { key: 'bundles', value: JSON.stringify([{ name: 'my-tool', path: 'docs/f/plugins/my-tool' }]) });
  const r = JSON.parse(await w.rootExec('jd_preflight', { items: [] }));
  const e = r.results.find((x) => x.id === 'bundle:my-tool');
  assert.equal(e.ok, false);
  assert.match(e.detail, /missing/);
  hub.overrides.bundleLoaded = async () => ({ ok: true, detail: '' });
  assert.equal(JSON.parse(await w.rootExec('jd_preflight', { items: [] })).results.find((x) => x.id === 'bundle:my-tool').ok, true);
  const report = renderReport(w.handle().run.state);
  assert.match(report, /## Installed plugin bundles/);
  assert.match(report, /my-tool.*remove_bundle my-tool/);
});

test('v2-10: bundleLoaded queries Config.listConfigs with the real cordis_inspect_query shape', async () => {
  const w = makeWorld({ human: false });
  const calls = [];
  let entries = [{ id: 'a', patchId: 'a', name: 'my-tool', status: 'schema' }];
  hub.overrides.executeTool = async (_h, c) => {
    calls.push(c);
    return { platform: 'host', provider: 'Config', method: 'listConfigs', data: { entries, total: entries.length, nextOffset: null } };
  };
  const S = await import('../lib/host/services.js');
  const h = w.handle();
  assert.deepEqual(await S.bundleLoaded(h, { name: 'my-tool' }), { ok: true, detail: '' });
  assert.equal(calls[0].name, 'cordis_inspect_query');
  assert.deepEqual(calls[0].arguments, { platform: 'host', provider: 'Config', method: 'listConfigs', input: { name: 'my-tool', limit: 100 } });
  entries = [{ id: 'a', patchId: 'a', name: 'my-tool', status: 'inactive' }];
  assert.match((await S.bundleLoaded(h, { name: 'my-tool' })).detail, /inactive/);
  entries = [];
  assert.match((await S.bundleLoaded(h, { name: 'my-tool' })).detail, /not in the running plugin tree/);
  delete hub.overrides.executeTool;
});

test('v2-10: the generated patch has Creator mode\'s three rows and the protocol rule', () => {
  const y = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(y, /id: tool-cordis\n\s+name: '@deepseek-ai\/dsh-tool-cordis'/);
  assert.match(y, /dsh-agent-preset\/package\.json/);
  assert.match(y, /junior-dev\/package\.json/);
  assert.match(y, /disabled: !!js "!ctx\.get\('profileContext'\)"/);
  assert.doesNotMatch(y, /dsh-plugin-manager\/tools'\n\s+disabled: true/);
  assert.match(y, /plugin_manager install_bundle/);
});

/** v2-04: a green behaviour leaf, replanned once without a better check, parks; the developer's answer decides. */
async function parkedGreenLeaf(answer, { preGreet = false } = {}) {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const run0 = w.handle().run;
  if (preGreet) {
    const work = run0.state.settings.repos[0].workPath;
    fs.writeFileSync(path.join(work, 'greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'pre');
  }
  setLeaf(run0, 'N.1', { checks: [{ id: 'N.1/k1', command: preGreet ? GREET_CHECK : 'true', cwd: w.repoPaths[0] }] });
  w.answers.queued = (q) => (q.question.includes('behaviour leaf') ? answer : null);
  return w;
}
const spawnsOf = (w, role, id) => w.calls.spawns.filter((s) => s.role === role && s.nodeId === id).length;

test('v2-04: a commit with a tagged debug line is refused, rolled back and reopened with a reason', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  let attempt = 0;
  const prompts = [];
  w.scripts['builder:N.1'] = async ({ exec, run, prompt }) => {
    prompts.push(prompt);
    const work = run.state.settings.repos[0].workPath;
    attempt++;
    fs.writeFileSync(path.join(work, 'greet.js'), `export const greet = (n) => {\n${attempt === 1 ? "  console.log('JD-DEBUG n', n);\n" : ''}  return \`Hello, \${n}!\`;\n};\n`);
    await exec('jd_submit', { summary: 'greet added' });
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  const wt = run.state.settings.repos[0].workPath;
  assert.equal(attempt, 2, 'the tagged attempt was reopened');
  assert.match(prompts[0], /JD-DEBUG/, 'the builder brief states the tag');
  assert.match(prompts[1], /Previous attempt failed[\s\S]*debug-tag[\s\S]*remove every tagged debug line/);
  assert.ok(run.state.tree.nodes['N.1'].evidence.some((e) => e.checkId === 'debug-tag' && !e.ok));
  assert.doesNotMatch(git(wt, 'log', '-p', '--format=%s'), /JD-DEBUG/, 'no commit ever carried the tag');
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
});

test('v2-04: the fixer root cause from jd_submit is in the fix commit message', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  const fixerPrompts = [];
  let round = 0;
  w.scripts.fixer = async ({ exec, run, prompt }) => {
    fixerPrompts.push(prompt);
    const work = run.state.settings.repos[0].workPath;
    fs.appendFileSync(path.join(work, 'index.js'), "export const extra = 1; // JD-DEBUG leftover\n");
    if (++round > 1) fs.writeFileSync(path.join(work, 'index.js'), "export { greet } from './greet.js';\nexport const extra = 1;\n");
    await exec('jd_submit', { summary: 'added extra', rootCause: 'index.js never defined extra, which U2 reads' });
  };
  await w.settleToFinal();
  w.handle().run.store.commit('check_def', { ...w.handle().run.state.checks.U2, command: `node -e "import('./index.js').then(m=>process.exit(m.extra===1?0:1))"` });
  w.handle().run.parity('final', true);
  const run = await runToEnd(w);
  const wt = run.state.settings.repos[0].workPath;
  assert.match(fixerPrompts[0], /JD-DEBUG/);
  assert.equal(round, 2, 'the tagged fix was refused first');
  assert.match(git(wt, 'log', '--format=%B', '--grep=^jd(fix'), /Root cause: index\.js never defined extra, which U2 reads/);
  assert.doesNotMatch(git(wt, 'log', '-p', '--format=%s'), /JD-DEBUG/);
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
});

test('v2-04: park answer "check is fine, already done" marks the leaf done with the before-evidence and builds nothing', async () => {
  const w = await parkedGreenLeaf('Check is fine, already done', { preGreet: true });
  const run = await runToEnd(w);
  const n = run.state.tree.nodes['N.1'];
  assert.equal(n.status, 'done');
  assert.match(n.evidence[0].output, /already satisfied before any work/);
  assert.equal(spawnsOf(w, 'builder', 'N.1'), 0);
  assert.equal(run.state.leafEvidence['N.1'].answer, 'done');
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
});

test('v2-04: park answer "rewrite the check" goes back to the planner, then the builder', async () => {
  const w = await parkedGreenLeaf('Rewrite the check');
  w.scripts['planner:N.1'] = async ({ exec, run }) => {
    if (run.state.leafEvidence['N.1'].answer === 'rewrite') await exec('jd_set_checks', { checks: [{ command: GREET_CHECK, cwd: w.repoPaths[0] }] });
  };
  const run = await runToEnd(w);
  assert.equal(spawnsOf(w, 'planner', 'N.1'), 2);
  assert.equal(spawnsOf(w, 'builder', 'N.1'), 1);
  assert.equal(run.state.tree.nodes['N.1'].checks[0].command, GREET_CHECK);
  assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
});

test('v2-04: park answer "drop the leaf" removes it under the ripple rules, or blocks it with the reasons', async () => {
  // refused: N.2 depends on N.1 and the criterion N#A1 is covered only by N.1
  const w = await parkedGreenLeaf('Drop the leaf');
  const run = await runToEnd(w);
  assert.equal(run.state.tree.nodes['N.1'].status, 'blocked');
  assert.ok(run.state.notes.some((n) => n.kind === 'leaf_drop_refused' && /R5|R1/.test(n.text)));
  assert.equal(spawnsOf(w, 'builder', 'N.1'), 0);
  // allowed: nothing depends on it and a sibling covers its criteria
  const w2 = await parkedGreenLeaf('Drop the leaf');
  const r0 = w2.handle().run;
  const n1 = r0.state.tree.nodes['N.1'];
  setLeaf(r0, 'N.2', { dependsOn: [], uses: [], covers: [...r0.state.tree.nodes['N.2'].covers, ...n1.covers] });
  r0.store.commit('tree', { op: 'test', patch: { contracts: { 'C:N.1:greet': { ...r0.state.tree.contracts['C:N.1:greet'], ownerNodeId: 'N' } } }, affected: [] });
  const run2 = await runToEnd(w2);
  assert.equal(run2.state.tree.nodes['N.1'], undefined, 'the leaf is gone');
  assert.equal(spawnsOf(w2, 'builder', 'N.1'), 0);
});

// ---------------------------------------------------------------- v2-08 stack profiles
const TS_FILES = {
  'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test', lint: 'eslint .' }, devDependencies: { typescript: '^5' } }),
  'tsconfig.json': '{}\n',
};

test('v2-08: matchProfiles picks profiles from marker sets (pure)', async () => {
  const { matchProfiles, PROFILES } = await import('../lib/profiles/index.js');
  assert.deepEqual(matchProfiles(['package.json', 'tsconfig.json', 'src']), ['ts']);
  assert.deepEqual(matchProfiles(['package.json']), []);
  assert.deepEqual(matchProfiles([]), []);
  const twin = { ...PROFILES[0], name: 'ts2' };
  assert.deepEqual(matchProfiles(['package.json', 'tsconfig.json'], [PROFILES[0], twin]), ['ts', 'ts2']);
  assert.deepEqual(Object.keys(PROFILES[0]).sort(), ['defaultChecks', 'guidance', 'hiddenTools', 'humanEvidence', 'markers', 'name', 'ownTools', 'passRules', 'readiness', 'rootNote', 'timeouts', 'workspaceSetup'].sort());
});

test('v2-08: a TS toy repo is detected when repos are set, and named in the next-step text; default checks come from package.json scripts', async () => {
  const w = makeWorld({ repoFiles: () => TS_FILES });
  await w.rootExec('jd_start');
  await w.rootExec('jd_fact', { text: 'repo is TS', source: 'tsconfig.json' });
  await w.rootExec('jd_advance', { to: 'interview' });
  const out = await w.rootExec('jd_set', { key: 'repos', value: w.repoPaths.map((p) => ({ path: p, mode: 'worktree' })) });
  assert.match(out, new RegExp(`${w.repoPaths[0]}: ts`));
  const stack = w.handle().run.state.settings.stacks[w.repoPaths[0]];
  assert.equal(stack.profile, 'ts');
  assert.deepEqual(stack.checks.map((c) => c.command), ['npm test', 'npx --no-install tsc --noEmit', 'npm run lint']);
  assert.ok(stack.checks.every((c) => c.pass === 'exit0'));
  assert.match(JSON.parse(await w.rootExec('jd_status')).next, new RegExp(`Detected stacks:\\n- ${w.repoPaths[0]}: ts`));
  await w.rootExec('jd_ask', { question: 'Should greet trim the name?', options: ['No', 'Yes'], recommended: 'No' });
  for (const [k, v] of Object.entries({ permissions: { push: false, pr: false, remoteWrites: [], debugEnv: null }, budget: { timeMin: 30, tokens: 1e7 }, models: { planner: { provider: 'fake', model: 'm1' }, builder: { provider: 'fake', model: 'm1' }, checker: { provider: 'fake', model: 'm1' } }, crossModel: { enabled: false }, dial: 'balanced' })) await w.rootExec('jd_set', { key: k, value: v });
  await w.rootExec('jd_advance', { to: 'prd_parity' });
  const next = JSON.parse(await w.rootExec('jd_status')).next;
  assert.match(next, /detected stack of each repo/);
  assert.match(next, /: ts/);
});

test('v2-08: a repo with no profile is recorded as such, needs no question, and runs on shell checks', async () => {
  const w = makeWorld();
  honestBuilders(w);
  await w.settleToFinal();
  const run = w.handle().run;
  assert.deepEqual(run.state.settings.stacks[w.repoPaths[0]], { profile: null, candidates: [], dirs: [], found: {}, checks: [] });
  assert.match((await import('../lib/host/prompts.js')).nextStep({ ...run.state, phase: 'interview' }), /: no profile — shell checks only, no question needed/);
  const done = await runToEnd(w);
  assert.equal(done.state.phase, 'done', done.state.sideReason ?? '');
});

test('v2-08: TS guidance is in worker briefs of TS repos only; an ambiguous repo is resolved by jd_set stacks', async () => {
  const GUIDE = /TypeScript repo notes:/;
  for (const ts of [true, false]) {
    const w = makeWorld({ repoFiles: () => (ts ? TS_FILES : {}) });
    const seen = [];
    honestBuilders(w);
    for (const k of ['builder:N.1', 'builder:N.2', 'planner']) {
      const inner = w.scripts[k];
      w.scripts[k] = async (c) => { seen.push(c.prompt); return inner?.(c); };
    }
    await w.settleToFinal();
    await runToEnd(w);
    assert.ok(seen.length >= 2);
    for (const p of seen) {
      assert.equal(GUIDE.test(p), ts, `guidance ${ts ? 'present' : 'absent'}`);
      if (ts) assert.match(p, /only when a requirement calls for it/);
    }
  }
  // two repos, only the second is TS: leaves touching repo 1 get none
  const w = makeWorld({ repos: 2, repoFiles: (i) => (i === 1 ? TS_FILES : {}) });
  const seen = [];
  honestBuilders(w);
  for (const k of ['builder:N.1', 'builder:N.2']) { const inner = w.scripts[k]; w.scripts[k] = async (c) => { seen.push(c.prompt); return inner(c); }; }
  await w.settleToFinal();
  await runToEnd(w);
  assert.ok(seen.length === 2 && seen.every((p) => !GUIDE.test(p)));
  // ambiguous: two matching profiles ask one question; the answer is recorded
  const { stacksNote } = await import('../lib/profiles/index.js');
  const note = stacksNote({ '/r': { profile: null, candidates: ['ts', 'ios'], checks: [] } });
  assert.match(note, /ambiguous \(ts or ios\).*ONE jd_ask question/);
  await assert.rejects(() => w.rootExec('jd_set', { key: 'stacks', value: { [w.repoPaths[0]]: 'cobol' } }), /unknown profile/);
});

// ---------------------------------------------------------------- v2-09 tool-call checks
test('v2-09: a tool check is called by the plugin and judged by the profile pass rule; evidence records the result', async () => {
  const { PROFILES } = await import('../lib/profiles/index.js');
  const { runAnyCheck } = await import('../lib/host/run-check.js');
  const testProfile = { name: 'v209', markers: { all: ['nope.v209'] }, passRules: { built: (r) => ({ ok: r?.status === 'ok', output: `status ${r?.status}` }), boom: () => { throw new Error('rule exploded'); } } };
  PROFILES.push(testProfile);
  const w = makeWorld({ human: false });
  const calls = [];
  let result = { status: 'ok', errors: 0 };
  hub.overrides.executeTool = async (_h, c) => {
    calls.push(c);
    if (c.name === 'missing_tool') throw new Error('unknown tool missing_tool');
    return result;
  };
  try {
    const h = w.handle();
    const ok = await runAnyCheck(h, { id: 'U9', tool: 'build_it', arguments: { scheme: 'App' }, pass: 'built' }, {});
    assert.equal(ok.ok, true);
    assert.match(ok.output, /\{"status":"ok","errors":0\}/);
    assert.deepEqual(calls[0].arguments, { scheme: 'App' });
    assert.equal(calls[0].name, 'build_it');
    result = { status: 'failed', errors: 2 };
    const bad = await runAnyCheck(h, { tool: 'build_it', arguments: {}, pass: 'built' }, {});
    assert.equal(bad.ok, false);
    assert.match(bad.output, /"status":"failed"[\s\S]*status failed/);
    assert.match((await runAnyCheck(h, { tool: 'missing_tool', arguments: {}, pass: 'built' }, {})).output, /unknown tool missing_tool/);
    assert.match((await runAnyCheck(h, { tool: 'build_it', arguments: {}, pass: 'nope' }, {})).output, /unknown pass rule "nope"/);
    assert.match((await runAnyCheck(h, { tool: 'build_it', arguments: {}, pass: 'boom' }, {})).output, /rule exploded/);
    assert.equal((await runAnyCheck(h, { tool: 'build_it', arguments: {} }, {})).ok, false);
    assert.equal((await runAnyCheck(h, { command: 'true' }, { cwd: process.cwd() })).ok, true, 'shell checks still run');
  } finally {
    PROFILES.splice(PROFILES.indexOf(testProfile), 1);
    delete hub.overrides.executeTool;
  }
});

test('v2-09: tool checks also work on the jd_preflight path', async () => {
  const { PROFILES } = await import('../lib/profiles/index.js');
  const testProfile = { name: 'v209b', markers: { all: ['nope.v209'] }, passRules: { built: (r) => ({ ok: r?.status === 'ok', output: '' }) } };
  PROFILES.push(testProfile);
  let status = 'ok';
  const w = makeWorld({ human: false });
  hub.overrides.executeTool = async () => ({ status });
  try {
    await w.rootExec('jd_start');
    const pf = JSON.parse(await w.rootExec('jd_preflight', { items: [{ id: 'pfx', what: 'build works', tool: 'build_it', arguments: {}, pass: 'built' }] }));
    assert.equal(pf.results.find((x) => x.id === 'pfx').ok, true);
    status = 'bad';
    const pf2 = JSON.parse(await w.rootExec('jd_preflight', { items: [{ id: 'pfy', what: 'build works', tool: 'build_it', arguments: {}, pass: 'built' }] }));
    assert.equal(pf2.results.find((x) => x.id === 'pfy').ok, false);
  } finally {
    PROFILES.splice(PROFILES.indexOf(testProfile), 1);
    delete hub.overrides.executeTool;
  }
});

// ---------------------------------------------------------------- v2-11 iOS profile
const IOS_FILES = { 'App.xcodeproj/project.pbxproj': '// toy\n' };
const iosCalls = [];
const iosTool = (over = {}) => async (_h, c) => {
  iosCalls.push(c);
  if (over[c.name]) return typeof over[c.name] === 'function' ? over[c.name](c) : over[c.name];
  if (c.name === 'ios_status') return { ready: true, reasons: [] };
  if (c.name === 'ios_sim_build_run') return { ok: true, bundleId: 'dev.example.app' };
  if (c.name === 'ios_sim_screenshot') return { path: '/tmp/shots/after.png' };
  throw new Error(`unscripted tool ${c.name}`);
};

test('v2-11: an iOS toy repo (.xcodeproj / .xcworkspace / iOS Package.swift) is detected; default checks are build and test tool checks', async () => {
  const { matchProfiles, detectStack } = await import('../lib/profiles/index.js');
  assert.deepEqual(matchProfiles(['App.xcodeproj', 'README.md']), ['ios']);
  assert.deepEqual(matchProfiles(['App.xcworkspace']), ['ios']);
  assert.deepEqual(matchProfiles(['README.md']), []);
  const w = makeWorld({ repoFiles: () => IOS_FILES });
  const s = detectStack(w.repoPaths[0]);
  assert.equal(s.profile, 'ios');
  assert.deepEqual(s.checks.map((c) => [c.id, c.tool, c.pass]), [['build', 'ios_build', 'ios-build'], ['test', 'ios_test', 'ios-test']]);
  assert.equal(s.checks[0].arguments.workspacePath, path.join(w.repoPaths[0], 'App.xcodeproj'));
  const pkg = tmpdir('jd-pkg-');
  fs.writeFileSync(path.join(pkg, 'Package.swift'), '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "K", platforms: [.iOS(.v17)], targets: [])\n');
  assert.equal(detectStack(pkg).profile, 'ios');
  const mac = tmpdir('jd-pkg-');
  fs.writeFileSync(path.join(mac, 'Package.swift'), 'let package = Package(name: "K", platforms: [.macOS(.v14)], targets: [])\n');
  assert.equal(detectStack(mac).profile, null);
});

test('v2-11: build and test evidence pass or fail by the profile rules, through a scripted executeTool', async () => {
  const { runAnyCheck } = await import('../lib/host/run-check.js');
  const w = makeWorld();
  const counts = (o = {}) => ({ total: 10, passed: 10, failed: 0, skipped: 0, expectedFailures: 0, notRun: 0, ...o });
  let build = { result: 'success', errors: [], logPath: '/tmp/b.log' };
  let test_ = { counts: counts(), failures: [], xcresultPath: '/tmp/r.xcresult' };
  const seen = [];
  hub.overrides.executeTool = iosTool({ ios_build: (c) => { seen.push(c); return build; }, ios_test: () => test_ });
  try {
    await w.rootExec('jd_start');
    const h = w.handle();
    const B = { id: 'U1', tool: 'ios_build', arguments: { workspacePath: '/w/App.xcodeproj' }, pass: 'ios-build' };
    const T_ = { id: 'U2', tool: 'ios_test', arguments: { workspacePath: '/w/App.xcodeproj' }, pass: 'ios-test' };
    assert.equal((await runAnyCheck(h, B, {})).ok, true);
    assert.deepEqual(seen[0].arguments, { workspacePath: '/w/App.xcodeproj' });
    build = { result: 'failed', errors: [{ file: 'A.swift', line: 3, message: 'cannot find x' }], logPath: '/tmp/b.log' };
    const bf = await runAnyCheck(h, B, {});
    assert.equal(bf.ok, false);
    assert.match(bf.output, /A\.swift:3 cannot find x/);
    build = { result: 'cancelled', errors: [] };
    assert.equal((await runAnyCheck(h, B, {})).ok, false);
    assert.equal((await runAnyCheck(h, T_, {})).ok, true);
    test_ = { counts: counts({ failed: 1, passed: 9 }), failures: [{ name: 'GreetTests.testEmpty', message: 'XCTAssertEqual failed' }], xcresultPath: '/tmp/r.xcresult' };
    const tf = await runAnyCheck(h, T_, {});
    assert.equal(tf.ok, false);
    assert.match(tf.output, /GreetTests\.testEmpty: XCTAssertEqual failed[\s\S]*r\.xcresult/);
    test_ = { counts: counts({ notRun: 2, passed: 8 }), failures: [] };
    assert.equal((await runAnyCheck(h, T_, {})).ok, false, 'notRun must be 0');
    test_ = { error: 'build_failed', counts: counts(), failures: [] };
    assert.match((await runAnyCheck(h, T_, {})).output, /build_failed/);
    test_ = { error: { kind: 'tests_running' } };
    assert.equal((await runAnyCheck(h, T_, {})).ok, false);
    hub.overrides.executeTool = async () => { throw new Error('unknown tool ios_test'); };
    assert.match((await runAnyCheck(h, T_, {})).output, /unknown tool ios_test/);
  } finally {
    delete hub.overrides.executeTool;
  }
});

test('v2-11: a not-ready dsh-ios (or a missing status tool) blocks preflight with the reasons and the setup hint', async () => {
  const w = makeWorld({ repoFiles: () => IOS_FILES });
  const j = JSON.parse;
  await w.rootExec('jd_start');
  await w.rootExec('jd_fact', { text: 'iOS app', source: 'App.xcodeproj' });
  await w.rootExec('jd_advance', { to: 'interview' });
  await w.rootExec('jd_set', { key: 'repos', value: w.repoPaths.map((p) => ({ path: p, mode: 'worktree' })) });
  const calls = [];
  hub.overrides.executeTool = iosTool({ ios_status: (c) => { calls.push(c); return { ready: false, reasons: ['Xcode MCP is not enabled', 'no folder grant for the worktree root'], setup: ['xcrun mcp-server enable'] }; } });
  try {
    const pf = j(await w.rootExec('jd_preflight', { items: [{ what: 'node works', command: 'node --version' }] }));
    assert.equal(pf.ok, false);
    const r = pf.results.find((x) => x.id === 'ios-ready');
    assert.equal(r.ok, false);
    assert.match(r.detail, /Xcode MCP is not enabled; no folder grant/);
    assert.match(r.detail, /one-time setup: xcrun mcp-server enable/);
    assert.equal(calls[0].arguments.worktreesRoot, process.env.JD_WORKTREES_ROOT);
    assert.equal(w.handle().run.state.preflight.find((p) => p.id === 'ios-ready').ok, false);
    hub.overrides.executeTool = async () => { throw new Error('unknown tool ios_status'); };
    const pf2 = j(await w.rootExec('jd_preflight', { items: [] }));
    assert.equal(pf2.ok, false);
    assert.match(pf2.results.find((x) => x.id === 'ios-ready').detail, /unknown tool ios_status/);
    hub.overrides.executeTool = iosTool();
    const pf3 = j(await w.rootExec('jd_preflight', { items: [] }));
    assert.equal(pf3.results.find((x) => x.id === 'ios-ready').ok, true);
    assert.equal(w.handle().run.state.preflight.find((p) => p.id === 'ios-ready').ok, true);
  } finally {
    delete hub.overrides.executeTool;
  }
});

test('v2-11: Xcode MCP tools are in every worker deny list, dsh-ios tools only where no repo is iOS; human checks carry a screenshot reference', async () => {
  const { hiddenToolsFor } = await import('../lib/profiles/index.js');
  const { XCODE_TOOL_NAMES } = await import('../lib/engine/classify.js');
  const avail = ['mcp__Xcode__BuildProject', 'mcp__other-server__XcodeRead', 'mcp__github__create_issue', 'ios_build', 'ios_sim_screenshot', 'mcp__x__NotAnXcodeTool', 'bash', 'plugin_manager', 'cordis_inspect_query'];
  const hidden = hiddenToolsFor({ '/r': { profile: 'ios' } }, avail);
  assert.ok(hidden.includes('mcp__Xcode__BuildProject') && hidden.includes('mcp__other-server__XcodeRead'));
  assert.ok(hidden.includes('plugin_manager') && hidden.includes('cordis_inspect_query'));
  assert.ok(!hidden.some((n) => /^ios_|github|NotAnXcodeTool|^bash$/.test(n)));
  assert.ok(hidden.includes(`mcp__xcode__${XCODE_TOOL_NAMES[0]}`));
  const tsHidden = hiddenToolsFor({ '/r': { profile: 'ts' } }, avail);
  assert.ok(tsHidden.includes('ios_build') && tsHidden.includes('mcp__Xcode__BuildProject'));
  assert.ok(!tsHidden.some((n) => /github|NotAnXcodeTool|^bash$/.test(n)));

  for (const ios of [true, false]) {
    const w = makeWorld({ repoFiles: () => (ios ? IOS_FILES : {}) });
    honestBuilders(w);
    const hiddenSeen = [];
    const inner = hub.overrides.spawnWorker;
    hub.overrides.spawnWorker = (h, o) => { hiddenSeen.push(o.hiddenTools); return inner(h, o); };
    const asks = [];
    const innerAsk = hub.overrides.ask;
    hub.overrides.ask = (h, qs) => { asks.push(...qs); return innerAsk(h, qs); };
    hub.overrides.executeTool = iosTool();
    try {
      await w.settleToFinal();
      const run = await runToEnd(w);
      assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
      assert.ok(hiddenSeen.length >= 2);
      for (const hs of hiddenSeen) {
        assert.equal(hs.includes('mcp__xcode__BuildProject'), ios); // the iOS profile also names them, for a server called "xcode"
        assert.ok(hs.some((t) => t instanceof RegExp && t.test('mcp__any__XcodeRead')));
        assert.equal(hs.some((t) => t instanceof RegExp && t.test('ios_build')), !ios);
      }
      const hc = asks.find((q) => q.id === 'HC:H1');
      if (ios) {
        assert.match(hc.detail, /ios screenshot \/tmp\/shots\/after\.png/);
        // the worktree's app is built and launched before the screenshot (R3: it showed the home screen)
        const names = iosCalls.map((c) => c.name);
        const br = iosCalls.findLast((c) => c.name === 'ios_sim_build_run');
        assert.ok(br && names.lastIndexOf('ios_sim_build_run') < names.lastIndexOf('ios_sim_screenshot'));
        assert.ok(br.arguments.projectPath.startsWith(run.state.settings.repos[0].workPath), br.arguments.projectPath);
        assert.ok(run.state.notes.some((n) => n.kind === 'human_evidence' && /after\.png/.test(n.text)));
      } else {
        assert.doesNotMatch(hc.detail, /screenshot/);
      }
    } finally {
      delete hub.overrides.executeTool;
    }
  }

  // a failed capture is noted, not fatal
  const w = makeWorld({ repoFiles: () => IOS_FILES });
  honestBuilders(w);
  hub.overrides.executeTool = iosTool({ ios_sim_screenshot: () => { throw new Error('no booted simulator'); } });
  try {
    await w.settleToFinal();
    const run = await runToEnd(w);
    assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
    assert.ok(run.state.notes.some((n) => n.kind === 'human_evidence' && /could not capture.*no booted simulator/.test(n.text)));
  } finally {
    delete hub.overrides.executeTool;
  }
});

test('v2-11: profile timeouts reach the check runner for shell and tool checks (and iOS limits are long)', async () => {
  const { PROFILES, timeoutFor, profileByName } = await import('../lib/profiles/index.js');
  const { runAnyCheck } = await import('../lib/host/run-check.js');
  const ios = profileByName('ios');
  assert.equal(timeoutFor(ios, { tool: 'ios_build' }), 30 * 60 * 1000);
  assert.equal(timeoutFor(ios, { tool: 'ios_test' }), 45 * 60 * 1000);
  assert.equal(timeoutFor(ios, { command: 'true' }), 30 * 60 * 1000);
  const slow = { name: 'v211', markers: { all: ['nope.v211'] }, passRules: { ok: () => ({ ok: true, output: '' }) }, timeouts: { checkMs: 300, byTool: { slow_tool: 80 } } };
  PROFILES.push(slow);
  const w = makeWorld({ human: false });
  try {
    await w.rootExec('jd_start');
    const h = w.handle();
    h.run.set('stacks', { '/r': { profile: 'v211', candidates: ['v211'], checks: [] } });
    hub.overrides.executeTool = (_h, c) => new Promise((res) => { c.signal.addEventListener('abort', () => res('aborted')); });
    const t0 = Date.now();
    const tool = await runAnyCheck(h, { tool: 'slow_tool', arguments: {}, pass: 'ok' }, {});
    assert.equal(tool.ok, false);
    assert.match(tool.output, /timed out after 80 ms/);
    const sh = await runAnyCheck(h, { command: 'sleep 5' }, { cwd: process.cwd() });
    assert.equal(sh.ok, false);
    assert.ok(Date.now() - t0 < 3000, 'both stopped by the profile limits, not by the 5 s command');
    assert.match((await runAnyCheck(h, { tool: 'slow_tool', arguments: {}, pass: 'ok' }, { timeoutMs: 20 })).output, /timed out after 20 ms/);
  } finally {
    PROFILES.splice(PROFILES.indexOf(slow), 1);
    delete hub.overrides.executeTool;
  }
});

// ---------------------------------------------------------------- v2-12 mixed iOS + TS run
test('v2-12: a mixed iOS + TS two-repo scripted run reaches done with per-repo stacks, evidence, guidance and PRs', async () => {
  const calls = [];
  const w = makeWorld({
    repos: 2, push: true, pr: true,
    repoFiles: (i) => (i === 0 ? IOS_FILES : TS_FILES),
    plan: ([r1, r2]) => ({
      vpRows: `| U1 | automated | iOS app builds | A1 | \`tool:ios_build {"workspacePath":"${path.join(r1, 'App.xcodeproj')}"} pass:ios-build\` |\n| U2 | automated | TS helper exists | B1 | \`test -f greet.ts\` |\n`,
      ipExtra: `\n| Check | Command | Cwd |\n|---|---|---|\n| U2 | \`test -f greet.ts\` | ${r2} |\n`,
      leaves: [
        { title: 'iOS greeting', doneWhen: ['the app builds'], covers: ['N#A1'], traces: { requirements: ['A1'], checks: ['U1'] }, kind: 'behaviour', checks: [{ tool: 'ios_build', arguments: { workspacePath: path.join(r1, 'App.xcodeproj') }, pass: 'ios-build' }], risk: 'high' },
        { title: 'TS greeting', doneWhen: ['greet.ts exists'], covers: ['N#B1'], traces: { requirements: ['B1'], checks: ['U2'] }, kind: 'behaviour', checks: [{ command: 'test -f greet.ts', cwd: r2 }] },
      ],
    }),
  });
  const seen = {};
  const spy = (key, file, repoIdx) => {
    w.scripts[key] = async ({ prompt, run, exec }) => {
      seen[key] = prompt;
      fs.writeFileSync(path.join(run.state.settings.repos[repoIdx].workPath, file), '// toy\n');
      await exec('jd_submit', { summary: `${file} added` });
    };
  };
  spy('builder:N.1', 'Greeter.swift', 0);
  spy('builder:N.2', 'greet.ts', 1);
  // red first: the build fails until the worker has added the Swift file to the worktree
  hub.overrides.executeTool = iosTool({ ios_build: (c) => { calls.push(c); return fs.existsSync(path.join(path.dirname(c.arguments.workspacePath), 'Greeter.swift')) ? { result: 'success', errors: [], logPath: '/tmp/b.log' } : { result: 'failed', errors: [{ file: 'App.swift', line: 1, message: 'no Greeter' }] }; } });
  try {
    await w.settleToFinal();
    const run = await runToEnd(w);
    assert.equal(run.state.phase, 'done', `${run.state.sideReason ?? ''} ${JSON.stringify(run.state.blockers)}`);
    const [r1, r2] = run.state.settings.repos;
    const st = run.state.settings.stacks;
    assert.equal(st[r1.path].profile, 'ios');
    assert.equal(st[r2.path].profile, 'ts');
    const ev1 = run.state.tree.nodes['N.1'].evidence.filter((e) => e.ok);
    assert.match(ev1[0].output, /tool ios_build[\s\S]*rule ios-build: pass/);
    assert.ok(run.state.tree.nodes['N.2'].evidence.some((e) => e.ok));
    assert.ok(calls.length >= 2, 'leaf check plus the end-of-run cross-repo check');
    for (const c of calls) assert.equal(c.arguments.workspacePath, path.join(r1.workPath, 'App.xcodeproj'));
    for (const id of ['U1', 'U2']) assert.equal(run.state.checks[id].results.at(-1).ok, true, id);
    assert.match(seen['builder:N.1'], /iOS repo notes/);
    assert.doesNotMatch(seen['builder:N.1'], /TypeScript repo notes/);
    assert.match(seen['builder:N.2'], /TypeScript repo notes/);
    assert.doesNotMatch(seen['builder:N.2'], /iOS repo notes/);
    const gh = fs.readFileSync(w.ghLog, 'utf8');
    assert.equal((gh.match(/^pr create/gm) ?? []).length, 2);
    assert.equal(run.state.delivery.prs.length, 2);
  } finally {
    delete hub.overrides.executeTool;
  }
});

test('v2-12: the gate denies Xcode MCP tools for workers whatever the server is called, and points at dsh-ios', async () => {
  const { XCODE_TOOL_NAMES } = await import('../lib/engine/classify.js');
  const w = makeWorld({ human: false });
  await w.rootExec('jd_start');
  const h = w.handle();
  for (const name of [`mcp__my-odd_server.7__${XCODE_TOOL_NAMES[0]}`, 'mcp__xcode__BuildProject', 'mcp__Xc0de__XcodeRead']) {
    const d = judge({ name, arguments: {}, agent: w.worker }, h);
    assert.equal(d?.kind, 'deny', name);
    assert.match(d.reason, /dsh-ios/);
  }
  assert.equal(judge({ name: 'mcp__odd__NotAnXcodeTool', arguments: {}, agent: w.worker }, h), null);
  assert.equal(judge({ name: 'ios_build', arguments: {}, agent: w.worker }, h), null);
});

test('v2-12: a tool check\'s workspacePath is remapped into the worktree (a path elsewhere is left alone)', async () => {
  const w = makeWorld({ repoFiles: () => IOS_FILES, human: false });
  honestBuilders(w);
  const seen = [];
  hub.overrides.executeTool = iosTool({ ios_build: (c) => { seen.push(c.arguments.workspacePath); return { result: 'success', errors: [] }; } });
  try {
    await w.settleToFinal();
    const h = w.handle();
    const [repo] = h.run.state.settings.repos;
    const { runCheckOf } = await import('../lib/host/loop.js');
    const mk = (p) => ({ id: 'X', tool: 'ios_build', arguments: { workspacePath: p }, pass: 'ios-build' });
    await runCheckOf(h, mk(path.join(repo.path, 'App.xcodeproj')));
    await runCheckOf(h, mk(path.join(repo.workPath, 'App.xcodeproj')));
    await runCheckOf(h, mk('/elsewhere/Other.xcodeproj'));
    assert.deepEqual(seen, [path.join(repo.workPath, 'App.xcodeproj'), path.join(repo.workPath, 'App.xcodeproj'), '/elsewhere/Other.xcodeproj']);
  } finally {
    delete hub.overrides.executeTool;
  }
});

// ---------------------------------------------------------------- v2-13 workspace setup (found preparing R2)
test('v2-13: TS workspaceSetup installs declared deps with the lockfile\'s own tool, and nothing when there are no deps or they are installed', async () => {
  const ts = (await import('../lib/profiles/ts.js')).default;
  const dir = (files) => {
    const d = tmpdir('jd-ws-');
    for (const [f, c] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), c);
    return d;
  };
  const pkg = JSON.stringify({ devDependencies: { typescript: '*' } });
  const cmd = (files) => ts.workspaceSetup(dir(files)).map((i) => i.command);
  assert.deepEqual(cmd({ 'package.json': pkg, 'package-lock.json': '{}' }), ['npm ci']);
  assert.deepEqual(cmd({ 'package.json': pkg, 'pnpm-lock.yaml': '' }), ['pnpm install --frozen-lockfile']);
  assert.deepEqual(cmd({ 'package.json': pkg, 'yarn.lock': '' }), ['yarn install --frozen-lockfile']);
  assert.deepEqual(cmd({ 'package.json': pkg, 'bun.lock': '' }), ['bun install --frozen-lockfile']);
  assert.deepEqual(cmd({ 'package.json': pkg }), ['npm install --no-package-lock']);
  assert.deepEqual(cmd({ 'package.json': pkg, 'node_modules/.keep': '' }), []);
  assert.deepEqual(cmd({ 'package.json': '{"type":"module"}' }), []);
  assert.deepEqual(cmd({}), []);
});

test('v2-13: jd_prepare installs a TS worktree\'s declared deps in the worktree; a failed install is reported and blocks the build', async () => {
  for (const fail of [false, true]) {
    const w = makeWorld({ repoFiles: () => TS_FILES });
    honestBuilders(w);
    if (fail) fs.writeFileSync(path.join(w.session, 'npm-fail'), '');
    await w.settleToFinal();
    const run = w.handle().run;
    const wp = run.state.settings.repos[0].workPath;
    const log = fs.readFileSync(w.npmLog, 'utf8');
    assert.match(log, new RegExp(`^${wp} install --no-package-lock$`, 'm'), log);
    const entry = run.state.preflight.find((p) => p.id === 'setup:repo1:deps');
    assert.equal(entry?.ok, !fail, JSON.stringify(run.state.preflight));
    if (!fail) {
      assert.ok(fs.existsSync(path.join(wp, 'node_modules')));
      const done = await runToEnd(w);
      assert.equal(done.state.phase, 'done', done.state.sideReason ?? '');
    } else {
      assert.match(entry.detail, /network unreachable/);
      await assert.rejects(w.rootExec('jd_run'), /preflight failed: install the repo's declared dependencies/);
    }
  }
});

// ---------------------------------------------------------------- R2 findings (v2 ticket 13)
test('v2-13: the budget counts cache reads at a tenth (R2: prefix re-reads used up a toy run\'s budget)', async () => {
  const { effectiveTokens, CACHE_READ_WEIGHT } = await import('../lib/engine/budget.js');
  assert.equal(CACHE_READ_WEIGHT, 0.1);
  // the R2 N.3 worker: 12.8k uncached, 381k cache read, 17k cache write, 2.9k out
  assert.equal(effectiveTokens({ uncachedInputTokens: 12800, cacheReadTokens: 381000, cacheWriteTokens: 17000, outputTokens: 2900 }), 70800);
  assert.equal(effectiveTokens(undefined), 0);
  assert.equal(effectiveTokens({ outputTokens: 5 }), 5);
});

test('v2-13: builder briefs carry the repo rules, the bash description note, worktree check paths and the other items; a tests-only behaviour leaf is flagged in the evidence', async () => {
  const RULES = '# Rules\n- No default exports.\n';
  const w = makeWorld({
    repoFiles: () => ({ 'AGENTS.md': RULES }),
    plan: ([r1]) => ({
      leaves: [
        { title: 'greet()', doneWhen: ['greet returns the greeting'], covers: ['N#A1'], traces: { requirements: ['A1'], checks: ['U1'] }, kind: 'behaviour', checks: [{ command: GREET_CHECK, cwd: r1 }] },
        { title: 'export test', doneWhen: ['index.js exports greet'], covers: ['N#B1'], traces: { requirements: ['B1'], checks: ['U2'] }, kind: 'behaviour', checks: [{ command: 'test -f test/export.test.js', cwd: r1 }], dependsOn: ['#1'] },
      ],
    }),
  });
  const seen = {};
  honestBuilders(w);
  // N.1 also ships a test file (source changed); N.2's builder writes only a test, but its check is "the test exists"
  const inner = w.scripts['builder:N.1'];
  w.scripts['builder:N.1'] = async (c) => { seen.N1 = c.prompt; return inner(c); };
  w.scripts['builder:N.2'] = async ({ exec, run, prompt }) => {
    seen.N2 = prompt;
    const wp = run.state.settings.repos[0].workPath;
    fs.mkdirSync(path.join(wp, 'test'), { recursive: true });
    fs.writeFileSync(path.join(wp, 'test', 'export.test.js'), "import { greet } from '../index.js';\n");
    await exec('jd_submit', { summary: 'test added' });
  };
  await w.settleToFinal();
  const run = await runToEnd(w);
  const wp = run.state.settings.repos[0].workPath;
  for (const p of [seen.N1, seen.N2]) {
    assert.match(p, /This repo's own rules[\s\S]*No default exports/);
    assert.match(p, /Every bash call needs a short "description"/);
    assert.ok(p.includes(`(in ${wp})`) && !p.includes(`(in ${w.repoPaths[0]})`), 'checks are shown in the worktree');
  }
  assert.match(seen.N1, /Do not build behaviour that belongs to other items[\s\S]*Other items still to build \(not yours\):\n- N\.2 export test/);
  assert.equal(run.state.leafEvidence['N.1'].after.sourceChanged, true);
  assert.equal(run.state.leafEvidence['N.2'].after.sourceChanged, false);
  const { leafEvidenceLines, isTestPath } = await import('../lib/engine/report.js');
  const lines = leafEvidenceLines(run.state).join('\n');
  assert.match(lines, /N\.2 export test \[behaviour\]: red → green \(only tests changed: the behaviour was already there\)/);
  assert.doesNotMatch(lines, /N\.1 .*only tests changed/);
  for (const p of ['test/a.js', 'src/a.test.ts', 'ToyTests/ToyTests.swift', '__tests__/x.js', 'pkg/spec/x.rb']) assert.ok(isTestPath(p), p);
  for (const p of ['src/discount.ts', 'index.js', 'CONTEXT.md', 'Toy/App.swift']) assert.ok(!isTestPath(p), p);
});

test('v2-13: every loop start and resume gives the workers write access; if it cannot, the run stops with the reason (R2)', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  let grants = 0;
  let grant = true;
  hub.overrides.setFullAccess = async () => (grants++, grant);
  await w.settleToFinal();
  assert.equal(grants, 1); // jd_prepare
  w.handle().run.set('budget', { tokens: 1500 });
  let run = await runToEnd(w);
  assert.match(run.state.sideReason, /budget reached: tokens/);
  assert.equal(grants, 2);
  const builders = w.calls.spawns.filter((s) => s.role === 'builder').length;
  grant = false;
  await w.rootExec('jd_set', { key: 'budget', value: { tokens: 1e7 } });
  run = await runToEnd(w);
  assert.equal(run.state.side, 'stopped');
  assert.match(run.state.sideReason, /could not give the workers write access.*Full access/);
  assert.equal(w.calls.spawns.filter((s) => s.role === 'builder').length, builders, 'no worker starts without write access');
  grant = true;
  run = await runToEnd(w);
  assert.equal(grants, 4);
  assert.equal(run.state.phase, 'done');
});

test('v2-13: a review fixer that blocks ends the review rounds, and a rolled-back fix is not reviewed again (R2)', async () => {
  const finding = '{"findings":[{"axis":"spec","kind":"missing","requirement":"A1","problem":"glossary entries missing","severity":"high"}],"suggestions":["add a lint step"]}';
  const blocked = makeWorld({ human: false });
  honestBuilders(blocked);
  let reviews = 0;
  blocked.scripts.reviewer = async () => (reviews++, finding);
  blocked.scripts.fixer = async ({ exec }) => exec('jd_block', { what: 'cannot write the worktree', why: 'sandbox', how: 'tried' });
  await blocked.settleToFinal();
  let run = await runToEnd(blocked);
  assert.deepEqual(blocked.calls.spawns.filter((s) => s.role === 'fixer').map((s) => s.checkId), ['RV1']);
  assert.equal(reviews, 1);
  assert.equal(run.state.phase, 'done');

  const broken = makeWorld({ human: false });
  honestBuilders(broken);
  reviews = 0;
  broken.scripts.reviewer = async () => (reviews++, finding);
  broken.scripts.fixer = async ({ run: r }) => fs.writeFileSync(path.join(r.state.settings.repos[0].workPath, 'greet.js'), 'export const greet = () => "nope";\n');
  await broken.settleToFinal();
  run = await runToEnd(broken);
  assert.deepEqual(broken.calls.spawns.filter((s) => s.role === 'fixer').map((s) => s.checkId), ['RV1', 'RV2', 'RV3']);
  assert.equal(reviews, 1, 'each fix was rolled back, so the code never changed and is not reviewed again');
  assert.equal(run.state.phase, 'done');
});

test('v2-13: repo suggestions come from the final review only, not from every round (R2)', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  let reviews = 0;
  w.scripts.reviewer = async () =>
    ++reviews === 1
      ? '{"findings":[{"axis":"standards","problem":"breaks the naming rule","severity":"med"}],"suggestions":["Add ESLint with import/no-default-export"]}'
      : '{"findings":[],"suggestions":["Add a lint script (ESLint, import/no-default-export)"]}';
  w.scripts.fixer = async ({ exec }) => exec('jd_submit', { summary: 'renamed' });
  await w.settleToFinal();
  const run = await runToEnd(w);
  assert.equal(reviews, 2);
  assert.deepEqual(run.state.notes.filter((n) => n.kind === 'suggestion').map((n) => n.text), ['repo1: Add a lint script (ESLint, import/no-default-export)']);
});

test('v2-13: workers are spawned without the tools they never need; the names come from DSH\'s own filter error (R2)', async () => {
  const S = await import('../lib/host/services.js');
  const { hiddenToolsFor } = await import('../lib/profiles/index.js');
  const KNOWN = ['bash', 'read', 'edit', 'jd_submit', 'jd_status', 'plugin_manager', 'cordis_inspect_query', 'ios_build', 'ios_sim_tap', 'mcp__xcode__XcodeRead', 'mcp__xcode__BuildProject', 'mcp__github__create_issue'];
  const starts = [];
  const savedHost = hub.host;
  const savedOv = hub.overrides;
  hub.host = {
    logger: () => console,
    sessionController: { resolveAgent: async () => ({ agent: { id: 'ROOT' } }) },
    subagents: {
      async start(_kind, req) {
        starts.push(req.toolFilter.deny);
        const unknown = req.toolFilter.deny.filter((n) => !KNOWN.includes(n));
        if (unknown.length) throw new Error(`tools.restrict() names unknown global tools ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...KNOWN].sort().join(', ')}`);
        return { id: `child-${starts.length}`, result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }), dispose: async () => {} };
      },
    },
  };
  hub.overrides = { tokensOf: async () => 0 };
  try {
    const h = { key: 'k', rootSessionId: 'ROOT', worker: null };
    const res = await S.spawnWorker(h, { role: 'builder', prompt: 'p', hiddenTools: hiddenToolsFor({ '/r': { profile: 'ts' } }) });
    assert.equal(res.stopReason, 'completed');
    const final = starts.at(-1);
    for (const n of ['jd_status', 'plugin_manager', 'cordis_inspect_query', 'ios_build', 'ios_sim_tap', 'mcp__xcode__XcodeRead', 'mcp__xcode__BuildProject']) assert.ok(final.includes(n), n);
    for (const n of ['bash', 'read', 'edit', 'jd_submit', 'mcp__github__create_issue']) assert.ok(!final.includes(n), n);
    assert.ok(final.every((n) => KNOWN.includes(n)), 'only names DSH can filter');
    const before = starts.length;
    await S.spawnWorker(h, { role: 'builder', prompt: 'p', hiddenTools: hiddenToolsFor({ '/r': { profile: 'ios' } }) });
    assert.equal(starts.length, before + 1, 'the learnt names are reused: one start, no probe');
    assert.ok(!starts.at(-1).some((n) => n.startsWith('ios_')) && starts.at(-1).includes('mcp__xcode__XcodeRead'));
    assert.equal(starts.filter((d) => d.includes('__junior_dev_probe__')).length, 1, 'probed once');
  } finally {
    hub.host = savedHost;
    hub.overrides = savedOv;
  }
});

test('v2-13: the interview proposes the run settings in one question and explains who grants worktree write access', async () => {
  const { nextStep } = await import('../lib/host/prompts.js');
  const { formatQuestion } = await import('../lib/engine/run.js');
  const st = { phase: 'interview', side: null, settings: {} };
  const iv = nextStep(st);
  assert.match(iv, /ONE jd_ask/);
  assert.match(iv, /"Use these settings" \(recommended\) and "Change some"/);
  assert.match(iv, /jd_prepare gives this chat Full access/);
  assert.match(nextStep({ ...st, phase: 'final_parity' }), /jd_prepare gives this chat Full access[^]*no reason to work in place/);
  assert.throws(() => formatQuestion({ id: 'Q1', question: 'ok?', options: ['Use these settings'] }), /"Use these settings" and "Change something"/);
});

test('v2-13: every DSH host service the plugin uses is injected; tool checks run as the root agent and surface tool errors (R3)', async () => {
  const { inject } = await import('../lib/index.js');
  const used = new Set();
  for (const dir of ['lib', 'lib/host', 'lib/engine', 'lib/profiles']) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/hub\.host\.([a-zA-Z]+)/g)) used.add(m[1]);
  }
  for (const name of used) assert.ok(inject.includes(name), `hub.host.${name} is used but "${name}" is not in lib/index.js inject`);

  const S = await import('../lib/host/services.js');
  const calls = [];
  const savedHost = hub.host;
  const savedOv = hub.overrides;
  const root = { id: 'ROOT' };
  hub.host = {
    sessionController: { resolveAgent: async () => ({ agent: root }) },
    tools: { execute: async (exec) => (calls.push(exec), exec.name === 'ios_broken' ? { isError: true, error: { message: 'no booted simulator' }, content: [] } : { isError: false, value: { ok: true } }) },
  };
  hub.overrides = {};
  try {
    const h = { rootSessionId: 'ROOT' };
    assert.deepEqual(await S.executeTool(h, { callId: 'c1', name: 'ios_status', arguments: {}, signal: new AbortController().signal }), { ok: true });
    assert.equal(calls[0].agent, root);
    await assert.rejects(S.executeTool(h, { callId: 'c2', name: 'ios_broken', arguments: {}, signal: new AbortController().signal }), /no booted simulator/);
  } finally {
    hub.host = savedHost;
    hub.overrides = savedOv;
  }
});

test('v2-14: briefs show tool checks in the worktree, the reviewer gets the source → worktree map, and preflight refuses tool checks on a source repo (R3)', async () => {
  const { workerBrief, fixBrief, reviewBrief } = await import('../lib/host/prompts.js');
  const run = { name: 'f', dir: '/s/docs/f', state: { settings: { repos: [{ path: '/src/app', workPath: '/wt/app' }] }, tree: { nodes: {} }, facts: [] } };
  const node = { id: 'N.1', title: 't', goal: 'g', doneWhen: [], traces: { requirements: [] }, checks: [{ id: 'N.1/k1', tool: 'ios_build', arguments: { workspacePath: '/src/app/App.xcworkspace' }, pass: 'ios-build' }], provides: [], uses: [] };
  const wb = workerBrief({ role: 'builder', node, run, contracts: [], workPaths: ['/wt/app'] });
  assert.match(wb, /\/wt\/app\/App\.xcworkspace/);
  assert.doesNotMatch(wb, /\/src\/app\/App\.xcworkspace/);
  const fb = fixBrief({ run, check: { id: 'I1', kind: 'automated', text: 'build', requirementIds: ['A1'], ...node.checks[0] }, output: '', workPaths: ['/wt/app'] });
  assert.match(fb, /Command: [^\n]*\/wt\/app\/App\.xcworkspace/);
  assert.match(reviewBrief({ run, workPaths: ['/wt/app'] }), /\/src\/app → \/wt\/app[^]*not a finding/);

  const w = makeWorld({ repoFiles: () => IOS_FILES, human: false });
  hub.overrides.executeTool = iosTool();
  try {
    await w.settleToFinal().catch(() => {});
    const h = w.handle();
    if (h.run.state.phase !== 'preflight') h.run.store.commit('phase', { from: h.run.state.phase, to: 'preflight' });
    await assert.rejects(
      w.rootExec('jd_preflight', { items: [{ id: 'ios-build', what: 'build works', tool: 'ios_build', arguments: { workspacePath: path.join(w.repoPaths[0], 'App.xcodeproj') }, pass: 'ios-build' }] }),
      /must not run on a source repo \(ios-build\)[^]*readiness check/,
    );
  } finally {
    delete hub.overrides.executeTool;
  }
});

test('v2-14: the root agent is told iOS checks are dsh-ios tool checks run in the worktree, so a source-repo folder grant does not matter (R3)', async () => {
  const { stacksNote } = await import('../lib/profiles/index.js');
  const n = stacksNote({ '/r/app': { profile: 'ios', candidates: ['ios'] }, '/r/core': { profile: 'ts', candidates: ['ts'] } });
  assert.match(n, /dsh-ios tool checks \(ios_build, ios_test\), never xcodebuild[^]*does not matter/);
  assert.doesNotMatch(stacksNote({ '/r/core': { profile: 'ts', candidates: ['ts'] } }), /xcodebuild/);
});

test('v2-14: a regression failure is re-run once before the leaf is rolled back, and a failed launch before the evidence screenshot is only noted (R3)', async () => {
  const w = makeWorld({ human: false });
  honestBuilders(w);
  await w.settleToFinal();
  const run = w.handle().run;
  const cnt = path.join(w.session, 'runs');
  // N.1's check passes after its work, then fails exactly once more: on N.2's regression run
  setLeaf(run, 'N.1', { checks: [{ id: 'N.1/k1', command: `n=$(cat ${cnt} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${cnt}; [ -f greet.js ] || exit 1; [ $n -eq 3 ] && exit 1; exit 0`, cwd: w.repoPaths[0] }] });
  const done = await runToEnd(w);
  assert.equal(done.state.phase, 'done', done.state.sideReason ?? '');
  assert.equal(w.calls.spawns.filter((s) => s.role === 'builder' && s.nodeId === 'N.2').length, 1, 'N.2 was not rolled back');
  assert.ok(done.state.notes.some((n) => n.kind === 'flaky_check' && /N\.1/.test(n.text)));

  const wi = makeWorld({ repoFiles: () => IOS_FILES });
  honestBuilders(wi);
  hub.overrides.executeTool = iosTool({ ios_sim_build_run: () => { throw new Error('tool "ios_sim_build_run" returned invalid output: value is not lossless JSON'); } });
  try {
    await wi.settleToFinal();
    const r = await runToEnd(wi);
    assert.equal(r.state.phase, 'done', r.state.sideReason ?? '');
    const ev = r.state.notes.filter((n) => n.kind === 'human_evidence').map((n) => n.text).join('\n');
    assert.match(ev, /ios_sim_build_run before the screenshot failed[^]*ios_sim_screenshot -> \/tmp\/shots\/after\.png/);
  } finally {
    delete hub.overrides.executeTool;
  }
});

// ---------------------------------------------------------------- X2: independent review 2 (findings 1, 2, 4, 7)
test('X2#1: an iOS test run with zero tests, or only skipped ones, fails the ios-test rule', async () => {
  const { passRuleByName } = await import('../lib/profiles/index.js');
  const rule = passRuleByName('ios-test');
  const r = (o) => rule({ counts: { total: 5, passed: 5, failed: 0, skipped: 0, expectedFailures: 0, notRun: 0, ...o }, failures: [] });
  assert.equal(r({}).ok, true);
  assert.equal(r({ passed: 3, skipped: 2 }).ok, true, 'some skipped is fine while something passed');
  const none = r({ total: 0, passed: 0 });
  assert.equal(none.ok, false);
  assert.match(none.output, /no test passed \(none ran\)/);
  const skipped = r({ passed: 0, skipped: 5 });
  assert.equal(skipped.ok, false);
  assert.match(skipped.output, /no test passed \(5 skipped\)[^]*scheme/);
});

test('X2#2: workers change files only inside the run\'s work paths (and the temp dir); the root agent is not limited', async () => {
  const { bashWriteOutside } = await import('../lib/host/gate.js');
  const inside = (p) => p === '/wt' || p.startsWith('/wt/') || p.startsWith('/dev/') || p.startsWith('/tmp/');
  const out = (c, cwd = '/wt') => bashWriteOutside(c, cwd, inside);
  for (const c of ['npm test 2>&1 | tail -20', 'mkdir -p /wt/src/x', 'cd /wt && npm install', 'sed -n 1,5p /Users/me/x.js', 'find /Users/me -name x',
    'node /usr/local/lib/x.js', 'cp /usr/local/share/x /wt/y', 'curl -s http://localhost:3000/api', 'echo hi >> /tmp/log; ls ~',
    "cat > src/a.ts <<'EOF'\nconst p = \"/users\";\nrm -rf /\nEOF\nnpm test"]) assert.equal(out(c), null, c);
  assert.equal(out('mkdir -p /wt/src/x', '/Users/me/chat'), null, 'absolute paths inside need no workdir');
  for (const [c, bad] of [['rm -rf ~/projects', path.join(process.env.HOME, 'projects')], ['rm -rf ../..', '/'], ['echo x > /etc/hosts', '/etc/hosts'],
    ['cd /Users/me/app && git reset --hard', '/Users/me/app/reset'], ['sed -i "" s/a/b/ /Users/me/x.js', '/Users/me/x.js'], ['cp /wt/a /Users/me/b', '/Users/me/b'],
    ['git -C /Users/me/app commit -am x', '/Users/me/app'], ['tsc --outDir=/Users/me/out', '/Users/me/out'], ['cp /usr/local/bin/x /usr/bin/y', '/usr/bin/y']]) {
    assert.equal(out(c), bad, c);
  }
  assert.equal(out('npm test', '/Users/me/chat'), '/Users/me/chat/test', 'a command run from outside the work paths');
  assert.match(out('npm i -g typescript'), /^npm i -g/);

  const w = makeWorld({ human: false });
  await w.rootExec('jd_start');
  const h = w.handle();
  const wp = path.join(process.env.JD_WORKTREES_ROOT, 'x2-2');
  const home = path.join(process.env.HOME, 'jd-x2-not-here');
  const asWorker = (name, args) => judge({ name, arguments: args, agent: w.worker }, h);
  assert.equal(asWorker('bash', { command: `rm -rf ${home}` }), null, 'no prepared work paths yet: no boundary');
  h.run.set('repos', [{ path: w.repoPaths[0], mode: 'worktree', workPath: wp, branch: 'junior-dev/x' }]);
  assert.match(asWorker('bash', { command: `rm -rf ${home}` })?.reason ?? '', /only inside the run's work paths .*x2-2.*jd-x2-not-here/);
  assert.match(asWorker('write', { path: path.join(home, 'a.js'), content: 'x' })?.reason ?? '', /only inside the run's work paths/);
  assert.match(asWorker('edit', { file_path: path.join(w.repoPaths[0], 'index.js'), old_string: 'a', new_string: 'b' })?.reason ?? '', /only inside/, 'the developer checkout is outside the worktree');
  assert.match(asWorker('bash', { command: 'npm install', workdir: process.env.HOME })?.reason ?? '', /only inside/);
  assert.equal(asWorker('bash', { command: 'npm install', workdir: wp }), null);
  assert.equal(asWorker('write', { path: path.join(wp, 'src', 'a.js'), content: 'x' }), null);
  assert.equal(asWorker('bash', { command: `cd ${wp} && git fetch origin` }), null, 'remote reads in the worktree pass');
  assert.match(asWorker('bash', { command: `echo x >> ${path.join(h.run.dir, 'state', 'events.jsonl')}` })?.reason ?? '', /state is written only by the plugin/, 'the more specific reason wins');
  assert.equal(judge({ name: 'bash', arguments: { command: `rm -rf ${home}` }, agent: w.root }, h), null, 'the root agent is not limited by it');
});

test('X2#4: projects below the repo root are detected; iOS checks name a shared scheme with tests; TS setup installs at the nearest lockfile', async () => {
  const { detectStack, stacksNote, workspaceSetupItems, stackFor } = await import('../lib/profiles/index.js');
  const write = (root, files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); } };
  const scheme = (tests) => `<Scheme><TestAction>${tests ? '<Testables><TestableReference skipped="NO"></TestableReference></Testables>' : '<Testables></Testables>'}</TestAction></Scheme>`;
  const xs = (proj, name) => `${proj}/xcshareddata/xcschemes/${name}.xcscheme`;

  // iOS in ios/, one shared scheme with tests
  const a = tmpdir('jd-x24-');
  write(a, { 'ios/App.xcodeproj/project.pbxproj': '//', [xs('ios/App.xcodeproj', 'App')]: scheme(true), 'node_modules/x/Foo.xcodeproj/project.pbxproj': '//', 'README.md': '' });
  const sa = detectStack(a);
  assert.equal(sa.profile, 'ios');
  assert.deepEqual(sa.dirs, ['ios']);
  assert.deepEqual(sa.checks.map((c) => [c.id, c.arguments]), [['build', { workspacePath: path.join(a, 'ios/App.xcodeproj'), scheme: 'App' }], ['test', { workspacePath: path.join(a, 'ios/App.xcodeproj'), scheme: 'App' }]]);
  assert.match(stacksNote({ [a]: sa }, { withChecks: true }), /: ios in ios\n/);

  // several schemes: the one named after the project wins for the build; tests use the one scheme that has them
  const b = tmpdir('jd-x24-');
  write(b, { 'App.xcodeproj/project.pbxproj': '//', [xs('App.xcodeproj', 'App')]: scheme(false), [xs('App.xcodeproj', 'AppTests')]: scheme(true), [xs('App.xcodeproj', 'Widget')]: scheme(false) });
  assert.deepEqual(detectStack(b).checks.map((c) => c.arguments.scheme), ['App', 'AppTests']);
  // several schemes and none named after the project: no guess, a note for the root
  const c = tmpdir('jd-x24-');
  write(c, { 'App.xcodeproj/project.pbxproj': '//', [xs('App.xcodeproj', 'Prod')]: scheme(true), [xs('App.xcodeproj', 'Staging')]: scheme(true) });
  const sc = detectStack(c);
  assert.ok(sc.checks.every((k) => !k.arguments.scheme));
  assert.match(stacksNote({ [c]: sc }, { withChecks: true }), /build: `tool:ios_build [^`]*` \[several shared schemes \(Prod, Staging\): settle the scheme/);
  // shared schemes without tests: no test check is offered, and the note says why
  const d = tmpdir('jd-x24-');
  write(d, { 'App.xcodeproj/project.pbxproj': '//', [xs('App.xcodeproj', 'App')]: scheme(false) });
  const sd = detectStack(d);
  assert.deepEqual(sd.checks.map((k) => k.id), ['build']);
  assert.match(sd.checks[0].note, /no shared scheme has tests/);

  // a TS monorepo: packages below the root, lockfile at the root
  const e = tmpdir('jd-x24-');
  const pkg = JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { zod: '1' } });
  write(e, { 'package.json': '{"workspaces":["packages/*"]}', 'package-lock.json': '{}', 'packages/api/package.json': pkg, 'packages/api/tsconfig.json': '{}', 'packages/web/package.json': pkg, 'packages/web/tsconfig.json': '{}' });
  const se = detectStack(e);
  assert.equal(se.profile, 'ts');
  assert.deepEqual(se.dirs, [path.join('packages', 'api'), path.join('packages', 'web')]);
  assert.deepEqual(se.checks.map((k) => [k.id, k.command, k.cwd]), [['test@packages/api', 'npm test', path.join(e, 'packages/api')], ['test@packages/web', 'npm test', path.join(e, 'packages/web')]]);
  assert.deepEqual(workspaceSetupItems({ [e]: se }, e, e).map((i) => [i.command, i.cwd]), [['npm ci', undefined]], 'one install, at the root lockfile');
  fs.rmSync(path.join(e, 'package-lock.json'));
  assert.deepEqual(workspaceSetupItems({ [e]: se }, e, e).map((i) => [i.id, i.cwd]), [['deps@packages/api', path.join(e, 'packages/api')], ['deps@packages/web', path.join(e, 'packages/web')]]);

  // iOS and a BFF in one repo: ambiguous, and the developer's answer keeps the folders
  const f = tmpdir('jd-x24-');
  write(f, { 'ios/App.xcodeproj/project.pbxproj': '//', 'bff/package.json': pkg, 'bff/tsconfig.json': '{}' });
  const sf = detectStack(f);
  assert.equal(sf.profile, null);
  assert.deepEqual(sf.candidates.sort(), ['ios', 'ts']);
  assert.match(stacksNote({ [f]: sf }), /ambiguous \((ios in ios or ts in bff|ts in bff or ios in ios)\)/);
  const picked = stackFor(f, sf, 'ts');
  assert.deepEqual([picked.profile, picked.dirs, picked.checks[0].cwd], ['ts', ['bff'], path.join(f, 'bff')]);
});

test('X2#7: a hand check whose screenshot could not be captured says it is unverified by screenshot', async () => {
  const w = makeWorld({ repoFiles: () => IOS_FILES });
  honestBuilders(w);
  const asks = [];
  const innerAsk = hub.overrides.ask;
  hub.overrides.ask = (h, qs) => { asks.push(...qs); return innerAsk(h, qs); };
  hub.overrides.executeTool = iosTool({ ios_sim_screenshot: () => { throw new Error('no booted simulator'); } });
  try {
    await w.settleToFinal();
    const run = await runToEnd(w);
    assert.equal(run.state.phase, 'done', run.state.sideReason ?? '');
    const hc = asks.find((q) => q.id === 'HC:H1');
    assert.match(hc.detail, /Unverified by screenshot: ios: no screenshot could be captured \(no booted simulator\)/);
    assert.doesNotMatch(hc.detail, /Evidence:/);
  } finally {
    delete hub.overrides.executeTool;
  }
  // a launch that failed before a captured screenshot is said in the evidence itself
  const wi = makeWorld({ repoFiles: () => IOS_FILES });
  honestBuilders(wi);
  const asks2 = [];
  const innerAsk2 = hub.overrides.ask;
  hub.overrides.ask = (h, qs) => { asks2.push(...qs); return innerAsk2(h, qs); };
  hub.overrides.executeTool = iosTool({ ios_sim_build_run: () => { throw new Error('launch failed'); } });
  try {
    await wi.settleToFinal();
    await runToEnd(wi);
    assert.match(asks2.find((q) => q.id === 'HC:H1').detail, /Evidence: ios screenshot \/tmp\/shots\/after\.png \(it may not show the new build: ios_sim_build_run failed\)/);
  } finally {
    delete hub.overrides.executeTool;
  }
});
