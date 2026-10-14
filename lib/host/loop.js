// S23: the background loop. Code, not an LLM, drives build → verify → human checks → deliver.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as G from '../engine/git.js';
import { runCheck } from '../engine/checks.js';
import { next, situation, actionFor } from '../engine/scheduler.js';
import { exceeded } from '../engine/budget.js';
import * as Locks from '../engine/locks.js';
import { pause as pausePhase } from '../engine/phases.js';
import { ending } from '../engine/report.js';
import { LEAF_KINDS } from '../engine/tree.js';
import { hub, register } from './hub.js';
import * as S from './services.js';
import { RED_FIRST_ANSWERS } from '../engine/run.js';
import { guidanceFor, hiddenToolsFor } from '../profiles/index.js';
import { workerBrief, fixBrief, reviewBrief, DEBUG_TAG } from './prompts.js';

const RETRY_ASK_MS = () => Number(process.env.JD_RETRY_ASK_MS ?? 30000);

const repos = (run) => run.state.settings.repos ?? [];
const workPaths = (run) => repos(run).map((r) => r.workPath ?? r.path);

function heads(run) {
  return Object.fromEntries(repos(run).map((r) => [r.workPath, G.head(r.workPath)]));
}

function rollbackAll(run, bases) {
  for (const r of repos(run)) G.rollback(r.workPath, bases?.[r.workPath] ?? 'HEAD');
}

/** v2-04: a reason when any work path still has a tagged debug line in its diff, else null. */
function debugLines(run) {
  const hits = repos(run).flatMap((r) => G.taggedLines(r.workPath, DEBUG_TAG).map((l) => `${path.basename(r.workPath)}: ${l.slice(0, 160)}`));
  return hits.length ? `the diff still has ${hits.length} debug line(s) tagged ${DEBUG_TAG}; remove every tagged debug line and resubmit:\n${hits.slice(0, 10).join('\n')}` : null;
}

function commitAllRepos(run, message) {
  const out = [];
  for (const r of repos(run)) {
    const sha = G.commitAll(r.workPath, message);
    if (sha) out.push({ repo: r.workPath, sha });
  }
  return out;
}

export function resolveCwd(run, cwd) {
  const rs = repos(run);
  const first = rs[0]?.workPath ?? run.sessionFolder;
  if (!cwd) return first;
  const hit = rs.find((r) => path.resolve(r.path) === path.resolve(cwd) || path.resolve(r.workPath) === path.resolve(cwd));
  if (hit) return hit.workPath;
  // a path inside a repo maps into its work path
  for (const r of rs) {
    const rel = path.relative(r.path, cwd);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(r.workPath, rel);
  }
  return path.isAbsolute(cwd) ? cwd : path.resolve(first, cwd);
}

const headOfFirst = (run) => (repos(run)[0] ? G.head(repos(run)[0].workPath) : null);

/** The one place the loop runs a check (leaf, regression, verify, fix) and gets its evidence back. */
async function runCheckOf(h, c) {
  return runCheck({ command: c.command, cwd: resolveCwd(h.run, c.cwd) }, { signal: h.abort?.signal });
}

async function runNodeChecks(h, node) {
  const out = [];
  for (const c of node.checks) {
    const r = await runCheckOf(h, c);
    out.push({ checkId: c.id, ok: r.ok, output: r.output, commit: headOfFirst(h.run) });
  }
  return out;
}

/** Regression: re-run the checks of every other done leaf (deduplicated). */
async function regression(h, exceptId) {
  const seen = new Set();
  for (const n of Object.values(h.run.state.tree.nodes)) {
    if (n.id === exceptId || n.status !== 'done' || n.kind === 'branch') continue;
    for (const c of n.checks) {
      const k = `${c.command}@@${resolveCwd(h.run, c.cwd)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const r = await runCheckOf(h, c);
      if (!r.ok) return { ok: false, output: `regression in ${n.id} (${c.command}):\n${r.output}` };
    }
  }
  return { ok: true };
}

function usage(h, tokens, ms, nodeId) {
  h.run.usage({ tokens: tokens ?? 0, activeMs: ms, nodeId });
}

function heartbeatAll(h) {
  for (const r of repos(h.run)) Locks.heartbeat(r.path, { feature: h.run.lockKey, sessionId: h.rootSessionId });
}

function releaseAll(h) {
  for (const r of repos(h.run)) Locks.release(r.path, { feature: h.run.lockKey });
}

/**
 * Crash recovery: a worker that never ended is rolled back to the base commits recorded when it
 * started (so a commit made before its checks were recorded is undone too), and its item goes back to ready.
 */
function recover(h) {
  const run = h.run;
  const open = run.state.workers.filter((w) => !w.endedAt && w.bases);
  const inflight = Object.values(run.state.tree.nodes).filter((n) => ['working', 'submitted', 'checking'].includes(n.status));
  if (open.length === 0 && inflight.length === 0) return;
  const bases = open.at(-1)?.bases ?? null;
  for (const r of repos(run)) {
    try {
      G.rollback(r.workPath, bases?.[r.workPath] ?? 'HEAD');
    } catch (e) {
      run.note('recovery', `could not clean ${r.workPath}: ${e.message}`);
    }
  }
  for (const w of open) run.workerEnd(w.id, 'interrupted');
  for (const n of inflight) run.tree('abandon', n.id, 'interrupted (crash or restart); restarted from the last checkpoint', { countAttempt: false });
  run.note('recovery', `rolled back to the last proven commit; recovered ${[...inflight.map((n) => n.id), ...open.filter((w) => !w.nodeId).map((w) => w.checkId ?? w.role)].join(', ') || 'workspace'}`);
}

async function sleep(ms, signal) {
  await new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** Ask a batch; if no browser is connected, wait and retry (the budget still applies). */
async function askBatch(h, questions) {
  for (;;) {
    try {
      return await S.ask(h, questions);
    } catch (e) {
      const code = e?.code ?? e?.name ?? '';
      if (h.abort?.signal.aborted) throw e;
      if (/NO_PROVIDER|CALLER_NOT_LIVE|ASK_CANCELLED/.test(String(code) + e.message)) {
        h.run.note('waiting', `waiting for the developer to open the chat (${code || e.message})`);
        await sleep(RETRY_ASK_MS(), h.abort?.signal);
        if (exceeded(h.run.state).length) throw new Error('budget reached while waiting for answers');
        continue;
      }
      throw e;
    }
  }
}

function lastFailure(node) {
  const fails = node.evidence.filter((e) => !e.ok);
  return fails.length ? fails.slice(-2).map((e) => `${e.checkId}: ${e.output}`).join('\n').slice(-4000) : null;
}

async function work(h, node, role, { replan = false } = {}) {
  const run = h.run;
  const model = run.state.settings.models?.[role];
  const bases = heads(run);
  const workerId = run.workerStart({ role, model, nodeId: node.id, bases });
  const claimed = run.tree('claim', node.id, workerId);
  if (!claimed.ok) throw new Error(`claim ${node.id}: ${claimed.reasons.join('; ')}`);
  h.worker = { id: workerId, nodeId: node.id, childId: null, bases };
  const contracts = [...node.provides, ...node.uses].map((c) => run.state.tree.contracts[c]).filter(Boolean);
  const stacks = run.state.settings.stacks;
  const touched = repos(run).filter((r) => node.checks.some((c) => c.cwd && [r.path, r.workPath].some((p) => p && (c.cwd === p || c.cwd.startsWith(`${p}/`))))).map((r) => r.path);
  const prompt = workerBrief({ role, node, run, contracts, workPaths: workPaths(run), failure: lastFailure(node), stackGuidance: guidanceFor(stacks, touched) });
  const t0 = Date.now();
  let res;
  try {
    res = await S.spawnWorker(h, { role, prompt, model, signal: h.abort?.signal, hiddenTools: hiddenToolsFor(stacks) });
  } catch (e) {
    res = { stopReason: 'error', text: e.message, tokens: 0 };
  } finally {
    h.worker = null;
  }
  run.workerEnd(workerId, res.stopReason);
  usage(h, res.tokens, Date.now() - t0, node.id);
  if (S.isQuotaStop(res)) {
    // the subscription is used up: undo this attempt, don't count it, stop the run until it resets
    rollbackAll(run, bases);
    if (['working', 'submitted', 'checking'].includes(run.state.tree.nodes[node.id].status)) run.tree('abandon', node.id, 'subscription limit reached', { countAttempt: false });
    h.quotaStop = String(res.text || res.diagnostic || 'subscription limit').slice(0, 300);
    return;
  }

  let cur = run.state.tree.nodes[node.id];
  if (cur.status === 'working') {
    if (replan) {
      // red-first replan: the planner either rewrote the check (jd_set_checks) or ended; the item goes back to ready
      rollbackAll(run, bases);
      run.tree('abandon', node.id, 'red-first replan finished', { countAttempt: false });
      return;
    }
    if (role === 'planner' || res.stopReason !== 'completed') {
      rollbackAll(run, bases);
      run.tree('abandon', node.id, role === 'planner' ? 'planner ended without splitting' : `worker ended: ${res.stopReason}${res.text ? ` — ${res.text.slice(0, 300)}` : ''}`);
      return;
    }
    run.tree('submit', node.id, {}); // implicit submit
    cur = run.state.tree.nodes[node.id];
  }
  if (cur.status === 'submitted') {
    run.tree('startChecks', node.id);
    let results = await runNodeChecks(h, cur);
    const tagged = results.length > 0 && results.every((r) => r.ok) ? debugLines(run) : null;
    if (tagged) results = [{ checkId: 'debug-tag', ok: false, output: tagged, commit: headOfFirst(run) }];
    if (LEAF_KINDS.includes(cur.leafKind)) run.leafAfter(node.id, { ok: results.length > 0 && results.every((r) => r.ok), output: summarise(results), commit: headOfFirst(run) });
    if (results.length && results.every((r) => r.ok)) {
      const commits = commitAllRepos(run, `jd(${node.id}): ${node.title}`);
      const reg = await regression(h, node.id);
      if (!reg.ok) {
        rollbackAll(run, bases);
        results = [...results, { checkId: 'regression', ok: false, output: reg.output, commit: headOfFirst(run) }];
      } else {
        results = results.map((r) => ({ ...r, commit: commits[0]?.sha ?? r.commit }));
      }
    } else {
      rollbackAll(run, bases);
    }
    run.tree('recordChecks', node.id, results);
    return;
  }
  // split, parked or blocked: no code from this attempt is kept
  rollbackAll(run, bases);
}

const summarise = (rs) => rs.map((r) => `${r.checkId}: ${r.ok ? 'pass' : 'fail'}${r.output ? ` ${String(r.output).slice(-300)}` : ''}`).join('\n');

/**
 * v2-03 red-first: run the leaf's checks before any builder. A behaviour leaf must be red, a refactor
 * leaf green. Returns true when the builder may start.
 */
async function redFirst(h, node) {
  const run = h.run;
  if (!LEAF_KINDS.includes(node.leafKind)) return true; // a run started before kinds existed
  const rs = await runNodeChecks(h, node);
  const green = rs.length > 0 && rs.every((r) => r.ok);
  run.leafBefore(node.id, node.leafKind, { ok: green, output: summarise(rs), commit: headOfFirst(run) });
  const ev = run.state.leafEvidence[node.id];
  const wantGreen = node.leafKind === 'refactor';
  if (green === wantGreen) return true;
  if (wantGreen) {
    if (ev.parks > 0) return true; // the developer has already answered the question about this leaf
    run.parkLeaf(node.id, `${node.id} "${node.title}" is a refactor leaf, but its checks already fail before any work, so they cannot show that behaviour stays the same. Fix the failing check or tell me how to proceed.\n${summarise(rs).slice(-600)}`, ['Build it anyway']);
    return false;
  }
  if (ev.replans === 0) {
    run.leafReplan(node.id);
    await work(h, node, 'planner', { replan: true });
    return false;
  }
  run.parkLeaf(node.id, `${node.id} "${node.title}" is a behaviour leaf, but its check already passes before any work, even after the planner rewrote it, so it proves nothing. Is the check fine because the work is already done, should the check be rewritten, or should the leaf be dropped?`, [RED_FIRST_ANSWERS.rewrite, RED_FIRST_ANSWERS.done, RED_FIRST_ANSWERS.drop], { redFirst: true });
  return false;
}

async function buildStep(h) {
  const run = h.run;
  const node = next(run.state.tree);
  if (!node) {
    const sit = situation(run.state.tree);
    if (sit === 'stuck') {
      const open = run.openQueue();
      const answers = await askBatch(h, open.map((q) => queuedQuestion(q)));
      run.answerQueued(answers.map((a) => ({ id: a.id.replace(/^QQ:/, ''), answer: S.answerText(a) })));
      return;
    }
    if (sit === 'busy') {
      recover(h);
      return;
    }
    if (sit === 'done' || sit === 'resolved') {
      const r = run.advance('verify');
      if (!r.ok) await end(h, 'stopped', `cannot start verification: ${r.reasons.join('; ')}`);
      return;
    }
    await end(h, 'blocked', 'nothing can move: every remaining item waits on something that cannot finish');
    return;
  }
  const action = actionFor(node);
  if (action === 'integrate' || action === 'recheck') {
    run.tree('startChecks', node.id);
    const results = await runNodeChecks(h, run.state.tree.nodes[node.id]);
    run.tree('recordChecks', node.id, results);
    return;
  }
  if (action === 'build' && !(await redFirst(h, node))) return;
  await work(h, node, action === 'plan' ? 'planner' : 'builder');
}

function queuedQuestion(q) {
  return {
    id: `QQ:${q.id}`,
    question: q.text,
    header: 'junior-dev',
    detail: q.nodeId ? `Item ${q.nodeId} is waiting on this.` : undefined,
    options: (q.options ?? []).slice(0, 4).map((o) => ({ label: String(o) === String(q.recommended) ? `${o} (Recommended)` : String(o) })),
  };
}

const interrupted = (h) => Boolean(h.pauseRequested || h.quotaStop || h.abort?.signal.aborted || exceeded(h.run.state).length);
const automated = (run) => Object.values(run.state.checks).filter((c) => c.kind === 'automated');
const lastOk = (c) => c.results.at(-1)?.ok === true;
const hasBlocker = (run, checkId) => run.state.blockers.some((b) => b.checkId === checkId);

/** Run (and record) the automated VP checks on the current commit; returns the failing ones. */
async function runVp(h, ids) {
  const run = h.run;
  const failing = [];
  for (const c of automated(run)) {
    if (ids && !ids.includes(c.id)) continue;
    const r = await runCheckOf(h, c);
    run.recordCheck(c.id, { ok: r.ok, output: r.output, commit: headOfFirst(run) });
    if (!r.ok) failing.push({ ...c, output: r.output });
  }
  return failing;
}

/**
 * One fix round (S11): a fixer works on the failure; its change is kept (committed, results recorded)
 * only if the target check now passes and no automated check that passed before fails. Otherwise it
 * is rolled back and nothing is recorded. Returns { kept, output }.
 */
async function tryFix(h, { check, output }) {
  const run = h.run;
  const model = run.state.settings.models?.builder;
  const bases = heads(run);
  const passedBefore = new Set(automated(run).filter(lastOk).map((c) => c.id));
  const notesBefore = run.state.notes.length;
  const workerId = run.workerStart({ role: 'fixer', model, nodeId: null, checkId: check.id, bases });
  h.worker = { id: workerId, nodeId: null, checkId: check.id, childId: null, bases };
  const t0 = Date.now();
  let res;
  try {
    res = await S.spawnWorker(h, { role: 'fixer', prompt: fixBrief({ run, check, output, workPaths: workPaths(run) }), model, signal: h.abort?.signal });
  } catch (e) {
    res = { stopReason: 'error', text: e.message, tokens: 0 };
  } finally {
    h.worker = null;
  }
  run.workerEnd(workerId, res.stopReason);
  usage(h, res.tokens, Date.now() - t0, null);
  if (S.isQuotaStop(res)) {
    rollbackAll(run, bases);
    h.quotaStop = String(res.text || res.diagnostic || 'subscription limit').slice(0, 300);
    run.store.commit('check_attempt', { id: check.id, delta: -1 }); // this round does not count
    return { kept: false, output: 'subscription limit reached', quota: true };
  }
  if (res.stopReason !== 'completed') {
    rollbackAll(run, bases);
    return { kept: false, output: `fixer ended: ${res.stopReason}` };
  }
  const results = [];
  for (const c of automated(run)) {
    const r = await runCheckOf(h, c);
    results.push({ c, r });
  }
  const target = results.find((x) => x.c.id === check.id);
  const broke = results.filter((x) => passedBefore.has(x.c.id) && !x.r.ok).map((x) => x.c.id);
  if ((target && !target.r.ok) || broke.length) {
    rollbackAll(run, bases);
    const why = [target && !target.r.ok ? target.r.output : '', broke.length ? `the fix broke ${broke.join(', ')}` : ''].filter(Boolean).join('\n');
    return { kept: false, output: why.slice(-4000) };
  }
  const tagged = debugLines(run);
  if (tagged) {
    rollbackAll(run, bases);
    return { kept: false, output: tagged };
  }
  const rootCause = run.state.notes.slice(notesBefore).findLast((n) => n.kind === 'root_cause')?.text;
  commitAllRepos(run, `jd(fix ${check.id}): ${String(check.text ?? '').slice(0, 60)}${rootCause ? `\n\nRoot cause: ${rootCause}` : ''}`);
  const head = headOfFirst(run);
  for (const { c, r } of results) run.recordCheck(c.id, { ok: r.ok, output: r.output, commit: head });
  return { kept: true, output: '' };
}

/** Returns 'interrupted' when a pause or the budget stopped it mid-way (the loop top handles it). */
async function verifyPhase(h) {
  const run = h.run;
  const cap = run.state.settings.fixCap ?? 3;
  const failing = await runVp(h);
  for (const f of failing) {
    if (hasBlocker(run, f.id)) continue;
    let out = f.output;
    let fixed = false;
    while (!fixed && (run.state.checks[f.id].attempts ?? 0) < cap) {
      if (interrupted(h)) return 'interrupted';
      run.checkAttempt(f.id);
      const r = await tryFix(h, { check: run.state.checks[f.id], output: out });
      fixed = r.kept;
      out = r.output || out;
      // a fixer that logged a blocker for this check has explained why it cannot be fixed: no more rounds
      if (!fixed && hasBlocker(run, f.id)) break;
    }
    if (!fixed && !hasBlocker(run, f.id)) run.blocker({ checkId: f.id, what: `check ${f.id} still fails after ${cap} fix rounds`, why: out.slice(-600), how: 'verification run', fixes: [] });
  }

  // Review runs once per repo, always (v2 ticket 05): standards and spec findings stay apart.
  if (!run.state.notes.some((n) => n.kind === 'review_done')) {
    let left = 0;
    for (const r of repos(run)) {
      let findings = await review(h, r);
      for (let round = 1; findings.some(fixable) && round <= cap; round++) {
        if (interrupted(h)) return 'interrupted';
        const todo = findings.filter(fixable);
        const pseudo = { id: `RV${round}`, kind: 'automated', text: 'review findings', requirementIds: [...new Set(todo.map((f) => f.requirement).filter(Boolean))] };
        await tryFix(h, { check: pseudo, output: JSON.stringify(todo, null, 2) });
        findings = await review(h, r);
      }
      const who = reviewModel(run);
      for (const f of findings) {
        const label = f.axis === 'standards' ? 'standards' : `spec, ${f.kind}`;
        run.note(f.axis === 'standards' ? 'review_standards' : 'review_spec', `${path.basename(r.path)}: (${f.severity ?? 'n/a'}${f.axis === 'standards' ? '' : `, ${f.kind}`}) ${f.problem} [requirement ${f.requirement ?? '?'}${f.where ? ` at ${f.where}` : ''}]`);
        if (f.kind === 'scope creep') continue; // reported, never fixed, never blocking
        run.blocker({ what: `review finding (${label}; ${f.severity ?? 'n/a'}): ${f.problem}`, why: `requirement ${f.requirement ?? '?'}${f.where ? ` at ${f.where}` : ''}`, how: `review by ${who.provider}/${who.model}`, fixes: [] });
      }
      left += findings.length;
    }
    run.note('review_done', `${left} finding(s) left`);
  }
  // the final state is checked on the final commit; anything still failing is logged, never silent
  for (const f of await runVp(h)) {
    if (!hasBlocker(run, f.id)) run.blocker({ checkId: f.id, what: `check ${f.id} fails on the final commit`, why: f.output.slice(-600), how: 'final verification run', fixes: [] });
  }
  const r = run.advance('human_checks', { headCommit: () => headOfFirst(run) });
  if (!r.ok) await end(h, 'stopped', `cannot leave verification: ${r.reasons.join('; ')}`);
  return 'ok';
}

/** The reviewer is the cross-model one when enabled, otherwise the checker model. */
const reviewModel = (run) => (run.state.settings.crossModel?.enabled ? run.state.settings.crossModel.model : run.state.settings.models?.checker);
/** Standards and spec "missing"/"wrong" findings go to the fix loop; scope creep (and an unusable review) do not. */
const fixable = (f) => f.axis === 'standards' || (f.axis === 'spec' && f.kind !== 'scope creep' && f.kind !== 'unusable');

/** The repo's own standards files, found by code so the reviewer need not hunt for them. */
function standardsFiles(dir) {
  const found = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const n of names.sort()) if (/^(CLAUDE\.md|AGENTS\.md)$|^(CONTRIBUTING|CODING_STANDARDS)/i.test(n) && fs.statSync(path.join(dir, n)).isFile()) found.push(n);
  try {
    if (fs.statSync(path.join(dir, 'docs', 'adr')).isDirectory()) found.push('docs/adr/');
  } catch {
    // no ADR folder
  }
  return found;
}

async function review(h, repo) {
  const run = h.run;
  const model = reviewModel(run);
  let diffStat = '';
  try {
    diffStat = G.git(repo.workPath, ['diff', '--stat', `${repo.baseRef}..HEAD`]);
  } catch {
    diffStat = '';
  }
  const workerId = run.workerStart({ role: 'reviewer', model, nodeId: null });
  h.worker = { id: workerId, nodeId: null, childId: null, reviewer: true };
  const t0 = Date.now();
  let res;
  try {
    res = await S.spawnWorker(h, { role: 'reviewer', prompt: reviewBrief({ run, workPaths: [repo.workPath], diffStat, standardsFiles: standardsFiles(repo.workPath) }), model, signal: h.abort?.signal });
  } catch (e) {
    res = { stopReason: 'error', text: e.message, tokens: 0 };
  } finally {
    h.worker = null;
  }
  run.workerEnd(workerId, res.stopReason);
  usage(h, res.tokens, Date.now() - t0, null);
  if (S.isQuotaStop(res)) {
    h.quotaStop = String(res.text || res.diagnostic || 'subscription limit').slice(0, 300);
    return [];
  }
  const m = res.text?.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(m?.[0] ?? '{}');
    if (!Array.isArray(parsed.findings)) throw new Error('no findings list');
    return parsed.findings.map((f) => ({ ...f, axis: f.axis === 'standards' ? 'standards' : 'spec', kind: f.axis === 'standards' ? undefined : /scope/i.test(f.kind ?? '') ? 'scope creep' : /wrong/i.test(f.kind ?? '') ? 'wrong' : 'missing' }));
  } catch {
    run.note('review', `reviewer answer was not usable JSON (${res.stopReason}): ${String(res.text).slice(0, 300)}`);
    return [{ axis: 'spec', kind: 'unusable', requirement: null, problem: 'the reviewer did not return a usable review', severity: 'med' }];
  }
}

async function humanPhase(h) {
  const run = h.run;
  const cap = run.state.settings.fixCap ?? 3;
  const human = Object.values(run.state.checks).filter((c) => c.kind === 'human' && c.results.length === 0);
  const queued = run.openQueue();
  if (human.length || queued.length) {
    const where = repos(run).map((r) => `${r.workPath} (branch ${r.branch})`).join(', ');
    const questions = [
      ...human.map((c) => ({
        id: `HC:${c.id}`,
        question: `Hand check ${c.id}: ${c.text || 'see the verification plan'} — does it pass?`,
        header: c.id,
        detail: `Proves ${c.requirementIds.join(', ')}. The code is in ${where}.`,
        options: [{ label: 'Pass' }, { label: 'Fail', description: 'add a note saying what is wrong' }],
      })),
      ...queued.map((q) => queuedQuestion(q)),
    ];
    const answers = await askBatch(h, questions);
    for (const a of answers) {
      if (a.id.startsWith('HC:')) {
        const id = a.id.slice(3);
        const ok = a.selected.some((s) => /^pass/i.test(s));
        run.recordCheck(id, { ok, output: a.custom ?? (ok ? 'pass' : 'fail'), by: 'developer', commit: headOfFirst(run) });
      } else if (a.id.startsWith('QQ:')) {
        run.answerQueued([{ id: a.id.slice(3), answer: S.answerText(a) }]);
      }
    }
  }
  // F4: failed hand checks are derived from the store (so a crash here loses nothing) and fixed, not re-presented
  const handled = new Set(run.state.notes.filter((n) => n.kind === 'human_fix').map((n) => n.text.split(':')[0]));
  for (const c of Object.values(run.state.checks)) {
    if (c.kind !== 'human' || c.results.at(-1)?.ok !== false || handled.has(c.id)) continue;
    if (interrupted(h)) return 'interrupted';
    const note = c.results.at(-1).output ?? 'failed';
    let fixed = false;
    let out = `The developer marked this hand check as failed: ${note}`;
    for (let i = 0; i < cap && !fixed; i++) {
      run.checkAttempt(c.id);
      const r = await tryFix(h, { check: c, output: out });
      fixed = r.kept;
      out = r.output || out;
      if (!fixed && hasBlocker(run, c.id)) break;
    }
    run.note('human_fix', `${c.id}: ${fixed ? 'a fix was committed and every automated check still passes (not re-checked by hand)' : `not fixed after ${cap} tries`}`);
    if (!fixed) run.blocker({ checkId: c.id, what: `hand check ${c.id} failed and was not fixed`, why: note, how: 'developer hand check', fixes: [] });
  }
  const r = run.advance('deliver');
  if (!r.ok) await end(h, 'stopped', `cannot deliver: ${r.reasons.join('; ')}`);
  return 'ok';
}

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function deliverPhase(h) {
  const run = h.run;
  const p = run.state.settings.permissions ?? {};
  const summary = run.writeReport();
  const pushed = [];
  for (const r of repos(run)) {
    if (p.push) {
      try {
        sh(r.workPath, 'git', ['push', '-u', 'origin', `${r.branch}:${r.branch}`]);
        run.store.commit('delivery', { branch: { repo: r.path, name: r.branch, pushed: true } });
        pushed.push(r);
      } catch (e) {
        run.store.commit('delivery', { branch: { repo: r.path, name: r.branch, pushed: false } });
        run.blocker({ what: `push of ${r.branch} in ${r.path} failed`, why: String(e.stderr || e.message).slice(-400), how: 'deliver', fixes: ['check the remote and credentials, then push the branch by hand'] });
      }
    } else {
      run.store.commit('delivery', { branch: { repo: r.path, name: r.branch, pushed: false } });
    }
  }
  if (p.pr) {
    const prs = [];
    for (const r of pushed) {
      try {
        const body = prBody(run, summary, []);
        const args = ['pr', 'create', '--head', r.branch, '--title', `${run.name}: ${firstLine(run)}`, '--body', body];
        if (r.baseBranch) args.push('--base', r.baseBranch);
        const url = sh(r.workPath, 'gh', args).split('\n').pop();
        prs.push({ repo: r, url });
        run.store.commit('delivery', { pr: { repo: r.path, url } });
      } catch (e) {
        run.blocker({ what: `opening a PR for ${r.branch} in ${r.path} failed`, why: String(e.stderr || e.message).slice(-400), how: 'deliver', fixes: ['open the PR by hand with gh pr create'] });
      }
    }
    if (prs.length > 1) {
      for (const pr of prs) {
        try {
          sh(pr.repo.workPath, 'gh', ['pr', 'edit', pr.url, '--body', prBody(run, summary, prs.filter((x) => x !== pr).map((x) => x.url))]);
        } catch (e) {
          run.note('deliver', `could not cross-link ${pr.url}: ${e.message}`);
        }
      }
    }
  }
  run.writeReport();
  releaseAll(h);
  const r = run.advance('done');
  if (!r.ok) {
    await end(h, 'stopped', `delivery incomplete: ${r.reasons.join('; ')}`);
    return;
  }
  await end(h, null);
}

function firstLine(run) {
  return run.prdText().split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 60) ?? run.name;
}

/** PR body: no doc files, only the outcome and the requirement table (G1). */
function prBody(run, report, related) {
  const keep = report.split('\n## ').filter((s) => /^(What was built|Red-first evidence|Requirement → check → result|Review|Blockers)/.test(s));
  return [`Delivered by junior-dev for **${run.name}**.`, related.length ? `\nRelated PRs: ${related.join(', ')}` : '', ...keep.map((s) => `\n## ${s}`)].join('\n');
}

async function end(h, side, reason) {
  const run = h.run;
  if (side && run.state.side !== side) run.store.commit('side', { side, reason });
  const report = run.writeReport();
  if (side) releaseAll(h);
  await S.restoreAccess(h);
  if (h.rootSessionId) register(h.rootSessionId, run); // drops the entry once the run is done
  await S.notifyRoot(h, `[junior-dev] The run "${run.name}" ended: ${ending(run.state)}. Relay this report to the developer in full:\n\n${report}`);
}

async function loop(h) {
  const run = h.run;
  recover(h);
  for (;;) {
    if (h.abort?.signal.aborted) return;
    const st = run.state;
    if (h.pauseRequested) {
      const reason = h.pauseRequested;
      h.pauseRequested = null;
      const r = pausePhase(run.store, reason);
      if (r.ok) {
        run.writeReport();
        await S.notifyRoot(h, `[junior-dev] Paused at a checkpoint for your change: "${reason}". Settle it with the developer, update the documents, then call jd_resettle and jd_run.`);
        return;
      }
      await S.notifyRoot(h, `[junior-dev] Could not pause now (${r.reasons.join('; ')}). The run continues; the change can be made after delivery.`);
    }
    if (st.side) return;
    if (h.quotaStop) {
      const why = h.quotaStop;
      h.quotaStop = null;
      await end(h, 'stopped', `subscription limit reached — no extra credits were used. Resume with jd_run after the limit resets. (${why})`);
      return;
    }
    const over = exceeded(st);
    if (over.length) {
      await end(h, 'stopped', `budget reached: ${over.join('; ')}`);
      return;
    }
    heartbeatAll(h);
    switch (st.phase) {
      case 'final_parity': {
        const r = run.advance('build');
        if (!r.ok) {
          await end(h, 'stopped', `cannot start the build: ${r.reasons.join('; ')}`);
          return;
        }
        break;
      }
      case 'build':
        await buildStep(h);
        break;
      case 'verify':
        await verifyPhase(h);
        break;
      case 'human_checks':
        await humanPhase(h);
        break;
      case 'deliver':
        await deliverPhase(h);
        return;
      default:
        return;
    }
  }
}

/** Start the loop for a run handle if it is not running. */
export function startLoop(h) {
  if (h.loop) return false;
  h.abort = new AbortController();
  // assign the handle before the loop's first step runs, so tools see a running loop
  h.loop = Promise.resolve()
    .then(() => loop(h))
    .catch(async (e) => {
      hub.logger.error?.(`junior-dev loop crashed: ${e.stack ?? e.message}`);
      try {
        await end(h, 'stopped', `loop error: ${e.message} (call jd_run to resume from the last checkpoint)`);
      } catch {
        // nothing more to do
      }
    })
    .finally(() => {
      h.loop = null;
      h.abort = null;
    });
  return true;
}
