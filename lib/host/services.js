// Thin adapters over DSH host services. Tests replace them through hub.overrides.
import crypto from 'node:crypto';
import { hub } from './hub.js';

const ROOT_ONLY_TOOLS = [
  'ask_user_question',
  'jd_status', 'jd_start', 'jd_resume', 'jd_fact', 'jd_ask', 'jd_set', 'jd_models', 'jd_write_doc', 'jd_parity',
  'jd_tree', 'jd_preflight', 'jd_advance', 'jd_prepare', 'jd_run', 'jd_pause', 'jd_resettle',
  'subagent', 'subagent_fork', 'subagent_control', 'list_agents', 'workflow', 'ralph',
];

const ov = (name) => hub.overrides?.[name];

export async function rootAgent(h) {
  const r = await hub.host.sessionController.resolveAgent(h.rootSessionId);
  if (r?.error || !r?.agent) throw new Error(`root session ${h.rootSessionId} is not available: ${r?.error?.message ?? r?.error ?? 'unknown'}`);
  return r.agent;
}

const textOf = (blocks) => (blocks ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();

/** Spawn one worker on a model; resolves when it ends. Registers the child for the gate and worker tools. */
export async function spawnWorker(h, { role, prompt, model, signal, register = true }) {
  if (ov('spawnWorker')) return ov('spawnWorker')(h, { role, prompt, model, signal, register });
  const parent = await rootAgent(h);
  const run = await hub.host.subagents.start('spawn', {
    label: `junior-dev ${role}${h.worker?.nodeId ? ` ${h.worker.nodeId}` : ''}`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    agentOptions: model ? { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) } : undefined,
    toolFilter: { deny: ROOT_ONLY_TOOLS },
    signal,
  });
  hub.byWorker.set(run.id, h.key);
  if (register && h.worker) h.worker.childId = run.id;
  try {
    const res = await run.result;
    return { childId: run.id, text: textOf(res.output), stopReason: res.stopReason, diagnostic: res.diagnostic ?? null, tokens: await tokensOf(run.id) };
  } finally {
    await run.dispose().catch(() => {});
    hub.byWorker.delete(run.id);
  }
}

export async function tokensOf(sessionId) {
  if (ov('tokensOf')) return ov('tokensOf')(sessionId);
  try {
    const o = await hub.host.sessionQuery.observeSession(sessionId, { projectionMode: 'all' });
    try {
      const u = o?.projections?.values?.tokenUsage;
      if (!u) return 0;
      return (u.uncachedInputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    } finally {
      o?.[Symbol.dispose]?.();
      o?.dispose?.();
    }
  } catch {
    return 0;
  }
}

/** Ask the developer (root agent only). questions: [{id, question, header, detail, options:[{label, description}], multiSelect}] */
export async function ask(h, questions, { agent, signal } = {}) {
  if (ov('ask')) return ov('ask')(h, questions);
  const a = agent ?? (await rootAgent(h));
  const res = await hub.host.userQuestions.ask({
    questions: toAskPayload(questions),
    agent: a,
    signal: signal ?? new AbortController().signal,
  });
  return res.answers.map((x) => ({ id: x.id, selected: x.selected ?? [], custom: x.custom ?? null }));
}

/** The gateway relays only lossless JSON: no undefined fields anywhere. */
export function toAskPayload(questions) {
  return questions.map((q) => {
    const out = { id: String(q.id), question: String(q.question) };
    if (q.header) out.header = String(q.header).slice(0, 12);
    if (q.detail) out.detail = String(q.detail);
    if (q.options?.length) out.options = q.options.map((o) => (o.description ? { label: String(o.label), description: String(o.description) } : { label: String(o.label) }));
    if (q.multiSelect) out.multiSelect = true;
    return JSON.parse(JSON.stringify(out));
  });
}

export const answerText = (a) => [...(a?.selected ?? []), ...(a?.custom ? [a.custom] : [])].join('; ').replace(/ \(Recommended\)/g, '');

/** Send a message into the root chat (queued); the root agent relays it. */
export async function notifyRoot(h, text) {
  if (ov('notifyRoot')) return ov('notifyRoot')(h, text);
  try {
    await hub.host.sessionController.prompt({ requestId: `junior-dev-${crypto.randomUUID()}`, sessionId: h.rootSessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal);
  } catch (e) {
    hub.logger.warn?.(`junior-dev: could not notify session ${h.rootSessionId}: ${e.message}`);
  }
}

export async function checkModel(model) {
  if (ov('checkModel')) return ov('checkModel')(model);
  try {
    const info = await hub.host.llm.resolveModelInfo(model.provider, model.model);
    return { ok: true, detail: `${model.provider}/${info?.model ?? model.model}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

export async function listModels() {
  if (ov('listModels')) return ov('listModels')();
  const out = [];
  for (const p of hub.host.llm.listProviders()) {
    try {
      const ms = await hub.host.llm.listModels(p.id);
      for (const m of ms) out.push({ provider: p.id, providerName: p.name, model: m.id ?? m.model, name: m.name ?? m.displayName ?? m.id });
    } catch {
      out.push({ provider: p.id, providerName: p.name, model: null, error: 'could not list models' });
    }
  }
  return out;
}

/** E4: local actions need no approval during the run; the gate is the boundary. */
export async function setFullAccess(h) {
  if (ov('setFullAccess')) return ov('setFullAccess')(h);
  try {
    const agent = await rootAgent(h);
    await hub.host.permissionPresets.set(agent.session, 'danger-full-access');
    return true;
  } catch (e) {
    hub.logger.warn?.(`junior-dev: could not set full access: ${e.message}`);
    return false;
  }
}
