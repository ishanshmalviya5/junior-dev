// S23: the background loop. Code, not an LLM, drives build → verify → human checks → deliver.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as G from '../engine/git.js';
import { runCheck } from '../engine/checks.js';
import { next, situation, actionFor } from '../engine/scheduler.js';
import { exceeded } from '../engine/budget.js';
import * as Locks from '../engine/locks.js';
import { pause as pausePhase } from '../engine/phases.js';
import { ending } from '../engine/report.js';
import { hub } from './hub.js';
import * as S from './services.js';
import { workerBrief, fixBrief, reviewBrief } from './prompts.js';

const RETRY_ASK_MS = () => Number(process.env.JD_RETRY_ASK_MS ?? 30000);

const repos = (run) => run.state.settings.repos ?? [];
const workPaths = (run) => repos(run).map((r) => r.workPath ?? r.path);

function heads(run) {
  return Object.fromEntries(repos(run).map((r) => [r.workPath, G.head(r.workPath)]));
}

function rollbackAll(run, bases) {
  for (const r of repos(run)) G.rollback(r.workPath, bases?.[r.workPath] ?? 'HEAD');
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

async function runNodeChecks(h, node) {
  const out = [];
  for (const c of node.checks) {
    const r = await runCheck({ command: c.command, cwd: resolveCwd(h.run, c.cwd) }, { signal: h.abort?.signal });
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
      const r = await runCheck({ command: c.command, cwd: resolveCwd(h.run, c.cwd) }, { signal: h.abort?.signal });
      if (!r.ok) return { ok: false, output: `regression in ${n.id} (${c.command}):\n${r.output}` };
    }
  }
  return { ok: true };
}

function usage(h, tokens, ms, nodeId) {
  const price = h.run.state.settings.budget?.pricePerMTokUsd;
  h.run.usage({ tokens: tokens ?? 0, costUsd: price ? ((tokens ?? 0) / 1e6) * price : 0, activeMs: ms, nodeId });
}

function heartbeatAll(h) {
  for (const r of repos(h.run)) Locks.heartbeat(r.path, { feature: h.run.lockKey, sessionId: h.rootSessionId });
}

function releaseAll(h) {
  for (const r of repos(h.run)) Locks.release(r.path, { feature: h.run.lockKey });
}

/** Crash recovery: in-flight items lose their uncommitted work and go back to ready. */
function recover(h) {
  const run = h.run;
  const inflight = Object.values(run.state.tree.nodes).filter((n) => ['working', 'submitted', 'checking'].includes(n.status));
  if (inflight.length === 0) return;
  for (const r of repos(run)) {
    try {
      G.rollback(r.workPath, 'HEAD');
    } catch (e) {
      run.note('recovery', `could not clean ${r.workPath}: ${e.message}`);
    }
  }
  for (const n of inflight) run.tree('abandon', n.id, 'interrupted (crash or restart); restarted from the last checkpoint', { countAttempt: false });
  run.note('recovery', `recovered ${inflight.map((n) => n.id).join(', ')}`);
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

async function work(h, node, role) {
  const run = h.run;
  const model = run.state.settings.models?.[role];
  const workerId = run.workerStart({ role, model, nodeId: node.id });
  const claimed = run.tree('claim', node.id, workerId);
  if (!claimed.ok) throw new Error(`claim ${node.id}: ${claimed.reasons.join('; ')}`);
  const bases = heads(run);
  h.worker = { id: workerId, nodeId: node.id, childId: null, bases };
  const contracts = [...node.provides, ...node.uses].map((c) => run.state.tree.contracts[c]).filter(Boolean);
  const prompt = workerBrief({ role, node, run, contracts, workPaths: workPaths(run), failure: lastFailure(node) });
  const t0 = Date.now();
  let res;
  try {
    res = await S.spawnWorker(h, { role, prompt, model, signal: h.abort?.signal });
  } catch (e) {
    res = { stopReason: 'error', text: e.message, tokens: 0 };
  } finally {
    h.worker = null;
  }
  run.workerEnd(workerId, res.stopReason);
  usage(h, res.tokens, Date.now() - t0, node.id);

  let cur = run.state.tree.nodes[node.id];
  if (cur.status === 'working') {
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
      if (!r.ok) await end(h, 'blocked', `cannot start verification: ${r.reasons.join('; ')}`);
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

async function runVp(h, ids) {
  const run = h.run;
  const failing = [];
  for (const c of Object.values(run.state.checks)) {
    if (c.kind !== 'automated' || (ids && !ids.includes(c.id))) continue;
    const r = await runCheck({ command: c.command, cwd: resolveCwd(run, c.cwd) }, { signal: h.abort?.signal });
    run.recordCheck(c.id, { ok: r.ok, output: r.output, commit: headOfFirst(run) });
    if (!r.ok) failing.push({ ...c, output: r.output });
  }
  return failing;
}

async function fixWith(h, { check, output }) {
  const run = h.run;
  const role = 'builder';
  const model = run.state.settings.models?.[role];
  const bases = heads(run);
  const workerId = run.workerStart({ role: 'fixer', model, nodeId: null, checkId: check.id });
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
  if (res.stopReason !== 'completed') {
    rollbackAll(run, bases);
    return false;
  }
  commitAllRepos(run, `jd(fix ${check.id}): ${String(check.text ?? '').slice(0, 60)}`);
  return true;
}

async function verifyPhase(h) {
  const run = h.run;
  const cap = run.state.settings.fixCap ?? 3;
  let failing = await runVp(h);
  for (const f of failing) {
    let ok = false;
    let out = f.output;
    while (!ok && (run.state.checks[f.id].attempts ?? 0) < cap) {
      run.checkAttempt(f.id);
      await fixWith(h, { check: run.state.checks[f.id], output: out });
      const again = await runVp(h, [f.id]);
      ok = again.length === 0;
      out = again[0]?.output ?? out;
    }
    if (!ok && !run.state.blockers.some((b) => b.checkId === f.id)) {
      run.blocker({ checkId: f.id, what: `check ${f.id} still fails after ${cap} fix rounds`, why: out.slice(-600), how: 'verification run', fixes: [] });
    }
  }
  // the final state must be checked on the final commit
  failing = await runVp(h);
  for (const f of failing) {
    if (!run.state.blockers.some((b) => b.checkId === f.id)) run.blocker({ checkId: f.id, what: `check ${f.id} fails on the final commit`, why: f.output.slice(-600), how: 'final verification run', fixes: [] });
  }

  const cm = run.state.settings.crossModel;
  if (cm?.enabled && !run.state.notes.some((n) => n.kind === 'cross_model_done')) {
    let findings = await review(h);
    for (let round = 1; findings.length && round <= cap; round++) {
      const pseudo = { id: `XM${round}`, kind: 'automated', text: 'cross-model review findings', requirementIds: [...new Set(findings.map((f) => f.requirement).filter(Boolean))] };
      await fixWith(h, { check: pseudo, output: JSON.stringify(findings, null, 2) });
      await runVp(h);
      findings = await review(h);
    }
    for (const f of findings) run.blocker({ what: `cross-model finding (${f.severity ?? 'n/a'}): ${f.problem}`, why: `requirement ${f.requirement ?? '?'}${f.where ? ` at ${f.where}` : ''}`, how: `review by ${cm.model.provider}/${cm.model.model}`, fixes: [] });
    run.note('cross_model_done', `${findings.length} finding(s) left`);
  }
  const r = run.advance('human_checks', { headCommit: () => headOfFirst(run) });
  if (!r.ok) await end(h, 'blocked', `cannot leave verification: ${r.reasons.join('; ')}`);
}

async function review(h) {
  const run = h.run;
  const cm = run.state.settings.crossModel;
  const base = repos(run)[0]?.baseRef;
  let diffStat = '';
  try {
    diffStat = repos(run).map((r) => G.git(r.workPath, ['diff', '--stat', `${r.baseRef}..HEAD`])).join('\n');
  } catch {
    diffStat = base ? '' : '';
  }
  const workerId = run.workerStart({ role: 'reviewer', model: cm.model, nodeId: null });
  h.worker = { id: workerId, nodeId: null, childId: null, reviewer: true };
  const t0 = Date.now();
  let res;
  try {
    res = await S.spawnWorker(h, { role: 'reviewer', prompt: reviewBrief({ run, workPaths: workPaths(run), diffStat }), model: cm.model, signal: h.abort?.signal });
  } finally {
    h.worker = null;
  }
  run.workerEnd(workerId, res.stopReason);
  usage(h, res.tokens, Date.now() - t0, null);
  const m = res.text?.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(m?.[0] ?? '{}');
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    run.note('review', `reviewer answer was not JSON: ${String(res.text).slice(0, 300)}`);
    return [];
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
    const failed = [];
    for (const a of answers) {
      if (a.id.startsWith('HC:')) {
        const id = a.id.slice(3);
        const ok = a.selected.some((s) => /^pass/i.test(s));
        run.recordCheck(id, { ok, output: a.custom ?? (ok ? 'pass' : 'fail'), by: 'developer', commit: headOfFirst(run) });
        if (!ok) failed.push({ check: run.state.checks[id], note: a.custom ?? 'failed' });
      } else if (a.id.startsWith('QQ:')) {
        run.answerQueued([{ id: a.id.slice(3), answer: S.answerText(a) }]);
      }
    }
    for (const f of failed) {
      let fixed = false;
      for (let i = 0; i < cap && !fixed; i++) {
        run.checkAttempt(f.check.id);
        fixed = await fixWith(h, { check: f.check, output: `The developer marked this hand check as failed: ${f.note}` });
      }
      // F4: not re-presented; the outcome goes in the report
      run.note('human_fix', `${f.check.id}: ${fixed ? 'fixed by a builder (not re-checked by hand)' : `not fixed after ${cap} tries`}`);
      if (!fixed) run.blocker({ checkId: f.check.id, what: `hand check ${f.check.id} failed and was not fixed`, why: f.note, how: 'developer hand check', fixes: [] });
    }
    if (failed.length) await runVp(h);
  }
  const r = run.advance('deliver');
  if (!r.ok) await end(h, 'blocked', `cannot deliver: ${r.reasons.join('; ')}`);
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
    await end(h, 'blocked', `delivery incomplete: ${r.reasons.join('; ')}`);
    return;
  }
  await end(h, null);
}

function firstLine(run) {
  return run.prdText().split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 60) ?? run.name;
}

/** PR body: no doc files, only the outcome and the requirement table (G1). */
function prBody(run, report, related) {
  const keep = report.split('\n## ').filter((s) => /^(What was built|Requirement → check → result|Blockers)/.test(s));
  return [`Delivered by junior-dev for **${run.name}**.`, related.length ? `\nRelated PRs: ${related.join(', ')}` : '', ...keep.map((s) => `\n## ${s}`)].join('\n');
}

async function end(h, side, reason) {
  const run = h.run;
  if (side && run.state.side !== side) run.store.commit('side', { side, reason });
  const report = run.writeReport();
  if (side) releaseAll(h);
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
      }
      return;
    }
    if (st.side) return;
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
          await end(h, 'blocked', `cannot start the build: ${r.reasons.join('; ')}`);
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
