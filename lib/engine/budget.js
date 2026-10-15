// Budget (S12, E8, R7).

// Cache reads are re-reads of a prompt prefix the model already has; they are priced at about a tenth of
// fresh input and count far less toward subscription limits. Counting them at full weight made a toy run
// spend its whole budget on prefix re-reads (R2), so the budget counts them at this weight.
export const CACHE_READ_WEIGHT = 0.1;

/** Pure: the tokens a session's usage counts for against the budget. */
export function effectiveTokens(u) {
  if (!u) return 0;
  return Math.round((u.uncachedInputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteTokens ?? 0) + CACHE_READ_WEIGHT * (u.cacheReadTokens ?? 0));
}

/**
 * Pure: how long the loop has been running, in ms. Paused, stopped and blocked spells don't count, so a run
 * resumed a day later is not stopped at once (R2). Snapshots written before runMs existed count from their resume.
 */
export function runningMs(state, { now = Date.now() } = {}) {
  const u = state.usage;
  return (u.runMs ?? 0) + (u.runSince ? Math.max(0, now - Date.parse(u.runSince)) : 0);
}

export function exceeded(state, { now = Date.now() } = {}) {
  const b = state.settings.budget;
  if (!b) return [];
  const u = state.usage;
  const out = [];
  if (b.tokens && u.tokens >= b.tokens) out.push(`tokens ${u.tokens} ≥ ${b.tokens}`);
  if (b.timeMin) {
    const elapsed = runningMs(state, { now });
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
