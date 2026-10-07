// Decision ledger and thresholds (S9, J8–J10).
import { previewRadius } from './tree.js';

export const DIALS = Object.freeze(['careful', 'balanced', 'bold']);
export const RADII = Object.freeze(['leaf', 'shared', 'contract', 'irreversible', 'remote']);

const BARS = {
  careful: { leaf: { min: 3 }, shared: { min: 4, second: true } },
  balanced: { leaf: { min: 2 }, shared: { min: 3, second: true } },
  bold: { leaf: { min: 1 }, shared: { min: 2, second: true } },
};

export function score(proof) {
  return ['source', 'test', 'fitsContract', 'secondAgent'].filter((k) => proof?.[k] === true).length;
}

/**
 * Blast radius from facts, never from the agent's claim (S9):
 * - touchesDocs → contract; remote → remote; irreversible → irreversible
 * - a contract with users, or a change touching >1 node → shared; else leaf
 */
export function radius(tree, change) {
  if (change.touchesDocs) return 'contract';
  if (change.remote) return 'remote';
  if (change.irreversible) return 'irreversible';
  const touched = new Set();
  for (const c of change.contracts ?? []) for (const id of previewRadius(tree, { contractId: c })) touched.add(id);
  if (change.nodeId) for (const id of previewRadius(tree, { nodeId: change.nodeId })) touched.add(id);
  for (const id of change.otherNodes ?? []) touched.add(id);
  touched.delete(change.nodeId);
  return touched.size > 0 ? 'shared' : 'leaf';
}

export function bar(dial, rad) {
  if (rad === 'contract' || rad === 'irreversible' || rad === 'remote') return { always: 'park' };
  return BARS[dial]?.[rad] ?? BARS.balanced[rad];
}

/** Returns the full Decision record with outcome 'proceed' | 'park'. */
export function decide(tree, dial, d) {
  const rad = radius(tree, d.change ?? {});
  const b = bar(dial, rad);
  const sc = score(d.proof);
  let outcome;
  if (b.always) outcome = 'park';
  else outcome = sc >= b.min && (!b.second || d.proof?.secondAgent === true) ? 'proceed' : 'park';
  return {
    id: d.id,
    nodeId: d.change?.nodeId ?? null,
    what: d.what,
    options: d.options ?? [],
    choice: d.choice,
    why: d.why ?? '',
    proof: { source: !!d.proof?.source, test: !!d.proof?.test, fitsContract: !!d.proof?.fitsContract, secondAgent: d.proof?.secondAgent ?? null },
    evidence: d.evidence ?? [],
    radius: rad,
    undoable: !(d.change?.irreversible || d.change?.remote),
    score: sc,
    bar: b.always ? 'always ask' : `≥${b.min}${b.second ? ' + second agent' : ''}`,
    dial,
    outcome,
  };
}
