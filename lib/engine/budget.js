// Budget (S12, E8, R7).

export function exceeded(state, { now = Date.now() } = {}) {
  const b = state.settings.budget;
  if (!b) return [];
  const u = state.usage;
  const out = [];
  if (b.tokens && u.tokens >= b.tokens) out.push(`tokens ${u.tokens} ≥ ${b.tokens}`);
  if (b.costUsd && u.costUsd >= b.costUsd) out.push(`cost $${u.costUsd.toFixed(2)} ≥ $${b.costUsd}`);
  if (b.timeMin) {
    const start = state.history.find((h) => h.ok && h.to === 'build')?.ts;
    const elapsed = start ? now - Date.parse(start) : 0;
    if (elapsed >= b.timeMin * 60000) out.push(`time ${Math.round(elapsed / 60000)} min ≥ ${b.timeMin} min`);
  }
  return out;
}

/** R7: nodes over 150% of their budget share (tokens). */
export function overspent(state) {
  return Object.values(state.tree.nodes)
    .filter((n) => n.budgetShare && (state.usage.byNode[n.id]?.tokens ?? 0) > 1.5 * n.budgetShare)
    .map((n) => n.id);
}
