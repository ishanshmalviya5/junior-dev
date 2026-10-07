// S21 / S22: model-facing tools. Root tools drive the interview and documents; worker tools act on the current item only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Run, listFeatures, resumeChoice, formatQuestion } from '../engine/run.js';
import { PHASES, resettle as resettlePhase, resume as resumeSide, pause as pausePhase } from '../engine/phases.js';
import { renderProgress } from '../engine/progress.js';
import { runCheck } from '../engine/checks.js';
import { radius as computeRadius } from '../engine/threshold.js';
import * as G from '../engine/git.js';
import * as Locks from '../engine/locks.js';
import { hub, attach, rekey, isChild, handleForAgent, handleForSession } from './hub.js';
import * as S from './services.js';
import { nextStep, secondOpinionBrief } from './prompts.js';
import { startLoop, resolveCwd } from './loop.js';

const TEXT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };
const json = (v) => JSON.stringify(v, null, 2);
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function who(exec) {
  const agent = exec?.agent;
  if (!agent) throw new Error('junior-dev tools need an agent');
  return { agent, sessionId: agent.id, cwd: agent.session?.header?.cwd ?? process.cwd(), child: isChild(agent) };
}

function rootOnly(exec) {
  const w = who(exec);
  if (w.child) throw new Error('This junior-dev tool is for the developer-facing agent only.');
  return w;
}

function current(exec) {
  const w = rootOnly(exec);
  const h = handleForSession(w.sessionId, w.cwd);
  if (!h) throw new Error('No junior-dev run is attached to this chat. Call jd_start with a pasted PRD, or jd_resume.');
  return { ...w, h, run: h.run };
}

const phaseIdx = (p) => PHASES.indexOf(p);
const before = (run, p) => phaseIdx(run.state.phase) < phaseIdx(p);

function latestUserText(agent) {
  const msgs = agent.session?.deriveMessages?.() ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    const t = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (t && !t.startsWith('[junior-dev]')) return t;
  }
  return null;
}

function status(h) {
  const run = h.run;
  const st = run.state;
  return {
    feature: run.name,
    folder: run.dir,
    phase: st.phase,
    side: st.side,
    sideReason: st.sideReason,
    loopRunning: Boolean(h.loop),
    openQuestions: st.questions.filter((q) => q.answer === undefined).map((q) => q.id),
    queued: run.openQueue().length,
    progress: st.tree.rootId ? renderProgress(run.progress()) : null,
    next: nextStep(st, { loopRunning: Boolean(h.loop) }),
  };
}

// ---------------------------------------------------------------- settings validation
function validateSetting(key, value) {
  const m = (x) => x && typeof x.provider === 'string' && typeof x.model === 'string';
  switch (key) {
    case 'repos':
      if (!Array.isArray(value) || !value.length) return 'repos must be a non-empty list of {path, mode}';
      for (const r of value) {
        if (!r.path || !path.isAbsolute(r.path)) return `repo path must be absolute: ${r.path}`;
        if (!fs.existsSync(r.path) || !G.isRepo(r.path)) return `${r.path} is not a git repository`;
        if (!['worktree', 'in-place'].includes(r.mode)) return `mode for ${r.path} must be "worktree" or "in-place"`;
      }
      return null;
    case 'permissions':
      if (typeof value?.push !== 'boolean' || typeof value?.pr !== 'boolean') return 'permissions need push and pr booleans';
      if (value.pr && !value.push) return 'opening PRs needs push permission too';
      if (!('debugEnv' in value)) return 'permissions need debugEnv (null if no debug-env testing is allowed)';
      return null;
    case 'budget':
      if (!value || !(value.timeMin || value.tokens || value.costUsd)) return 'budget needs at least one of timeMin, tokens, costUsd';
      if (value.costUsd && !value.pricePerMTokUsd) return 'a cost limit needs pricePerMTokUsd (DSH exposes no token prices)';
      return null;
    case 'models':
      for (const role of ['planner', 'builder', 'checker']) if (!m(value?.[role])) return `models.${role} must be {provider, model} (see jd_models)`;
      return null;
    case 'crossModel':
      if (typeof value?.enabled !== 'boolean') return 'crossModel needs enabled: true|false';
      if (value.enabled && !m(value.model)) return 'crossModel.model must be {provider, model}';
      return null;
    case 'dial':
      return ['careful', 'balanced', 'bold'].includes(value) ? null : 'dial is careful, balanced or bold';
    case 'fixCap':
      return Number.isInteger(value) && value >= 1 && value <= 10 ? null : 'fixCap is an integer 1–10';
    default:
      return `unknown setting ${key}`;
  }
}

// ---------------------------------------------------------------- root tools
export const rootTools = [
  {
    name: 'jd_status',
    description: 'junior-dev: current run status and the exact next step. Call this first.',
    parameters: obj({}),
    output: TEXT,
    async execute(_args, exec) {
      const w = rootOnly(exec);
      const h = handleForSession(w.sessionId, w.cwd);
      if (!h) {
        const features = listFeatures(w.cwd).filter((f) => !f.finished);
        return json({ run: null, unfinished: features, next: 'If the developer pasted a PRD, call jd_start. If they want to continue earlier work, call jd_resume.' });
      }
      return json(status(h));
    },
  },
  {
    name: 'jd_start',
    description: "junior-dev: start a new run from the PRD the developer pasted (read verbatim from their latest message; never retype it).",
    parameters: obj({ name: { type: 'string', description: 'optional kebab-case feature name proposal' } }),
    output: TEXT,
    async execute(args, exec) {
      const w = rootOnly(exec);
      const existing = handleForSession(w.sessionId, w.cwd);
      if (existing && existing.run.state.phase !== 'done') throw new Error(`A run ("${existing.run.name}") is already attached to this chat. Use jd_status.`);
      const prd = latestUserText(w.agent);
      if (!prd || prd.length < 40) throw new Error('No PRD found in the latest developer message. Ask them to paste the PRD text.');
      const run = Run.create({ sessionFolder: w.cwd, prdText: prd, sessionId: w.sessionId, name: args.name });
      const h = attach(run, w.sessionId);
      const r = run.advance('research');
      return json({ started: run.name, folder: run.dir, prdChars: prd.length, advanced: r.ok, ...status(h) });
    },
  },
  {
    name: 'jd_resume',
    description: 'junior-dev: resume an unfinished run in this folder (lists them if several and no name is given).',
    parameters: obj({ name: { type: 'string' } }),
    output: TEXT,
    async execute(args, exec) {
      const w = rootOnly(exec);
      const choice = resumeChoice(listFeatures(w.cwd));
      let pick = args.name ? choice.items.find((i) => i.name === args.name) : choice.mode === 'direct' ? choice.items[0] : null;
      if (!pick) {
        if (choice.mode === 'none') return json({ resumed: null, message: 'No unfinished junior-dev runs in this folder.' });
        if (args.name) throw new Error(`No unfinished run named "${args.name}". Unfinished: ${choice.items.map((i) => i.name).join(', ')}`);
        return json({ resumed: null, pick: choice.items, next: 'Ask the developer which run to resume (jd_ask), then call jd_resume with its name.' });
      }
      const run = Run.open(w.cwd, pick.name);
      const h = attach(run, w.sessionId);
      if (run.state.side === 'stopped' || run.state.side === 'paused') {
        // keep paused until resettle; stopped resumes on jd_run
      }
      return json({ resumed: run.name, ...status(h) });
    },
  },
  {
    name: 'jd_fact',
    description: 'junior-dev: record a research finding with its source, or override a fact the developer corrected, or note that there is nothing to research.',
    parameters: obj({ text: { type: 'string' }, source: { type: 'string' }, overrideId: { type: 'string' }, note: { type: 'string', enum: ['nothing_to_research'] } }),
    output: TEXT,
    async execute(args, exec) {
      const { run } = current(exec);
      if (args.note) {
        run.note(args.note, args.text ?? '');
        return 'noted';
      }
      if (args.overrideId) {
        run.overrideFact(args.overrideId, args.text);
        return `fact ${args.overrideId} overridden`;
      }
      if (!args.text || !args.source) throw new Error('a fact needs text and source');
      return `recorded ${run.addFact(args.text, args.source)}`;
    },
  },
  {
    name: 'jd_ask',
    description: 'junior-dev: ask the developer ONE simple question (multiple choice when possible, recommended option marked). Recorded with its answer.',
    parameters: obj(
      {
        question: { type: 'string' },
        header: { type: 'string', description: '≤12 chars' },
        detail: { type: 'string' },
        options: { type: 'array', items: { anyOf: [{ type: 'string' }, obj({ label: { type: 'string' }, description: { type: 'string' } }, ['label'])] } },
        recommended: { type: 'string', description: 'label of the recommended option' },
        multiSelect: { type: 'boolean' },
      },
      ['question'],
    ),
    output: TEXT,
    async execute(args, exec) {
      const { h, run, agent } = current(exec);
      const q = formatQuestion({ ...args, id: `Q${run.state.questions.length + 1}` });
      const id = run.recordQuestion({ id: q.id, text: q.question, options: q.options.map((o) => o.label), recommended: args.recommended ?? null, multi: q.multiSelect });
      const [a] = await S.ask(h, [q], { agent, signal: exec.signal });
      const text = S.answerText(a) || '(skipped)';
      run.recordAnswer(id, text);
      return json({ id, answer: text });
    },
  },
  {
    name: 'jd_set',
    description: 'junior-dev: record a setting the developer settled. key: name | repos | permissions | budget | models | crossModel | dial | fixCap.',
    parameters: obj({ key: { type: 'string' }, value: {} }, ['key', 'value']),
    output: TEXT,
    async execute(args, exec) {
      const { h, run } = current(exec);
      if (args.key === 'name') {
        run.rename(String(args.value));
        rekey(h);
        return `feature renamed to ${run.name}`;
      }
      const err = validateSetting(args.key, args.value);
      if (err) throw new Error(err);
      if (!before(run, 'build') && run.state.side !== 'paused' && !['budget'].includes(args.key)) throw new Error('settings are fixed once the build starts; pause the run first (jd_pause) to change them');
      run.set(args.key, args.value);
      return `${args.key} recorded`;
    },
  },
  {
    name: 'jd_models',
    description: 'junior-dev: list the models configured in DSH ({provider, model}) so the developer can pick one per role.',
    parameters: obj({}),
    output: TEXT,
    async execute(_a, exec) {
      rootOnly(exec);
      return json(await S.listModels());
    },
  },
  {
    name: 'jd_write_doc',
    description: 'junior-dev: write a document (requirements | verificationPlan | specs | implementationPlan) and validate it. Fix every reason returned.',
    parameters: obj({ key: { type: 'string', enum: ['requirements', 'verificationPlan', 'specs', 'implementationPlan'] }, content: { type: 'string' } }, ['key', 'content']),
    output: TEXT,
    async execute(args, exec) {
      const { run } = current(exec);
      const earliest = { requirements: 'requirements', verificationPlan: 'verification_plan', specs: 'specs', implementationPlan: 'implementation_plan' }[args.key];
      if (before(run, earliest)) throw new Error(`${args.key} is written in the ${earliest} phase; the run is in ${run.state.phase}`);
      if (!before(run, 'build') && run.state.side !== 'paused') throw new Error('documents are fixed during the build; pause first (jd_pause)');
      const parsed = run.writeDoc(args.key, args.content);
      return json({ ok: parsed.ok, reasons: parsed.reasons, ids: parsed.ids ?? parsed.checks?.map((c) => c.id) ?? parsed.items?.map((i) => i.id) ?? parsed.steps?.map((s) => s.id) });
    },
  },
  {
    name: 'jd_parity',
    description: 'junior-dev: present your restatement to the developer and record their yes. key: prd | requirements | verificationPlan | final.',
    parameters: obj({ key: { type: 'string', enum: ['prd', 'requirements', 'verificationPlan', 'final'] }, restatement: { type: 'string' } }, ['key', 'restatement']),
    output: TEXT,
    async execute(args, exec) {
      const { h, run, agent } = current(exec);
      const label = { prd: 'the PRD', requirements: 'the requirements', verificationPlan: 'the verification plan', final: 'the whole plan' }[args.key];
      const q = { id: `P${run.state.questions.length + 1}`, question: `Parity check on ${label}: is this exactly what you mean?`, header: 'Parity', detail: args.restatement, options: [{ label: 'Yes' }, { label: 'Not quite', description: 'say what is off in the note' }] };
      const id = run.recordQuestion({ id: q.id, text: q.question, options: ['Yes', 'Not quite'], detail: args.restatement });
      const [a] = await S.ask(h, [q], { agent, signal: exec.signal });
      const yes = a.selected.some((s) => /^yes/i.test(s));
      run.recordAnswer(id, S.answerText(a));
      run.parity(args.key, yes);
      return json({ parity: yes, note: a.custom ?? null, next: yes ? nextStep(run.state) : 'Not yet: ask follow-ups with jd_ask, update, and call jd_parity again.' });
    },
  },
  {
    name: 'jd_tree',
    description: 'junior-dev: build the top of the work tree before the build. op: init | split | add | setDeps | remove.',
    parameters: obj({ op: { type: 'string', enum: ['init', 'split', 'add', 'setDeps', 'remove'] }, nodeId: { type: 'string' }, parentId: { type: 'string' }, children: { type: 'array', items: { type: 'object' } }, child: { type: 'object' }, deps: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } }, ['op']),
    output: TEXT,
    async execute(args, exec) {
      const { run } = current(exec);
      if (!['implementation_plan', 'preflight', 'final_parity'].includes(run.state.phase) && run.state.side !== 'paused') throw new Error('the work tree is planned in implementation_plan (workers change it during the build)');
      let r;
      if (args.op === 'init') r = run.tree('init', { requirements: run.requirementIds(), title: args.title ?? run.name });
      else if (args.op === 'split') r = run.tree('split', args.nodeId ?? 'N', args.children ?? []);
      else if (args.op === 'add') r = run.tree('add', args.parentId ?? 'N', args.child ?? {});
      else if (args.op === 'setDeps') r = run.tree('setDeps', args.nodeId, args.deps ?? []);
      else r = run.tree('remove', args.nodeId);
      return json(r.ok ? { ok: true, affected: r.affected, progress: renderProgress(run.progress()) } : { ok: false, rule: r.rule, reasons: r.reasons });
    },
  },
  {
    name: 'jd_preflight',
    description: 'junior-dev: prove every tool, MCP, credential and repo the plan needs works. Give shell commands; the plugin runs them and checks every chosen model.',
    parameters: obj({ items: { type: 'array', items: obj({ id: { type: 'string' }, what: { type: 'string' }, command: { type: 'string' }, cwd: { type: 'string' } }, ['what', 'command']) } }, ['items']),
    output: TEXT,
    async execute(args, exec) {
      const { run } = current(exec);
      const out = [];
      for (const [i, it] of args.items.entries()) {
        const r = await runCheck({ command: it.command, cwd: it.cwd ?? run.sessionFolder }, { timeoutMs: 120000, signal: exec.signal });
        const id = it.id ?? `pf${i + 1}`;
        run.preflight(id, it.what, r.ok, r.ok ? '' : r.output.slice(-300));
        out.push({ id, what: it.what, ok: r.ok, detail: r.ok ? '' : r.output.slice(-300) });
      }
      const models = { ...(run.state.settings.models ?? {}) };
      if (run.state.settings.crossModel?.enabled) models.crossModel = run.state.settings.crossModel.model;
      for (const [role, m] of Object.entries(models)) {
        if (!m?.provider) continue;
        const r = await S.checkModel(m);
        run.preflight(`model:${role}`, `model for ${role}: ${m.provider}/${m.model}`, r.ok, r.ok ? '' : r.detail);
        out.push({ id: `model:${role}`, ok: r.ok, detail: r.detail });
      }
      return json({ ok: out.every((o) => o.ok), results: out });
    },
  },
  {
    name: 'jd_advance',
    description: 'junior-dev: ask to move to the next phase. The guards decide and say exactly what is missing.',
    parameters: obj({ to: { type: 'string', enum: PHASES.slice(1, PHASES.indexOf('build')) } }, ['to']),
    output: TEXT,
    async execute(args, exec) {
      const { h, run } = current(exec);
      const r = run.advance(args.to);
      return json(r.ok ? { ok: true, ...status(h) } : { ok: false, reasons: r.reasons });
    },
  },
  {
    name: 'jd_prepare',
    description: 'junior-dev: take the locks and prepare the workspaces (worktree or in place, branch junior-dev/<feature>) before the final parity.',
    parameters: obj({}),
    output: TEXT,
    async execute(_a, exec) {
      const { h, run, sessionId } = current(exec);
      if (run.state.phase !== 'final_parity') throw new Error(`jd_prepare runs in final_parity (now ${run.state.phase})`);
      const repos = run.state.settings.repos ?? [];
      if (!repos.length) throw new Error('repos are not settled (jd_set repos)');
      const done = [];
      for (const r of repos) {
        const l = Locks.acquire(r.path, { feature: run.lockKey, sessionId });
        if (!l.ok) throw new Error(l.reason);
        const branch = `junior-dev/${run.name}`;
        const baseBranch = r.baseBranch ?? G.branch(r.path);
        const prep = r.workPath && r.branch ? { workPath: r.workPath, baseRef: r.baseRef } : G.prepareWorkspace(r.path, { mode: r.mode, branch, worktreesRoot: path.join(process.env.JD_WORKTREES_ROOT ?? path.join(os.homedir(), '.junior-dev', 'worktrees'), run.name) });
        done.push({ ...r, branch, baseBranch, workPath: prep.workPath, baseRef: prep.baseRef });
      }
      run.set('repos', done);
      const full = await S.setFullAccess(h);
      return json({ prepared: done.map((r) => ({ repo: r.path, workPath: r.workPath, branch: r.branch })), localActionsAutoApproved: full, next: nextStep(run.state) });
    },
  },
  {
    name: 'jd_run',
    description: 'junior-dev: start or resume the unattended build loop (after the final parity yes).',
    parameters: obj({}),
    output: TEXT,
    async execute(_a, exec) {
      const { h, run } = current(exec);
      const st = run.state;
      if (st.side === 'paused') throw new Error('the run is paused: settle the change and call jd_resettle first');
      if (st.side === 'blocked') throw new Error(`the run is blocked: ${st.sideReason}`);
      if (phaseIdx(st.phase) < phaseIdx('final_parity')) throw new Error(`the build starts after the final parity (now ${st.phase})`);
      if (st.phase === 'final_parity' && !st.parity.final?.yes) throw new Error('no final parity yes yet (jd_parity key "final")');
      if (st.phase === 'done') return 'the run is already done';
      if (st.side === 'stopped') resumeSide(run.store);
      const started = startLoop(h);
      return started ? 'The build loop started. Tell the developer they can step away; progress shows above the input box. Do not do the work yourself.' : 'The build loop is already running.';
    },
  },
  {
    name: 'jd_pause',
    description: 'junior-dev: the developer wants to change something mid-run. Pauses at the next checkpoint.',
    parameters: obj({ reason: { type: 'string' } }, ['reason']),
    output: TEXT,
    async execute(args, exec) {
      const { h, run } = current(exec);
      if (h.loop) {
        h.pauseRequested = args.reason;
        return json({ pausing: true, next: 'The loop pauses at its next checkpoint (after the current item) and will message you. Meanwhile, settle the change with the developer using jd_ask.' });
      }
      const r = pausePhase(run.store, args.reason);
      if (!r.ok) throw new Error(r.reasons.join('; '));
      return json({ paused: true, next: nextStep(run.state) });
    },
  },
  {
    name: 'jd_resettle',
    description: 'junior-dev: after a paused change is settled and the documents updated, rewind to the earliest affected phase.',
    parameters: obj({ target: { type: 'string', enum: ['requirements', 'verification_plan', 'specs', 'implementation_plan', 'build'] }, changedDocs: { type: 'array', items: { type: 'string', enum: ['requirements', 'verificationPlan', 'specs', 'implementationPlan'] } } }, ['target']),
    output: TEXT,
    async execute(args, exec) {
      const { run } = current(exec);
      const r = resettlePhase(run.store, args.target, { changedDocs: args.changedDocs ?? [] });
      if (!r.ok) throw new Error(r.reasons.join('; '));
      return json({ phase: run.state.phase, next: nextStep(run.state) });
    },
  },
];

// ---------------------------------------------------------------- worker tools
function workerCtx(exec) {
  const w = who(exec);
  if (!w.child) throw new Error('This tool is for junior-dev workers only.');
  const h = handleForAgent(w.agent);
  if (!h || !h.worker) throw new Error('No junior-dev item is assigned to you right now.');
  return { ...w, h, run: h.run, job: h.worker };
}

function inSubtree(nodeId, rootId) {
  return nodeId === rootId || nodeId.startsWith(rootId + '.');
}

export const workerTools = [
  {
    name: 'jd_node',
    description: 'junior-dev worker: your assigned item (or failing check) in full.',
    parameters: obj({}),
    output: TEXT,
    async execute(_a, exec) {
      const { run, job } = workerCtx(exec);
      if (!job.nodeId) return json({ checkId: job.checkId, check: run.state.checks[job.checkId] ?? null });
      const n = run.state.tree.nodes[job.nodeId];
      return json({ node: n, contracts: [...n.provides, ...n.uses].map((c) => run.state.tree.contracts[c]) });
    },
  },
  {
    name: 'jd_submit',
    description: 'junior-dev worker: you finished; the plugin now runs the checks itself.',
    parameters: obj({ summary: { type: 'string' } }, ['summary']),
    output: TEXT,
    async execute(args, exec) {
      const { run, job } = workerCtx(exec);
      run.note('worker_summary', `${job.nodeId ?? job.checkId}: ${args.summary}`);
      if (!job.nodeId) return 'Submitted. The plugin will re-run the checks. End your turn now.';
      const n = run.state.tree.nodes[job.nodeId];
      if (n.status !== 'working') throw new Error(`${job.nodeId} is ${n.status}; nothing to submit`);
      const r = run.tree('submit', job.nodeId, {});
      if (!r.ok) throw new Error(r.reasons.join('; '));
      return 'Submitted. The plugin runs the checks and commits if they pass. End your turn now.';
    },
  },
  {
    name: 'jd_split',
    description: 'junior-dev worker: break your item into smaller children (planning). Code-enforced rules apply.',
    parameters: obj({ children: { type: 'array', items: { type: 'object' } } }, ['children']),
    output: TEXT,
    async execute(args, exec) {
      const { run, job } = workerCtx(exec);
      if (!job.nodeId) throw new Error('fix workers cannot split');
      const r = run.tree('split', job.nodeId, args.children);
      return json(r.ok ? { ok: true, children: r.affected.filter((id) => id.startsWith(job.nodeId + '.')), next: 'End your turn now; the scheduler picks the children up.' } : { ok: false, rule: r.rule, reasons: r.reasons });
    },
  },
  {
    name: 'jd_add',
    description: 'junior-dev worker: add a missing child under your item or one of its descendants.',
    parameters: obj({ parentId: { type: 'string' }, child: { type: 'object' } }, ['parentId', 'child']),
    output: TEXT,
    async execute(args, exec) {
      const { run, job } = workerCtx(exec);
      if (!job.nodeId || !inSubtree(args.parentId, job.nodeId)) throw new Error(`you may only add under your own item ${job.nodeId}`);
      const r = run.tree('add', args.parentId, args.child);
      return json(r.ok ? { ok: true, affected: r.affected } : { ok: false, rule: r.rule, reasons: r.reasons });
    },
  },
  {
    name: 'jd_contract',
    description: 'junior-dev worker: change a contract your item provides (other items that use it will be re-checked).',
    parameters: obj({ contractId: { type: 'string' }, description: { type: 'string' } }, ['contractId', 'description']),
    output: TEXT,
    async execute(args, exec) {
      const { run, job } = workerCtx(exec);
      const r = run.tree('changeContract', args.contractId, { description: args.description, byNodeId: job.nodeId });
      return json(r.ok ? { ok: true, recheck: r.affected } : { ok: false, rule: r.rule, reasons: r.reasons });
    },
  },
  {
    name: 'jd_decide',
    description:
      'junior-dev worker: record a choice the documents do not settle. Give evidence; the plugin scores it (it runs your test command itself and asks a second agent for shared changes) and answers proceed or park. On park, stop and end your turn.',
    parameters: obj(
      {
        what: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        choice: { type: 'string' },
        why: { type: 'string' },
        question: { type: 'string', description: 'plain-words question for the developer if this parks' },
        evidence: obj({ source: { type: 'string', description: 'file/doc/URL backing the choice' }, testCommand: { type: 'string', description: 'a command that passes only if the choice is right' }, fitsContract: { type: 'string', description: 'why it fits the requirements' } }),
        change: obj({ contracts: { type: 'array', items: { type: 'string' } }, otherNodes: { type: 'array', items: { type: 'string' } }, touchesDocs: { type: 'boolean' }, irreversible: { type: 'boolean' }, remote: { type: 'boolean' } }),
      },
      ['what', 'choice', 'why'],
    ),
    output: TEXT,
    async execute(args, exec) {
      const { h, run, job } = workerCtx(exec);
      const ev = args.evidence ?? {};
      const proof = { source: Boolean(ev.source?.trim()), fitsContract: Boolean(ev.fitsContract?.trim()), test: false, secondAgent: null };
      const evidence = [ev.source && `source: ${ev.source}`, ev.fitsContract && `fits: ${ev.fitsContract}`].filter(Boolean);
      if (ev.testCommand) {
        const r = await runCheck({ command: ev.testCommand, cwd: resolveCwd(run, null) }, { timeoutMs: 300000, signal: exec.signal });
        proof.test = r.ok;
        evidence.push(`test ${r.ok ? 'passed' : 'failed'}: ${ev.testCommand}`);
      }
      const change = { ...(args.change ?? {}), nodeId: job.nodeId ?? null };
      if (computeRadius(run.state.tree, change) === 'shared') {
        try {
          const model = run.state.settings.models?.checker;
          const res = await S.spawnWorker(h, { role: 'second-opinion', prompt: secondOpinionBrief({ ...args, evidence }), model, signal: exec.signal, register: false });
          const m = res.text?.match(/\{[\s\S]*\}/);
          const verdict = JSON.parse(m?.[0] ?? '{}');
          proof.secondAgent = verdict.agree === true;
          evidence.push(`second agent ${proof.secondAgent ? 'agrees' : 'disagrees'}: ${verdict.why ?? ''}`);
        } catch (e) {
          proof.secondAgent = false;
          evidence.push(`second agent unavailable: ${e.message}`);
        }
      }
      const rec = run.decide({ what: args.what, options: args.options ?? [], choice: args.choice, why: args.why, question: args.question, proof, evidence, change });
      return rec.outcome === 'proceed'
        ? json({ outcome: 'proceed', score: rec.score, bar: rec.bar, radius: rec.radius })
        : json({ outcome: 'park', score: rec.score, bar: rec.bar, radius: rec.radius, next: 'This item is parked until the developer answers. Stop working on it and end your turn now.' });
    },
  },
  {
    name: 'jd_block',
    description: 'junior-dev worker: log a blocker (what, why, how found, clean fixes). The part is skipped; never work around it. End your turn after.',
    parameters: obj({ what: { type: 'string' }, why: { type: 'string' }, how: { type: 'string' }, fixes: { type: 'array', items: { type: 'string' } } }, ['what', 'why', 'how']),
    output: TEXT,
    async execute(args, exec) {
      const { run, job } = workerCtx(exec);
      const id = run.blocker({ nodeId: job.nodeId, checkId: job.checkId ?? null, what: args.what, why: args.why, how: args.how, fixes: args.fixes ?? [] });
      return `Blocker ${id} logged. End your turn now.`;
    },
  },
];

export const ALL_TOOLS = [...rootTools, ...workerTools];
