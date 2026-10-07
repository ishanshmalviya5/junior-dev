// Scheduler (S8): code, not an LLM, picks the single next item.

const RISK = { high: 0, med: 1, low: 2 };

/** Longest chain of nodes that (transitively) depend on `id`, inclusive. */
export function chainLengths(tree) {
  const nodes = Object.values(tree.nodes);
  const dependents = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.dependsOn ?? []) dependents.get(d)?.push(n.id);
  const memo = new Map();
  const len = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 1;
    seen.add(id);
    const v = 1 + Math.max(0, ...(dependents.get(id) ?? []).map((d) => len(d, seen)));
    memo.set(id, v);
    return v;
  };
  for (const n of nodes) len(n.id);
  return memo;
}

/** S8.1: ready or recheck nodes, longest dependent chain first, then risk, then id. */
export function next(tree) {
  const candidates = Object.values(tree.nodes).filter((n) => n.status === 'ready' || n.status === 'recheck');
  if (candidates.length === 0) return null;
  const chains = chainLengths(tree);
  candidates.sort(
    (a, b) =>
      (chains.get(b.id) ?? 1) - (chains.get(a.id) ?? 1) ||
      (RISK[a.risk] ?? 1) - (RISK[b.risk] ?? 1) ||
      a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
  return candidates[0];
}

/** What the host should do with the picked node. */
export function actionFor(node) {
  if (node.status === 'recheck') return 'recheck';
  if (node.kind === 'branch') return 'integrate';
  if (node.needsSplit) return 'plan';
  return 'build';
}

/** S8.3 */
export function situation(tree) {
  const nodes = Object.values(tree.nodes);
  if (nodes.length === 0) return 'empty';
  if (next(tree)) return 'runnable';
  if (nodes.some((n) => ['working', 'submitted', 'checking'].includes(n.status))) return 'busy';
  if (nodes.some((n) => n.status === 'parked')) return 'stuck';
  if (nodes.every((n) => n.status === 'done')) return 'done';
  if (nodes.every((n) => n.status === 'done' || n.status === 'blocked')) return 'resolved';
  return 'blocked';
}
