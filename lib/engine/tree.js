// Work tree: operations, ripple rules R1–R7 and the item state machine (S4–S6).
// Every operation is validated against the current state and returns a patch; nothing
// changes until the caller commits the patch as a `tree` event (S4.2, J4).
import { parseToolSpec } from './docs.js';

/** v2-09: a check is {command, cwd} (shell) or {tool, arguments, pass}; text in `command` like `tool:x {} pass:r` is the tool form. */
export function normCheck(c, id) {
  const spec = parseToolSpec(c.command);
  const t = spec ?? (c.tool ? { tool: c.tool, arguments: c.arguments ?? {}, pass: c.pass ?? null } : null);
  return t
    ? { id: c.id ?? id, command: null, tool: t.tool, arguments: t.arguments ?? {}, pass: t.pass ?? null, cwd: c.cwd ?? null, ...(spec?.error ? { error: spec.error } : {}) }
    : { id: c.id ?? id, command: c.command, cwd: c.cwd ?? null };
}
const checkProblems = (n) => n.checks.filter((c) => c.tool && (!c.pass || c.error)).map((c) => `${n.id}: ${c.error ?? `tool check "${c.tool}" has no pass rule`}`);

export const LEAF_KINDS = Object.freeze(['behaviour', 'refactor']);

export const ITEM_STATES = Object.freeze(['new', 'ready', 'working', 'submitted', 'checking', 'done', 'split', 'recheck', 'parked', 'blocked']);

const refuse = (rule, ...reasons) => ({ ok: false, rule, reasons: reasons.flat() });

class Draft {
  constructor(tree) {
    this.base = tree;
    this.nodes = new Map();
    this.contracts = new Map();
    this.deleted = new Set();
    this.rootId = undefined;
    this.affected = new Set();
  }
  get(id) {
    if (this.deleted.has(id)) return undefined;
    return this.nodes.get(id) ?? this.base.nodes[id];
  }
  edit(id) {
    if (!this.nodes.has(id)) this.nodes.set(id, structuredClone(this.base.nodes[id]));
    return this.nodes.get(id);
  }
  put(node) {
    this.nodes.set(node.id, node);
    this.deleted.delete(node.id);
  }
  del(id) {
    this.deleted.add(id);
    this.nodes.delete(id);
  }
  contract(id) {
    return this.contracts.get(id) ?? this.base.contracts[id];
  }
  editContract(id) {
    if (!this.contracts.has(id)) this.contracts.set(id, structuredClone(this.base.contracts[id]));
    return this.contracts.get(id);
  }
  allIds() {
    const ids = new Set([...Object.keys(this.base.nodes), ...this.nodes.keys()]);
    for (const d of this.deleted) ids.delete(d);
    return [...ids];
  }
  all() {
    return this.allIds().map((id) => this.get(id));
  }
  allContracts() {
    const ids = new Set([...Object.keys(this.base.contracts), ...this.contracts.keys()]);
    return [...ids].map((id) => this.contract(id));
  }
  setStatus(id, status, why) {
    const n = this.edit(id);
    if (n.status !== status) {
      n.status = status;
      n.statusWhy = why ?? null;
      this.affected.add(id);
    }
  }
  patch() {
    return {
      rootId: this.rootId,
      nodes: Object.fromEntries(this.nodes),
      deleteNodes: [...this.deleted],
      contracts: Object.fromEntries(this.contracts),
    };
  }
}

const childrenOf = (draft, id) => draft.all().filter((n) => n.parentId === id).sort((a, b) => a.order - b.order);

function ancestors(draft, id) {
  const out = [];
  let cur = draft.get(id);
  while (cur && cur.parentId) {
    cur = draft.get(cur.parentId);
    if (cur) out.push(cur);
  }
  return out;
}

function subtreeIds(draft, id) {
  const out = [id];
  for (const c of childrenOf(draft, id)) out.push(...subtreeIds(draft, c.id));
  return out;
}

// R1 Cover
function checkCover(draft, parentId) {
  const p = draft.get(parentId);
  const kids = childrenOf(draft, parentId);
  if (kids.length === 0) return [];
  const parentCrit = new Set(p.doneWhen.map((c) => c.id));
  const reasons = [];
  const covered = new Set();
  for (const k of kids) {
    for (const c of k.covers) {
      if (!parentCrit.has(c)) reasons.push(`${k.id} covers ${c}, which is not a done-when criterion of ${parentId}`);
      covered.add(c);
    }
  }
  const gaps = [...parentCrit].filter((c) => !covered.has(c));
  if (gaps.length) reasons.push(`${parentId} criteria not covered by any child: ${gaps.join(', ')}`);
  return reasons;
}

// R2 Trace
function checkTrace(draft, node, knownRequirements) {
  const reasons = [];
  const reqs = node.traces?.requirements ?? [];
  if (reqs.length === 0) reasons.push(`${node.id} traces to no requirement`);
  const unknown = reqs.filter((r) => !knownRequirements.includes(r));
  if (unknown.length) reasons.push(`${node.id} traces to unknown requirements: ${unknown.join(', ')}`);
  if (node.parentId) {
    const p = draft.get(node.parentId);
    const extra = reqs.filter((r) => !(p.traces?.requirements ?? []).includes(r));
    if (extra.length) reasons.push(`${node.id} traces to ${extra.join(', ')}, outside its parent ${p.id} (scope creep)`);
  }
  return reasons;
}

// R5 Order: cycle detection over dependsOn (DFS)
function findCycle(draft) {
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of draft.get(id)?.dependsOn ?? []) {
      if (!draft.get(d)) continue;
      if (color.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!color.get(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of draft.allIds()) {
    if (!color.get(id)) {
      const c = visit(id);
      if (c) return c;
    }
  }
  return null;
}

function depsDone(draft, node) {
  return (node.dependsOn ?? []).every((d) => draft.get(d)?.status === 'done');
}

function isReadyLeaf(draft, node) {
  return node.doneWhen.length > 0 && depsDone(draft, node) && (node.needsSplit || node.checks.length > 0);
}

/** Leaving done (R3): every done ancestor goes to recheck. */
function reopenAncestors(draft, id, why) {
  for (const a of ancestors(draft, id)) {
    if (a.status === 'done') draft.setStatus(a.id, 'recheck', why);
    else if (a.status === 'ready' && a.kind === 'branch') draft.setStatus(a.id, 'split', why);
  }
}

/** Fixpoint pass: readiness (R5), roll-up (R3) and dependency regressions. */
function settle(draft) {
  for (let guard = 0; guard < 1000; guard++) {
    let changed = false;
    for (const n of draft.all()) {
      // E6: an item whose dependency is blocked can never run; it is skipped too, so the rest can finish
      if (['new', 'ready'].includes(n.status)) {
        const dead = (n.dependsOn ?? []).find((d) => draft.get(d)?.status === 'blocked');
        if (dead) {
          draft.setStatus(n.id, 'blocked', `depends on blocked ${dead}`);
          draft.edit(n.id).blocker = draft.get(dead).blocker ?? dead;
          changed = true;
          continue;
        }
      }
      if (n.kind === 'branch') {
        const kids = childrenOf(draft, n.id);
        if (kids.length === 0) continue;
        // R3: a branch is integrated only after all its children are done again
        if ((n.status === 'recheck' || n.status === 'ready') && !kids.every((k) => k.status === 'done')) {
          draft.setStatus(n.id, kids.every((k) => k.status === 'done' || k.status === 'blocked') ? 'blocked' : 'split', 'waiting for its children');
          changed = true;
          continue;
        }
        const allDone = kids.every((k) => k.status === 'done');
        const allResolved = kids.every((k) => k.status === 'done' || k.status === 'blocked');
        if (n.status === 'split' && allDone && depsDone(draft, n)) {
          draft.setStatus(n.id, 'ready', 'all children done: integration check due');
          changed = true;
        } else if (n.status === 'split' && allResolved && !allDone) {
          draft.setStatus(n.id, 'blocked', 'a child is blocked');
          changed = true;
        } else if (n.status === 'blocked' && n.statusWhy === 'a child is blocked' && !allResolved) {
          draft.setStatus(n.id, 'split', 'child reopened');
          changed = true;
        }
      } else {
        if (n.status === 'new' && isReadyLeaf(draft, n)) {
          draft.setStatus(n.id, 'ready', 'dependencies done');
          changed = true;
        } else if (n.status === 'ready' && !depsDone(draft, n)) {
          draft.setStatus(n.id, 'new', 'a dependency reopened');
          changed = true;
        }
      }
    }
    if (!changed) return;
  }
  throw new Error('tree settle did not converge');
}

function result(draft) {
  settle(draft);
  return { ok: true, patch: draft.patch(), affected: [...draft.affected] };
}

function makeNode(parent, index, spec) {
  const id = `${parent.id}.${index}`;
  return {
    id,
    parentId: parent.id,
    order: index,
    title: spec.title,
    goal: spec.goal ?? spec.title,
    doneWhen: (spec.doneWhen ?? []).map((text, i) => ({ id: `${id}#c${i + 1}`, text })),
    covers: spec.covers ?? [],
    traces: { requirements: spec.traces?.requirements ?? [], checks: spec.traces?.checks ?? [] },
    dependsOn: spec.dependsOn ?? [],
    provides: [],
    uses: spec.uses ?? [],
    kind: 'leaf',
    leafKind: spec.kind ?? spec.leafKind ?? null, // v2-03: behaviour | refactor (node.kind stays leaf | branch)
    needsSplit: Boolean(spec.needsSplit),
    status: 'new',
    statusWhy: null,
    attempts: 0,
    risk: spec.risk ?? 'med',
    checks: (spec.checks ?? []).map((c, i) => normCheck(c, `${id}/k${i + 1}`)),
    evidence: [],
    budgetShare: spec.budgetShare ?? null,
    confidence: null,
  };
}

// ---------------------------------------------------------------- operations

export function init(tree, { requirements, title = 'Feature', integrationChecks = [] }) {
  if (tree.rootId) return refuse('R0', 'tree already initialised');
  if (!requirements?.length) return refuse('R2', 'root needs at least one requirement');
  const draft = new Draft(tree);
  draft.rootId = 'N';
  draft.put({
    id: 'N',
    parentId: null,
    order: 0,
    title,
    goal: title,
    doneWhen: requirements.map((r) => ({ id: `N#${r}`, text: r, requirement: r })),
    covers: [],
    traces: { requirements: [...requirements], checks: [] },
    dependsOn: [],
    provides: [],
    uses: [],
    kind: 'branch',
    needsSplit: true,
    status: 'new',
    statusWhy: null,
    attempts: 0,
    risk: 'med',
    checks: integrationChecks.map((c, i) => normCheck(c, `N/k${i + 1}`)),
    evidence: [],
    budgetShare: null,
    confidence: null,
  });
  draft.affected.add('N');
  return { ok: true, patch: draft.patch(), affected: ['N'] };
}

/**
 * Atomically split a node into children (R1, R2, R5). Children may reference each other in
 * dependsOn as "#<index>" (1-based) and may declare contracts they provide.
 */
export function split(tree, nodeId, children, { requirements }) {
  const draft = new Draft(tree);
  const parent = draft.get(nodeId);
  if (!parent) return refuse('S4', `no node ${nodeId}`);
  if (childrenOf(draft, nodeId).length) return refuse('S4', `${nodeId} is already split; use add`);
  if (!['new', 'ready', 'working'].includes(parent.status)) return refuse('S6', `cannot split ${nodeId} while ${parent.status}`);
  if (!children?.length) return refuse('R1', 'split needs at least one child');
  const made = children.map((spec, i) => makeNode(parent, i + 1, spec));
  const reasons = [];
  made.forEach((n, i) => {
    n.dependsOn = n.dependsOn.map((d) => (typeof d === 'string' && d.startsWith('#') ? made[Number(d.slice(1)) - 1]?.id ?? d : d));
    for (const p of children[i].provides ?? []) {
      const cid = p.id ?? `C:${n.id}:${p.name}`;
      if (draft.contract(cid)) reasons.push(`contract ${cid} already exists`);
      n.provides.push(cid);
      draft.contracts.set(cid, { id: cid, name: p.name, description: p.description ?? '', version: 1, ownerNodeId: n.id });
    }
  });
  for (const n of made) draft.put(n);
  const p = draft.edit(nodeId);
  p.kind = 'branch';
  p.needsSplit = false;
  draft.setStatus(nodeId, 'split', 'split into children');
  for (const n of made) {
    draft.affected.add(n.id);
    reasons.push(...checkTrace(draft, n, requirements));
    for (const d of n.dependsOn) if (!draft.get(d)) reasons.push(`${n.id} depends on unknown node ${d}`);
    for (const u of n.uses) if (!draft.contract(u)) reasons.push(`${n.id} uses unknown contract ${u}`);
    if (!n.needsSplit && n.checks.length === 0) reasons.push(`${n.id} is a leaf with no check; give it a check or mark needsSplit`);
    reasons.push(...checkProblems(n));
    if (!n.needsSplit && !LEAF_KINDS.includes(n.leafKind)) reasons.push(kindReason(n));
    if (n.doneWhen.length === 0) reasons.push(`${n.id} has no done-when criteria`);
  }
  reasons.push(...checkCover(draft, nodeId));
  const cyc = findCycle(draft);
  if (cyc) reasons.push(`dependency loop: ${cyc.join(' → ')}`);
  if (reasons.length) return refuse(reasons[0].includes('covers') || reasons[0].includes('not covered') ? 'R1' : ruleOf(reasons[0]), reasons);
  reopenAncestors(draft, nodeId, `${nodeId} was split`);
  return result(draft);
}

const kindReason = (n) => `${n.id} is a leaf without a valid kind (got ${JSON.stringify(n.leafKind)}); set kind to "behaviour" (changes what the software does) or "refactor" (structure only), or mark needsSplit`;

function ruleOf(reason) {
  if (/valid kind/.test(reason)) return 'K1';
  if (/scope creep|traces to/.test(reason)) return 'R2';
  if (/loop|depends on/.test(reason)) return 'R5';
  if (/covered|covers/.test(reason)) return 'R1';
  if (/contract/.test(reason)) return 'R4';
  return 'S4';
}

export function add(tree, parentId, spec, { requirements }) {
  const draft = new Draft(tree);
  const parent = draft.get(parentId);
  if (!parent) return refuse('S4', `no node ${parentId}`);
  if (parent.kind !== 'branch' || childrenOf(draft, parentId).length === 0) return refuse('S4', `${parentId} is not split; use split`);
  const index = Math.max(...childrenOf(draft, parentId).map((c) => c.order)) + 1;
  const n = makeNode(parent, index, spec);
  for (const pr of spec.provides ?? []) {
    const cid = pr.id ?? `C:${n.id}:${pr.name}`;
    n.provides.push(cid);
    draft.contracts.set(cid, { id: cid, name: pr.name, description: pr.description ?? '', version: 1, ownerNodeId: n.id });
  }
  draft.put(n);
  draft.affected.add(n.id);
  const reasons = [...checkTrace(draft, n, requirements), ...checkCover(draft, parentId)];
  for (const d of n.dependsOn) if (!draft.get(d)) reasons.push(`${n.id} depends on unknown node ${d}`);
  for (const u of n.uses) if (!draft.contract(u)) reasons.push(`${n.id} uses unknown contract ${u}`);
  if (!n.needsSplit && n.checks.length === 0) reasons.push(`${n.id} is a leaf with no check; give it a check or mark needsSplit`);
  reasons.push(...checkProblems(n));
  if (!n.needsSplit && !LEAF_KINDS.includes(n.leafKind)) reasons.push(kindReason(n));
  const cyc = findCycle(draft);
  if (cyc) reasons.push(`dependency loop: ${cyc.join(' → ')}`);
  if (reasons.length) return refuse(ruleOf(reasons[0]), reasons);
  if (parent.status === 'done' || parent.status === 'ready') {
    draft.setStatus(parentId, 'split', `child ${n.id} added`);
    reopenAncestors(draft, parentId, `child ${n.id} added under ${parentId}`);
  }
  return result(draft);
}

/** v2-03: a planner rewrites a leaf's checks (red-first replan). Only a leaf being worked on can change. */
export function setChecks(tree, nodeId, checks) {
  const draft = new Draft(tree);
  const n = draft.get(nodeId);
  if (!n) return refuse('S4', `no node ${nodeId}`);
  if (n.kind !== 'leaf') return refuse('S4', `${nodeId} is not a leaf`);
  if (n.status !== 'working') return refuse('S6', `${nodeId} is ${n.status}; checks can be rewritten only while it is being worked on`);
  if (!Array.isArray(checks) || checks.length === 0 || checks.some((c) => !c?.command && !c?.tool)) return refuse('S4', 'give at least one check, each with a command or a tool check');
  const made = checks.map((c, i) => normCheck(c, `${nodeId}/k${i + 1}`));
  const bad = checkProblems({ id: nodeId, checks: made });
  if (bad.length) return refuse('S4', bad);
  draft.edit(nodeId).checks = made;
  draft.affected.add(nodeId);
  return result(draft);
}

export function remove(tree, nodeId) {
  const draft = new Draft(tree);
  const n = draft.get(nodeId);
  if (!n) return refuse('S4', `no node ${nodeId}`);
  if (!n.parentId) return refuse('S4', 'cannot remove the root');
  const sub = new Set(subtreeIds(draft, nodeId));
  if ([...sub].some((id) => draft.get(id).status === 'working')) return refuse('S6', `${nodeId} or a descendant is being worked on`);
  const reasons = [];
  for (const o of draft.all()) {
    if (sub.has(o.id)) continue;
    const deps = o.dependsOn.filter((d) => sub.has(d));
    if (deps.length) reasons.push(`${o.id} depends on ${deps.join(', ')} (R5)`);
    const owned = o.uses.filter((u) => sub.has(draft.contract(u)?.ownerNodeId));
    if (owned.length) reasons.push(`${o.id} uses contracts provided inside ${nodeId}: ${owned.join(', ')} (R4)`);
  }
  for (const id of sub) draft.del(id);
  reasons.push(...checkCover(draft, n.parentId).map((r) => `${r} (R1)`));
  if (childrenOf(draft, n.parentId).length === 0) reasons.push(`${n.parentId} would have no children (R1)`);
  if (reasons.length) return refuse(ruleOf(reasons[0]), reasons);
  return result(draft);
}

export function setDeps(tree, nodeId, deps) {
  const draft = new Draft(tree);
  if (!draft.get(nodeId)) return refuse('S4', `no node ${nodeId}`);
  const unknown = deps.filter((d) => !draft.get(d));
  if (unknown.length) return refuse('R5', `unknown nodes: ${unknown.join(', ')}`);
  draft.edit(nodeId).dependsOn = [...deps];
  const cyc = findCycle(draft);
  if (cyc) return refuse('R5', `dependency loop: ${cyc.join(' → ')}`);
  draft.affected.add(nodeId);
  return result(draft);
}

/** R4: a contract change sends every user that is done/submitted/checking to recheck. */
export function changeContract(tree, contractId, { description, byNodeId }) {
  const draft = new Draft(tree);
  const c = draft.contract(contractId);
  if (!c) return refuse('R4', `no contract ${contractId}`);
  if (byNodeId && c.ownerNodeId !== byNodeId) return refuse('R4', `${byNodeId} does not own ${contractId} (owner: ${c.ownerNodeId})`);
  const ec = draft.editContract(contractId);
  ec.version += 1;
  if (description !== undefined) ec.description = description;
  for (const n of draft.all()) {
    if (n.id === c.ownerNodeId || !n.uses.includes(contractId)) continue;
    if (['done', 'submitted', 'checking'].includes(n.status)) {
      const wasDone = n.status === 'done';
      draft.setStatus(n.id, 'recheck', `contract ${contractId} changed to v${ec.version}`);
      if (wasDone) reopenAncestors(draft, n.id, `${n.id} needs recheck`);
    }
  }
  return result(draft);
}

/** Nodes a change to `contractId` (or to `nodeId`) would touch: used for blast radius (S9). */
export function previewRadius(tree, { contractId, nodeId }) {
  const draft = new Draft(tree);
  const touched = new Set();
  if (contractId) {
    const c = draft.contract(contractId);
    if (c) for (const n of draft.all()) if (n.uses.includes(contractId) && n.id !== c.ownerNodeId) touched.add(n.id);
  }
  if (nodeId) for (const n of draft.all()) if (n.dependsOn.includes(nodeId)) touched.add(n.id);
  return [...touched];
}

function transition(tree, nodeId, from, to, why, mutate) {
  const draft = new Draft(tree);
  const n = draft.get(nodeId);
  if (!n) return refuse('S6', `no node ${nodeId}`);
  if (!from.includes(n.status)) return refuse('S6', `${nodeId} is ${n.status}; expected ${from.join(' or ')} to move to ${to}`);
  const wasDone = n.status === 'done';
  draft.setStatus(nodeId, to, why);
  if (mutate) mutate(draft.edit(nodeId), draft);
  if (wasDone && to !== 'done') reopenAncestors(draft, nodeId, `${nodeId} left done`);
  return result(draft);
}

export const claim = (tree, nodeId, workerId) =>
  transition(tree, nodeId, ['ready', 'recheck'], 'working', `claimed by ${workerId}`, (n) => {
    n.worker = workerId;
  });

export const submit = (tree, nodeId, { commit } = {}) =>
  transition(tree, nodeId, ['working'], 'submitted', 'submitted for checks', (n) => {
    n.submittedCommit = commit ?? null;
  });

export const startChecks = (tree, nodeId) => transition(tree, nodeId, ['submitted', 'recheck', 'ready'], 'checking', 'checks running');

export const park = (tree, nodeId, questionId) =>
  transition(tree, nodeId, ['working', 'ready', 'new', 'recheck'], 'parked', `waiting on question ${questionId}`, (n) => {
    n.parkedOn = questionId;
  });

export function unpark(tree, nodeId) {
  const draft = new Draft(tree);
  const n = draft.get(nodeId);
  if (!n || n.status !== 'parked') return refuse('S6', `${nodeId} is not parked`);
  draft.setStatus(nodeId, n.kind === 'branch' && childrenOf(draft, nodeId).length ? 'split' : 'new', 'question answered');
  draft.edit(nodeId).parkedOn = null;
  return result(draft);
}

export const block = (tree, nodeId, blockerId) =>
  transition(tree, nodeId, ['new', 'ready', 'working', 'submitted', 'checking', 'recheck', 'parked', 'split'], 'blocked', `blocker ${blockerId}`, (n) => {
    n.blocker = blockerId;
  });

export const reopen = (tree, nodeId, why) => transition(tree, nodeId, ['done'], 'recheck', why);

/** Recovery / failed worker: an in-flight item goes back to ready (counting an attempt), or blocked at the cap. */
export function abandon(tree, nodeId, why, { fixCap = 3, countAttempt = true } = {}) {
  const draft = new Draft(tree);
  const n = draft.get(nodeId);
  if (!n) return refuse('S6', `no node ${nodeId}`);
  if (!['working', 'submitted', 'checking'].includes(n.status)) return refuse('S6', `${nodeId} is ${n.status}; only in-flight items can be abandoned`);
  const e = draft.edit(nodeId);
  if (countAttempt) e.attempts += 1;
  e.worker = null;
  if (e.attempts >= fixCap) draft.setStatus(nodeId, 'blocked', `${why} (attempt ${e.attempts} of ${fixCap})`);
  else draft.setStatus(nodeId, e.kind === 'branch' && childrenOf(draft, nodeId).length ? 'split' : 'ready', why);
  return result(draft);
}

/**
 * S6.1: the only way to `done`. Called by the engine's check runner with the results of
 * every check on the node; all must pass on the same commit.
 */
export function recordChecks(tree, nodeId, results, { fixCap }) {
  const draft = new Draft(tree);
  const n = draft.get(nodeId);
  if (!n) return refuse('S6', `no node ${nodeId}`);
  if (n.status !== 'checking') return refuse('S6', `${nodeId} is ${n.status}; checks are recorded only while checking`);
  if (n.kind === 'branch' && !childrenOf(draft, nodeId).every((k) => k.status === 'done')) return refuse('R3', `${nodeId} cannot be checked before all its children are done`);
  const e = draft.edit(nodeId);
  e.evidence = [...e.evidence, ...results.map((r) => ({ checkId: r.checkId, ok: r.ok, output: r.output ?? '', ts: r.ts ?? null, commit: r.commit ?? null }))];
  const ids = new Set(e.checks.map((c) => c.id));
  const allPass = results.length > 0 && [...ids].every((id) => results.some((r) => r.checkId === id && r.ok)) && results.every((r) => r.ok);
  const noChecks = e.checks.length === 0 && e.kind === 'branch';
  if (allPass || noChecks) {
    draft.setStatus(nodeId, 'done', noChecks ? 'all children done (no integration check)' : 'all checks passed');
  } else {
    e.attempts += 1;
    if (e.attempts >= fixCap) draft.setStatus(nodeId, 'blocked', `checks failed ${e.attempts} times (cap ${fixCap})`);
    else draft.setStatus(nodeId, e.kind === 'branch' ? 'split' : 'ready', `checks failed (attempt ${e.attempts} of ${fixCap})`);
  }
  return result(draft);
}

// ---------------------------------------------------------------- queries

export function leaves(tree) {
  const nodes = Object.values(tree.nodes);
  return nodes.filter((n) => !nodes.some((m) => m.parentId === n.id) && n.id !== tree.rootId);
}

export function topLevel(tree) {
  return Object.values(tree.nodes)
    .filter((n) => n.parentId === tree.rootId)
    .sort((a, b) => a.order - b.order);
}

export function children(tree, id) {
  return Object.values(tree.nodes)
    .filter((n) => n.parentId === id)
    .sort((a, b) => a.order - b.order);
}

export function resolved(tree) {
  const nodes = Object.values(tree.nodes);
  return nodes.length > 0 && nodes.every((n) => n.status === 'done' || n.status === 'blocked');
}
