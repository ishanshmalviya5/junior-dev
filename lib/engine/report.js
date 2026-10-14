// Final report (S15, G3, G4).
import { topLevel } from './tree.js';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function ending(state) {
  if (state.side === 'stopped') return `stopped: ${state.sideReason ?? 'budget reached'}`;
  if (state.side === 'blocked') return `blocked: ${state.sideReason ?? 'nothing can move'}`;
  if (state.side === 'paused') return `paused: ${state.sideReason ?? ''}`;
  if (state.phase === 'done') return state.blockers.length ? 'done, with blockers' : 'done';
  return `in progress (${state.phase})`;
}

const colour = (e) => (e ? (e.ok ? 'green' : 'red') : null);

/** v2-03: one line per leaf: red → green (behaviour) or green → green (refactor), with what went wrong otherwise. */
export function leafEvidenceLines(state) {
  const out = [];
  for (const [id, e] of Object.entries(state.leafEvidence ?? {})) {
    if (!e.before) continue;
    const n = state.tree.nodes[id];
    const before = colour(e.before);
    const after = colour(e.after) ?? 'not built yet';
    const expected = e.kind === 'refactor' ? 'green' : 'red';
    const note = before !== expected ? ` (before-work check was ${before}, expected ${expected}${e.parks ? '; developer was asked' : ''})` : '';
    out.push(`- ${id}${n ? ` ${n.title}` : ''} [${e.kind}]: ${before} → ${after}${note}${e.replans ? ` (replanned ${e.replans}x)` : ''}`);
  }
  return out;
}

export function renderReport(state, { now = new Date().toISOString() } = {}) {
  const L = [];
  const f = state.feature ?? {};
  L.push(`# junior-dev report — ${f.name ?? 'feature'}`, '', `${now} · ending: **${ending(state)}**`, '');

  L.push('## What was built');
  const top = topLevel(state.tree);
  if (top.length === 0) L.push('- Nothing was built yet.');
  for (const n of top) L.push(`- ${n.status === 'done' ? '✅' : n.status === 'blocked' ? '⛔' : '⏳'} **${n.id} ${n.title}**: ${n.status}`);
  L.push('');

  const lines = leafEvidenceLines(state);
  if (lines.length) L.push('## Red-first evidence', ...lines, '');

  L.push('## Requirement → check → result');
  const reqs = state.docs.requirements?.ids ?? [];
  L.push('| Requirement | Check | Kind | Result | Evidence |', '| --- | --- | --- | --- | --- |');
  for (const r of reqs) {
    const cs = Object.values(state.checks).filter((c) => c.requirementIds.includes(r));
    if (cs.length === 0) L.push(`| ${r} | — | — | **no check** | — |`);
    for (const c of cs) {
      const last = c.results.at(-1);
      const res = !last ? 'not run' : last.ok ? 'pass' : 'FAIL';
      const ev = last ? `${last.commit ? last.commit.slice(0, 8) + ': ' : ''}${esc(last.output).slice(-160)}` : '';
      L.push(`| ${r} | ${c.id} | ${c.kind} | ${res} | ${ev} |`);
    }
  }
  L.push('');

  L.push('## Blockers');
  if (state.blockers.length === 0) L.push('None.');
  for (const b of state.blockers) {
    L.push(`- **${b.id}**${b.nodeId ? ` (${b.nodeId})` : ''}${b.checkId ? ` [check ${b.checkId}]` : ''}: ${b.what}`);
    L.push(`  - why: ${b.why}`, `  - how found: ${b.how}`);
    if (b.fixes?.length) L.push(`  - proposed fixes: ${b.fixes.join('; ')}`);
  }
  L.push('');

  L.push('## Human checks');
  const human = Object.values(state.checks).filter((c) => c.kind === 'human');
  if (human.length === 0) L.push('None planned.');
  for (const c of human) {
    const last = c.results.at(-1);
    L.push(`- ${c.id} ${c.text ?? ''}: ${!last ? 'not done' : last.ok ? 'pass' : 'fail'}${last?.output ? ` — ${last.output}` : ''}`);
  }
  L.push('');

  L.push('## Decisions (lowest confidence first)');
  const dec = [...state.ledger].sort((a, b) => a.score - b.score);
  if (dec.length === 0) L.push('None.');
  else {
    L.push('| ID | Item | Decision | Score | Radius | Outcome |', '| --- | --- | --- | --- | --- | --- |');
    for (const d of dec) L.push(`| ${d.id} | ${d.nodeId ?? ''} | ${esc(d.what)} → ${esc(d.choice)} | ${d.score}/4 (${d.bar}) | ${d.radius} | ${d.outcome} |`);
  }
  L.push('');

  L.push('## Permissions used');
  const p = state.settings.permissions ?? {};
  L.push(`- push: ${p.push ? 'allowed' : 'not allowed'}; PR: ${p.pr ? 'allowed' : 'not allowed'}; debug env: ${p.debugEnv ?? 'none'}`);
  if (p.remoteWrites?.length) L.push(`- other remote writes allowed: ${p.remoteWrites.join(', ')}`);
  L.push('');

  L.push('## Budget used');
  const b = state.settings.budget ?? {};
  L.push(`- tokens: ${state.usage.tokens}${b.tokens ? ` of ${b.tokens}` : ''}; active time: ${Math.round(state.usage.activeMs / 60000)} min${b.timeMin ? ` of ${b.timeMin} min` : ''}`);
  L.push('');

  L.push('## Branches and PRs');
  if (!state.delivery.branches.length && !state.delivery.prs.length) {
    for (const r of state.settings.repos ?? []) L.push(`- ${r.path}: local branch \`${r.branch ?? '—'}\``);
  }
  for (const br of state.delivery.branches) L.push(`- ${br.repo}: \`${br.name}\`${br.pushed ? ' (pushed)' : ' (local)'}`);
  for (const pr of state.delivery.prs) L.push(`- PR: ${pr.url}`);
  L.push('');
  return L.join('\n');
}
