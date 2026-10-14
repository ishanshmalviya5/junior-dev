// Run: the facade the host uses. Owns one feature's Store and its docs folder.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { sha256, proposeFeatureName, FEATURE_NAME, EngineError } from './util.js';
import { advance, DOC_FILES, PHASES, fingerprint } from './phases.js';
import { parseRequirements, parseVerificationPlan, parseSpecs, parsePlan } from './docs.js';
import * as T from './tree.js';
import { decide as decideThreshold } from './threshold.js';
import { renderReport } from './report.js';
import { progress as computeProgress } from './progress.js';
import * as G from './git.js';
import * as Locks from './locks.js';

export const DOCS_DIR = 'docs';

/** v2-04: the three answers to the red-first park question, recommended first. */
export const RED_FIRST_ANSWERS = Object.freeze({
  done: 'Check is fine, already done',
  rewrite: 'Rewrite the check',
  drop: 'Drop the leaf',
});
export function redFirstOutcome(answer) {
  const a = String(answer ?? '');
  if (/^drop/i.test(a)) return 'drop';
  if (/already done/i.test(a)) return 'done';
  return 'rewrite'; // anything unrecognised is the safe path: back to the planner
}

export function featureDir(sessionFolder, name) {
  return path.join(sessionFolder, DOCS_DIR, name);
}

/** A4/U16: unfinished features in a session folder. */
export function listFeatures(sessionFolder) {
  const root = path.join(sessionFolder, DOCS_DIR);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name, 'state');
    if (!Store.exists(dir)) continue;
    try {
      const st = Store.open(dir).state;
      out.push({ name, phase: st.phase, side: st.side, sideReason: st.sideReason, finished: st.phase === 'done' });
    } catch (e) {
      out.push({ name, phase: null, side: 'blocked', sideReason: e.message, finished: false, broken: true });
    }
  }
  return out;
}

export function resumeChoice(features) {
  const open = features.filter((f) => !f.finished);
  if (open.length === 0) return { mode: 'none', items: [] };
  if (open.length === 1) return { mode: 'direct', items: open };
  return { mode: 'pick', items: open };
}

/** U20: one question, plain options, the recommended one first and labelled. */
export function formatQuestion({ id, question, header, options = [], recommended, multiSelect = false, detail }) {
  if (!question || !String(question).trim()) throw new EngineError('ask', 'a question needs text');
  let opts = options.map((o) => (typeof o === 'string' ? { label: o } : { ...o }));
  if (recommended !== undefined) {
    const i = typeof recommended === 'number' ? recommended : opts.findIndex((o) => o.label === recommended);
    if (i >= 0) {
      const [r] = opts.splice(i, 1);
      if (!/\(Recommended\)$/.test(r.label)) r.label = `${r.label} (Recommended)`;
      opts = [r, ...opts];
    }
  }
  if (opts.length === 1) throw new EngineError('ask', 'a multiple-choice question needs at least two options');
  if (opts.length > 4) throw new EngineError('ask', 'at most four options; split the question');
  return { id, question, header: (header ?? 'junior-dev').slice(0, 12), detail, options: opts, multiSelect, freeAnswer: true };
}

export class Run {
  constructor(sessionFolder, name, store) {
    this.sessionFolder = sessionFolder;
    this.name = name;
    this.store = store;
  }

  get dir() {
    return featureDir(this.sessionFolder, this.name);
  }
  get state() {
    return this.store.state;
  }
  /** Lock identity: the run, not the chat (a run can resume in another session). */
  get lockKey() {
    return `${path.resolve(this.sessionFolder)}::${this.name}`;
  }

  static create({ sessionFolder, prdText, sessionId = null, name, storeOpts } = {}) {
    if (!prdText || !prdText.trim()) throw new EngineError('intake', 'the PRD text is empty');
    let base = name ?? proposeFeatureName(prdText);
    if (!FEATURE_NAME.test(base)) throw new EngineError('intake', `invalid feature name: ${base}`);
    let n = base;
    for (let i = 2; fs.existsSync(featureDir(sessionFolder, n)); i++) n = `${base}-${i}`;
    const dir = featureDir(sessionFolder, n);
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prd.md'), prdText);
    const store = Store.open(path.join(dir, 'state'), storeOpts);
    store.commit('created', { name: n, sessionFolder, sessionId, prdSha: sha256(prdText) });
    const run = new Run(sessionFolder, n, store);
    run.ensureExcluded();
    return run;
  }

  static open(sessionFolder, name, storeOpts) {
    const dir = path.join(featureDir(sessionFolder, name), 'state');
    if (!Store.exists(dir)) throw new EngineError('resume', `no feature "${name}" in ${sessionFolder}`);
    return new Run(sessionFolder, name, Store.open(dir, storeOpts));
  }

  /** S1.5 */
  ensureExcluded() {
    if (!G.isRepo(this.sessionFolder)) return false;
    const top = G.topLevel(this.sessionFolder);
    const rel = path.relative(top, this.dir);
    return G.excludeLocally(top, rel);
  }

  /** D2 (feature name): rename before any document exists. */
  rename(newName) {
    if (!FEATURE_NAME.test(newName)) throw new EngineError('rename', `invalid feature name: ${newName}`);
    if (newName === this.name) return;
    if (PHASES.indexOf(this.state.phase) > PHASES.indexOf('prd_parity')) throw new EngineError('rename', 'the feature can only be renamed before the requirements are written');
    const to = featureDir(this.sessionFolder, newName);
    if (fs.existsSync(to)) throw new EngineError('rename', `${newName} already exists`);
    const opts = { clock: this.store.clock, snapshotEvery: this.store.snapshotEvery, faults: this.store.faults };
    fs.renameSync(this.dir, to);
    this.name = newName;
    this.store = Store.open(path.join(to, 'state'), opts);
    this.store.commit('renamed', { name: newName });
    this.ensureExcluded();
  }

  prdText() {
    return fs.readFileSync(path.join(this.dir, 'prd.md'), 'utf8');
  }

  docPath(key) {
    return path.join(this.dir, DOC_FILES[key] ?? key);
  }

  readDoc(key) {
    const p = this.docPath(key);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  writeDoc(key, md) {
    fs.writeFileSync(this.docPath(key), md);
    return this.registerDoc(key);
  }

  /** Parse a doc and record its sha/ids; VP and plan also define checks. */
  registerDoc(key) {
    const md = this.readDoc(key);
    if (md === null) throw new EngineError('doc', `${DOC_FILES[key]} does not exist`);
    const reqIds = this.state.docs.requirements?.ids ?? [];
    let parsed;
    if (key === 'requirements') parsed = parseRequirements(md);
    else if (key === 'verificationPlan') parsed = parseVerificationPlan(md, reqIds);
    else if (key === 'specs') parsed = parseSpecs(md, reqIds);
    else if (key === 'implementationPlan') parsed = parsePlan(md, this.state.docs.specs?.ids ?? [], Object.keys(this.state.checks));
    else throw new EngineError('doc', `unknown doc ${key}`);
    const ids = key === 'requirements' ? parsed.ids : key === 'verificationPlan' ? parsed.checks.map((c) => c.id) : key === 'specs' ? parsed.items.map((i) => i.id) : parsed.steps.map((s) => s.id);
    this.store.commit('doc', { key, sha: sha256(md), ids, path: this.docPath(key) });
    if (key === 'verificationPlan') {
      for (const c of parsed.checks) {
        const prev = this.state.checks[c.id];
        this.store.commit('check_def', { id: c.id, kind: c.kind, requirementIds: c.proves, command: c.command ?? prev?.command ?? null, cwd: prev?.cwd ?? null, text: c.text });
      }
    }
    if (key === 'implementationPlan') {
      for (const [id, cmd] of Object.entries(parsed.commands)) {
        const prev = this.state.checks[id];
        if (!prev) continue;
        this.store.commit('check_def', { ...prev, command: cmd.command, cwd: cmd.cwd ?? prev.cwd });
      }
    }
    return parsed;
  }

  // -------------------------------------------------------------- research & interview
  addFact(text, source) {
    const id = `F${this.state.facts.length + 1}`;
    this.store.commit('fact', { id, text, source });
    return id;
  }
  overrideFact(id, text) {
    this.store.commit('fact_override', { id, text });
  }
  note(kind, text) {
    this.store.commit('note', { kind, text });
  }
  /** Saves the question before it is shown; answers are saved the moment they arrive (B4). */
  recordQuestion(q, { batchId } = {}) {
    const id = q.id ?? `Q${this.state.questions.length + 1}`;
    this.store.commit('question', { question: { ...q, id, phase: this.state.phase, batchId: batchId ?? null } });
    return id;
  }
  recordAnswer(id, answer) {
    this.store.commit('answer', { id, answer });
  }
  set(key, value) {
    if (!['repos', 'permissions', 'budget', 'models', 'crossModel', 'dial', 'fixCap'].includes(key)) throw new EngineError('setting', `unknown setting ${key}`);
    this.store.commit('setting', { key, value });
  }
  parity(key, yes) {
    if (key === 'final') {
      const fp = fingerprint(this.state, (k) => this.readDoc(k));
      this.store.commit('parity', { key, yes, docSha: fp.sha, parts: { docs: fp.docs, settings: fp.settings } });
      return;
    }
    const docKey = { requirements: 'requirements', verificationPlan: 'verificationPlan' }[key];
    const md = docKey ? this.readDoc(docKey) : null;
    if (docKey && md === null) throw new EngineError('parity', `${DOC_FILES[docKey]} does not exist yet; write it before asking for parity`);
    this.store.commit('parity', { key, yes, docSha: md ? sha256(md) : null });
  }
  preflight(id, what, ok, detail) {
    this.store.commit('preflight', { id, what, ok, detail });
  }

  // -------------------------------------------------------------- phases
  guardCtx(extra = {}) {
    const st = this.state;
    return {
      readDoc: (k) => this.readDoc(k),
      holdsLock: (r) => Locks.holds(r.path, { feature: this.lockKey }),
      headCommit: () => null,
      reportWritten: () => fs.existsSync(path.join(this.dir, 'report.md')),
      trackedDocFiles: () => this.trackedDocFiles(),
      ...extra,
    };
  }
  advance(to, extra, evidence) {
    return advance(this.store, to, this.guardCtx(extra), evidence);
  }
  trackedDocFiles() {
    const out = [];
    for (const r of this.state.settings.repos ?? []) {
      const repo = r.workPath ?? r.path;
      if (!G.isRepo(repo)) continue;
      const top = G.topLevel(repo);
      const rel = path.relative(top, this.dir);
      if (rel.startsWith('..')) continue;
      out.push(...G.trackedUnder(top, rel));
      if (r.baseRef) out.push(...G.committedUnder(top, r.baseRef, rel));
    }
    return [...new Set(out)];
  }

  // -------------------------------------------------------------- tree
  requirementIds() {
    return this.state.docs.requirements?.ids ?? [];
  }
  tree(op, ...args) {
    const fn = {
      init: T.init,
      split: T.split,
      add: T.add,
      remove: T.remove,
      setDeps: T.setDeps,
      setChecks: T.setChecks,
      changeContract: T.changeContract,
      claim: T.claim,
      submit: T.submit,
      startChecks: T.startChecks,
      park: T.park,
      unpark: T.unpark,
      block: T.block,
      reopen: T.reopen,
      recordChecks: T.recordChecks,
      abandon: T.abandon,
    }[op];
    if (!fn) throw new EngineError('tree', `unknown tree op ${op}`);
    const extra = { requirements: this.requirementIds(), fixCap: this.state.settings.fixCap ?? 3 };
    const res = ['split', 'add'].includes(op)
      ? fn(this.state.tree, ...args, extra)
      : op === 'recordChecks'
        ? fn(this.state.tree, args[0], args[1], extra)
        : op === 'abandon'
          ? fn(this.state.tree, args[0], args[1], { fixCap: extra.fixCap, ...(args[2] ?? {}) })
          : fn(this.state.tree, ...args);
    if (!res.ok) return res;
    this.store.commit('tree', { op, args: summarizeArgs(op, args), patch: res.patch, affected: res.affected });
    this.trackProgress();
    return res;
  }

  trackProgress() {
    const p = computeProgress(this.state);
    const known = this.state.progress.lastKnownLeaves ?? 0;
    if (p.bar.total !== known) {
      this.store.commit('progress', { progress: { lastKnownLeaves: p.bar.total, grewBy: p.bar.total > known && known > 0 ? p.bar.total - known : 0, steppedBackAt: p.bar.total > known && known > 0 ? new Date().toISOString() : this.state.progress.steppedBackAt } });
    }
    return p;
  }

  progress() {
    const p = computeProgress(this.state);
    p.grewBy = this.state.progress.grewBy ?? 0;
    return p;
  }

  // -------------------------------------------------------------- decisions & queue
  /** J8–J10: log the call; below the bar the node parks and its question is queued. */
  decide(d) {
    const id = d.id ?? `D${this.state.ledger.length + 1}`;
    const rec = decideThreshold(this.state.tree, this.state.settings.dial ?? 'balanced', { ...d, id });
    if (rec.outcome === 'park') {
      const qid = `QQ${this.state.queue.length + 1}`;
      rec.questionId = qid;
      this.store.commit('decision', { decision: rec });
      this.store.commit('queue_add', { item: { id: qid, nodeId: rec.nodeId, decisionId: id, text: d.question ?? d.what, options: d.options ?? [], recommended: d.choice } });
      if (rec.nodeId && this.state.tree.nodes[rec.nodeId] && this.state.tree.nodes[rec.nodeId].status !== 'parked') this.tree('park', rec.nodeId, qid);
    } else {
      this.store.commit('decision', { decision: rec });
    }
    return rec;
  }
  // -------------------------------------------------------------- red-first evidence (v2-03)
  leafBefore(nodeId, kind, { ok, output, commit }) {
    this.store.commit('leaf_before', { nodeId, kind, ok, output: String(output ?? '').slice(-1500), commit: commit ?? null });
  }
  leafAfter(nodeId, { ok, output, commit }) {
    this.store.commit('leaf_after', { nodeId, ok, output: String(output ?? '').slice(-1500), commit: commit ?? null });
  }
  leafReplan(nodeId) {
    this.store.commit('leaf_replan', { nodeId });
  }
  /** Park a leaf on a plain-words question for the developer (uses the existing queue and park). */
  parkLeaf(nodeId, text, options = [], { redFirst = false } = {}) {
    const qid = `QQ${this.state.queue.length + 1}`;
    this.store.commit('queue_add', { item: { id: qid, nodeId, decisionId: null, text, options, recommended: options[0] ?? null, redFirst } });
    this.store.commit('leaf_park', { nodeId, questionId: qid });
    return this.tree('park', nodeId, qid);
  }
  openQueue() {
    return this.state.queue.filter((q) => !q.resolvedAt);
  }
  /** Answers from a batch: resolve, record and unpark. */
  answerQueued(answers) {
    for (const { id, answer } of answers) {
      const q = this.state.queue.find((x) => x.id === id);
      if (!q || q.resolvedAt) continue;
      this.store.commit('queue_resolve', { id, answer });
      this.store.commit('note', { kind: 'queued_answer', text: JSON.stringify({ id, nodeId: q.nodeId, answer }) });
      if (q.nodeId && this.state.tree.nodes[q.nodeId]?.status === 'parked') this.tree('unpark', q.nodeId);
      if (q.redFirst && q.nodeId && this.state.tree.nodes[q.nodeId]) this.applyRedFirstAnswer(q.nodeId, redFirstOutcome(answer));
    }
  }
  /** v2-04: the developer's answer decides a behaviour leaf whose check was already green. */
  applyRedFirstAnswer(nodeId, outcome) {
    this.store.commit('leaf_answer', { nodeId, outcome });
    if (outcome === 'rewrite') return; // the loop sends it back to the planner
    const node = this.state.tree.nodes[nodeId];
    if (outcome === 'done') {
      const ev = this.state.leafEvidence[nodeId]?.before;
      const proof = `already satisfied before any work (developer confirmed): ${ev?.output ?? ''}`;
      this.leafAfter(nodeId, { ok: true, output: proof, commit: ev?.commit });
      const started = this.tree('startChecks', nodeId);
      if (started.ok) this.tree('recordChecks', nodeId, node.checks.map((c) => ({ checkId: c.id, ok: true, output: proof, commit: ev?.commit ?? null })));
      return;
    }
    const r = this.tree('remove', nodeId); // ripple rules R1/R4/R5 decide whether it can go
    if (!r.ok) {
      const id = this.blocker({ nodeId, what: `the developer asked to drop ${nodeId}, but the work tree needs it`, why: r.reasons.join('; '), how: 'ripple rules on removal', fixes: [] });
      this.note('leaf_drop_refused', `${nodeId}: ${r.reasons.join('; ')} (blocker ${id})`);
    }
  }

  // -------------------------------------------------------------- checks, blockers, usage
  recordCheck(id, result) {
    this.store.commit('check_result', { id, ...result });
  }
  checkAttempt(id) {
    this.store.commit('check_attempt', { id });
  }
  blocker(b) {
    const id = b.id ?? `B${this.state.blockers.length + 1}`;
    this.store.commit('blocker', { blocker: { id, nodeId: b.nodeId ?? null, checkId: b.checkId ?? null, what: b.what, why: b.why, how: b.how, fixes: b.fixes ?? [] } });
    const n = b.nodeId && this.state.tree.nodes[b.nodeId];
    if (n && !['blocked', 'done'].includes(n.status)) this.tree('block', b.nodeId, id);
    return id;
  }
  usage(u) {
    this.store.commit('usage', u);
  }
  workerStart(w) {
    const id = w.id ?? `W${this.state.workers.length + 1}`;
    this.store.commit('worker', { worker: { ...w, id } });
    return id;
  }
  workerEnd(id, outcome) {
    this.store.commit('worker_end', { id, outcome });
  }

  writeReport() {
    const md = renderReport(this.state);
    fs.writeFileSync(path.join(this.dir, 'report.md'), md);
    fs.writeFileSync(path.join(this.dir, 'ledger.md'), renderLedger(this.state));
    return md;
  }
}

function summarizeArgs(op, args) {
  try {
    return JSON.parse(JSON.stringify(args));
  } catch {
    return { op };
  }
}

function renderLedger(state) {
  const L = ['# Decision ledger', '', '| ID | Item | What | Choice | Why | Proof | Score | Bar | Radius | Outcome |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const d of state.ledger) {
    const proof = Object.entries(d.proof).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
    L.push(`| ${d.id} | ${d.nodeId ?? ''} | ${d.what} | ${d.choice} | ${d.why} | ${proof} | ${d.score} | ${d.bar} | ${d.radius} | ${d.outcome} |`);
  }
  return L.join('\n') + '\n';
}
