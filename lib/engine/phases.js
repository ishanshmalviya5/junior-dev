// Run state machine (S3): phases, guards, side states and resettle.
import { sha256 } from './util.js';
import { parseRequirements, parseVerificationPlan, parseSpecs, parsePlan } from './docs.js';
import { resolved } from './tree.js';

export const PHASES = Object.freeze([
  'intake',
  'research',
  'interview',
  'prd_parity',
  'requirements',
  'verification_plan',
  'specs',
  'implementation_plan',
  'preflight',
  'final_parity',
  'build',
  'verify',
  'human_checks',
  'deliver',
  'done',
]);

export const DOC_FILES = Object.freeze({
  requirements: 'requirements.md',
  verificationPlan: 'verification-plan.md',
  specs: 'specs.md',
  implementationPlan: 'implementation-plan.md',
});

const RESETTLE_TARGETS = ['requirements', 'verification_plan', 'specs', 'implementation_plan', 'build'];

const settled = (v) => v !== undefined && v !== null;

/** Settings the interview must settle before final parity (C5). */
export function unsettled(state) {
  const s = state.settings;
  const missing = [];
  if (!state.feature?.name) missing.push('feature name');
  if (!Array.isArray(s.repos) || s.repos.length === 0) missing.push('repos');
  else for (const r of s.repos) if (!['worktree', 'in-place'].includes(r.mode)) missing.push(`workspace mode for ${r.path}`);
  if (!settled(s.permissions)) missing.push('permissions');
  else for (const k of ['push', 'pr']) if (typeof s.permissions[k] !== 'boolean') missing.push(`permission: ${k}`);
  if (s.permissions && !('debugEnv' in s.permissions)) missing.push('permission: debug-env testing');
  if (!settled(s.budget)) missing.push('budget');
  else if (!s.budget.timeMin && !s.budget.tokens && !s.budget.costUsd) missing.push('budget: at least one limit (time, tokens or cost)');
  else if (s.budget.costUsd && !s.budget.pricePerMTokUsd) missing.push('budget: a cost limit needs a price per million tokens');
  if (!settled(s.models)) missing.push('models');
  else for (const role of ['planner', 'builder', 'checker']) if (!s.models[role]?.provider || !s.models[role]?.model) missing.push(`model for ${role} (provider + model)`);
  if (!settled(s.crossModel)) missing.push('cross-model verification');
  else if (s.crossModel.enabled && !s.crossModel.model) missing.push('cross-model verifier model');
  if (!['careful', 'balanced', 'bold'].includes(s.dial)) missing.push('careful/balanced/bold dial');
  return missing;
}

function docOk(state, ctx, key) {
  const md = ctx.readDoc(key);
  if (md === null || md === undefined) return { md: null, reasons: [`${DOC_FILES[key]} does not exist`] };
  return { md, sha: sha256(md), reasons: [] };
}

function parityOk(state, key, sha) {
  const p = state.parity[key];
  if (!p?.yes) return [`no parity yes recorded for ${key}`];
  if (sha && p.docSha && p.docSha !== sha) return [`${key} changed after its parity yes; parity must be given again`];
  return [];
}

const reqIds = (state) => state.docs.requirements?.ids ?? [];

/** Guards keyed by `${from}>${to}`; each returns a list of reasons (empty = ok). */
export const GUARDS = {
  'intake>research': (s) => [!s.prd?.sha256 && 'PRD not stored', !s.feature?.name && 'no feature name proposed'].filter(Boolean),
  'research>interview': (s) =>
    s.facts.length > 0 || s.notes.some((n) => n.kind === 'nothing_to_research') ? [] : ['no research recorded (add facts or a nothing_to_research note)'],
  'interview>prd_parity': (s) => {
    const open = s.questions.filter((q) => q.answer === undefined && !q.batchId);
    return open.length ? [`unanswered questions: ${open.map((q) => q.id).join(', ')}`] : [];
  },
  'prd_parity>requirements': (s) => parityOk(s, 'prd'),
  'requirements>verification_plan': (s, ctx) => {
    const d = docOk(s, ctx, 'requirements');
    if (d.md === null) return d.reasons;
    const p = parseRequirements(d.md);
    return [...p.reasons, ...parityOk(s, 'requirements', d.sha)];
  },
  'verification_plan>specs': (s, ctx) => {
    const d = docOk(s, ctx, 'verificationPlan');
    if (d.md === null) return d.reasons;
    const p = parseVerificationPlan(d.md, reqIds(s));
    return [...p.reasons, ...parityOk(s, 'verificationPlan', d.sha)];
  },
  'specs>implementation_plan': (s, ctx) => {
    const d = docOk(s, ctx, 'specs');
    if (d.md === null) return d.reasons;
    return parseSpecs(d.md, reqIds(s)).reasons;
  },
  'implementation_plan>preflight': (s, ctx) => {
    const d = docOk(s, ctx, 'implementationPlan');
    if (d.md === null) return d.reasons;
    const specIds = s.docs.specs?.ids ?? [];
    const checkIds = Object.keys(s.checks);
    const reasons = [...parsePlan(d.md, specIds, checkIds).reasons];
    const noCmd = Object.values(s.checks).filter((c) => c.kind === 'automated' && !c.command).map((c) => c.id);
    if (noCmd.length) reasons.push(`automated checks without a command: ${noCmd.join(', ')}`);
    if (!s.tree.rootId) reasons.push('work tree not initialised');
    else if (!Object.values(s.tree.nodes).some((n) => n.parentId === s.tree.rootId)) reasons.push('work tree has no top-level items');
    return reasons;
  },
  'preflight>final_parity': (s) => {
    if (s.preflight.length === 0) return ['preflight has not run'];
    const bad = s.preflight.filter((p) => !p.ok);
    return bad.length ? bad.map((p) => `preflight failed: ${p.what} (${p.detail})`) : [];
  },
  'final_parity>build': (s, ctx) => {
    const reasons = [...parityOk(s, 'final')];
    const miss = unsettled(s);
    if (miss.length) reasons.push(`not settled: ${miss.join(', ')}`);
    for (const key of ['requirements', 'verificationPlan']) {
      const d = docOk(s, ctx, key);
      reasons.push(...(d.md === null ? d.reasons : parityOk(s, key, d.sha)));
    }
    const unlocked = (s.settings.repos ?? []).filter((r) => !ctx.holdsLock?.(r));
    if (unlocked.length) reasons.push(`no lock held on: ${unlocked.map((r) => r.path).join(', ')}`);
    const unprepared = (s.settings.repos ?? []).filter((r) => !r.workPath || !r.branch);
    if (unprepared.length) reasons.push(`workspace not prepared for: ${unprepared.map((r) => r.path).join(', ')}`);
    return reasons;
  },
  'build>verify': (s) => {
    const nodes = Object.values(s.tree.nodes);
    const parked = nodes.filter((n) => n.status === 'parked');
    if (parked.length) return [`parked items still waiting on answers: ${parked.map((n) => n.id).join(', ')}`];
    return resolved(s.tree) ? [] : [`unfinished items: ${nodes.filter((n) => !['done', 'blocked'].includes(n.status)).map((n) => n.id).join(', ')}`];
  },
  'verify>human_checks': (s, ctx) => {
    const reasons = [];
    const head = ctx.headCommit?.() ?? null;
    for (const c of Object.values(s.checks)) {
      if (c.kind !== 'automated') continue;
      const last = c.results.at(-1);
      if (!last) reasons.push(`check ${c.id} has no result`);
      else if (head && last.commit && last.commit !== head && !c.blocked) reasons.push(`check ${c.id} result is not on the current commit`);
      else if (!last.ok && !s.blockers.some((b) => b.checkId === c.id)) reasons.push(`check ${c.id} failed and is not logged as a blocker`);
    }
    if (s.settings.crossModel?.enabled && !s.notes.some((n) => n.kind === 'cross_model_done')) reasons.push('cross-model verification has not run');
    return reasons;
  },
  'human_checks>deliver': (s) => {
    const open = Object.values(s.checks).filter((c) => c.kind === 'human' && c.results.length === 0);
    return open.length ? [`human checks without a result: ${open.map((c) => c.id).join(', ')}`] : [];
  },
  'deliver>done': (s, ctx) => {
    const reasons = [];
    const p = s.settings.permissions ?? {};
    if (p.push && s.delivery.branches.length === 0) reasons.push('push was allowed but no branch was pushed');
    if (p.pr && s.delivery.prs.length === 0) reasons.push('PRs were allowed but none was opened');
    if (!p.push && s.delivery.branches.some((b) => b.pushed)) reasons.push('a branch was pushed without permission');
    if (!ctx.reportWritten?.()) reasons.push('report.md not written');
    const leaked = ctx.trackedDocFiles?.() ?? [];
    if (leaked.length) reasons.push(`doc files tracked or staged in git: ${leaked.join(', ')}`);
    return reasons;
  },
};

/**
 * Try to move to `to`. Commits `phase` on success or `phase_refused` with reasons.
 * Returns { ok, reasons }.
 */
export function advance(store, to, ctx = {}, evidence = null) {
  const s = store.state;
  if (s.side) {
    const reasons = [`run is ${s.side}${s.sideReason ? `: ${s.sideReason}` : ''}`];
    store.commit('phase_refused', { from: s.phase, to, reasons, evidence });
    return { ok: false, reasons };
  }
  const from = s.phase;
  const i = PHASES.indexOf(from);
  if (PHASES[i + 1] !== to) {
    const reasons = [`${to} does not follow ${from}`];
    store.commit('phase_refused', { from, to, reasons, evidence });
    return { ok: false, reasons };
  }
  const guard = GUARDS[`${from}>${to}`];
  const reasons = guard ? guard(s, ctx) : [];
  if (reasons.length) {
    store.commit('phase_refused', { from, to, reasons, evidence });
    return { ok: false, reasons };
  }
  store.commit('phase', { from, to, evidence });
  return { ok: true, reasons: [] };
}

export function setSide(store, side, reason, resumePhase) {
  store.commit('side', { side, reason, resumePhase: resumePhase ?? store.state.phase });
}

/** H1: pause during build/verify (S3 side transitions). */
export function pause(store, reason) {
  const { phase, side } = store.state;
  if (side) return { ok: false, reasons: [`already ${side}`] };
  if (!['build', 'verify'].includes(phase)) return { ok: false, reasons: [`pause only applies during build or verify (now ${phase})`] };
  setSide(store, 'paused', reason);
  return { ok: true, reasons: [] };
}

/**
 * H1: after the change is settled, rewind to the earliest affected phase. Parity on any changed
 * read doc must be given again (its sha changes, so its guard refuses until then).
 */
export function resettle(store, target, { changedDocs = [] } = {}) {
  const s = store.state;
  if (s.side !== 'paused') return { ok: false, reasons: ['run is not paused'] };
  if (!RESETTLE_TARGETS.includes(target)) return { ok: false, reasons: [`cannot resettle to ${target}`] };
  for (const key of changedDocs) {
    if (key === 'requirements' || key === 'verificationPlan') store.commit('parity', { key, yes: false });
  }
  if (target !== 'build') store.commit('parity', { key: 'final', yes: false });
  store.commit('side', { side: null, reason: null });
  store.commit('phase', { from: s.phase, to: target, evidence: { resettle: true, changedDocs } });
  return { ok: true, reasons: [] };
}

export function resume(store) {
  const s = store.state;
  if (!s.side) return { ok: true, reasons: [], phase: s.phase };
  if (s.side === 'blocked') return { ok: false, reasons: ['run is blocked: nothing can move'] };
  store.commit('side', { side: null, reason: null });
  return { ok: true, reasons: [], phase: s.phase };
}
