// Progress checklist and bar (S14, E7).
import { leaves, topLevel, children } from './tree.js';

function leafCount(tree, id) {
  const kids = children(tree, id);
  if (kids.length === 0) return { done: tree.nodes[id].status === 'done' ? 1 : 0, total: 1 };
  return kids.reduce((acc, k) => {
    const c = leafCount(tree, k.id);
    return { done: acc.done + c.done, total: acc.total + c.total };
  }, { done: 0, total: 0 });
}

export function progress(state) {
  const tree = state.tree;
  const ls = leaves(tree);
  const done = ls.filter((n) => n.status === 'done').length;
  const total = ls.length;
  const checklist = topLevel(tree).map((n) => ({ id: n.id, title: n.title, status: n.status, ...leafCount(tree, n.id) }));
  const grew = total > (state.progress.lastKnownLeaves ?? 0) && (state.progress.lastKnownLeaves ?? 0) > 0 ? total - state.progress.lastKnownLeaves : 0;
  return {
    phase: state.phase,
    side: state.side,
    checklist,
    bar: { done, total, pct: total ? Math.round((done / total) * 100) : 0 },
    grewBy: grew,
    parked: ls.filter((n) => n.status === 'parked').length,
    blocked: ls.filter((n) => n.status === 'blocked').length,
  };
}

const ICON = { done: '[x]', blocked: '[!]', parked: '[?]', working: '[~]', checking: '[~]', submitted: '[~]', recheck: '[↻]' };

export function renderProgress(p) {
  const width = 20;
  const filled = p.bar.total ? Math.round((p.bar.done / p.bar.total) * width) : 0;
  const bar = `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${p.bar.pct}% (${p.bar.done}/${p.bar.total})`;
  const lines = p.checklist.map((c) => `${ICON[c.status] ?? '[ ]'} ${c.title} — ${c.done}/${c.total}`);
  const notes = [];
  if (p.grewBy) notes.push(`plan grew: +${p.grewBy} items`);
  if (p.parked) notes.push(`${p.parked} waiting on your answers`);
  if (p.blocked) notes.push(`${p.blocked} blocked`);
  return [`junior-dev · ${p.phase}${p.side ? ` (${p.side})` : ''}`, bar, ...lines, ...(notes.length ? [notes.join(' · ')] : [])].join('\n');
}
