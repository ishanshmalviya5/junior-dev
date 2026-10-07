// The single reducer for feature state. Deterministic: replaying the same events
// always yields the same state (S1.4). It mutates the state it is given and returns it;
// the Store owns the only live instance.

export function initialState() {
  return {
    version: 1,
    feature: null,
    phase: null,
    side: null,
    sideReason: null,
    resumePhase: null,
    history: [],
    prd: null,
    facts: [],
    questions: [],
    settings: {
      repos: undefined,
      permissions: undefined,
      budget: undefined,
      models: undefined,
      crossModel: undefined,
      dial: undefined,
      fixCap: 3,
    },
    parity: {},
    docs: {},
    checks: {},
    preflight: [],
    tree: { rootId: null, nodes: {}, contracts: {} },
    ledger: [],
    queue: [],
    blockers: [],
    usage: { tokens: 0, costUsd: 0, activeMs: 0, byNode: {} },
    workers: [],
    progress: { lastKnownLeaves: 0, steppedBackAt: null, grewBy: 0 },
    delivery: { branches: [], prs: [] },
    notes: [],
  };
}

const handlers = {
  created(s, d) {
    s.feature = { name: d.name, sessionFolder: d.sessionFolder, sessionId: d.sessionId ?? null, createdAt: d.ts };
    s.prd = { sha256: d.prdSha };
    s.phase = 'intake';
  },
  renamed(s, d) {
    s.feature.name = d.name;
  },
  phase(s, d) {
    s.history.push({ from: d.from, to: d.to, ts: d.ts, ok: true, reasons: [], evidence: d.evidence ?? null });
    s.phase = d.to;
  },
  phase_refused(s, d) {
    s.history.push({ from: d.from, to: d.to, ts: d.ts, ok: false, reasons: d.reasons, evidence: d.evidence ?? null });
  },
  side(s, d) {
    s.side = d.side;
    s.sideReason = d.reason ?? null;
    if (d.side === null) s.resumePhase = null;
    else if (d.resumePhase) s.resumePhase = d.resumePhase;
  },
  fact(s, d) {
    s.facts.push({ id: d.id, text: d.text, source: d.source });
  },
  fact_override(s, d) {
    const f = s.facts.find((x) => x.id === d.id);
    if (f) f.override = { text: d.text, ts: d.ts };
  },
  note(s, d) {
    s.notes.push({ kind: d.kind, text: d.text, ts: d.ts });
  },
  question(s, d) {
    s.questions.push({ ...d.question, answer: undefined, askedAt: d.ts, answeredAt: null });
  },
  answer(s, d) {
    const q = s.questions.find((x) => x.id === d.id);
    if (q) {
      q.answer = d.answer;
      q.answeredAt = d.ts;
    }
  },
  setting(s, d) {
    s.settings[d.key] = d.value;
  },
  parity(s, d) {
    s.parity[d.key] = { yes: d.yes, ts: d.ts, docSha: d.docSha ?? null, parts: d.parts ?? null };
  },
  doc(s, d) {
    s.docs[d.key] = { sha: d.sha, ids: d.ids ?? [], path: d.path };
  },
  check_def(s, d) {
    const prev = s.checks[d.id];
    s.checks[d.id] = {
      id: d.id,
      kind: d.kind,
      requirementIds: d.requirementIds ?? [],
      command: d.command ?? null,
      cwd: d.cwd ?? null,
      text: d.text ?? '',
      results: prev?.results ?? [],
      attempts: prev?.attempts ?? 0,
    };
  },
  check_result(s, d) {
    const c = s.checks[d.id];
    if (!c) return;
    c.results.push({ ok: d.ok, output: d.output, ts: d.ts, commit: d.commit ?? null, by: d.by ?? 'runner' });
  },
  check_attempt(s, d) {
    const c = s.checks[d.id];
    if (c) c.attempts = (c.attempts ?? 0) + 1;
  },
  preflight(s, d) {
    const i = s.preflight.findIndex((p) => p.id === d.id);
    const entry = { id: d.id, what: d.what, ok: d.ok, detail: d.detail ?? '' };
    if (i >= 0) s.preflight[i] = entry;
    else s.preflight.push(entry);
  },
  tree(s, d) {
    const p = d.patch;
    if (p.rootId !== undefined) s.tree.rootId = p.rootId;
    for (const [id, node] of Object.entries(p.nodes ?? {})) s.tree.nodes[id] = node;
    for (const id of p.deleteNodes ?? []) delete s.tree.nodes[id];
    for (const [id, c] of Object.entries(p.contracts ?? {})) s.tree.contracts[id] = c;
  },
  decision(s, d) {
    s.ledger.push(d.decision);
  },
  queue_add(s, d) {
    s.queue.push({ ...d.item, createdAt: d.ts, resolvedAt: null });
  },
  queue_resolve(s, d) {
    const q = s.queue.find((x) => x.id === d.id);
    if (q) q.resolvedAt = d.ts;
  },
  blocker(s, d) {
    s.blockers.push({ ...d.blocker, ts: d.ts });
  },
  usage(s, d) {
    s.usage.tokens += d.tokens ?? 0;
    s.usage.costUsd += d.costUsd ?? 0;
    s.usage.activeMs += d.activeMs ?? 0;
    if (d.nodeId) {
      const b = (s.usage.byNode[d.nodeId] ??= { tokens: 0, costUsd: 0 });
      b.tokens += d.tokens ?? 0;
      b.costUsd += d.costUsd ?? 0;
    }
  },
  worker(s, d) {
    s.workers.push({ ...d.worker, startedAt: d.ts, endedAt: null, outcome: null });
  },
  worker_end(s, d) {
    const w = s.workers.find((x) => x.id === d.id);
    if (w) {
      w.endedAt = d.ts;
      w.outcome = d.outcome;
    }
  },
  progress(s, d) {
    s.progress = { ...s.progress, ...d.progress };
  },
  delivery(s, d) {
    if (d.branch) s.delivery.branches.push(d.branch);
    if (d.pr) s.delivery.prs.push(d.pr);
  },
};

export function reduce(state, event) {
  const h = handlers[event.type];
  if (!h) throw new Error(`unknown event type: ${event.type}`);
  h(state, { ...event.data, ts: event.ts });
  return state;
}

export const EVENT_TYPES = Object.freeze(Object.keys(handlers));
