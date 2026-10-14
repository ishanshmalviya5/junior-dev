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
export async function spawnWorker(h, { role, prompt, model, signal, register = true, hiddenTools = [] }) {
  if (ov('spawnWorker')) return ov('spawnWorker')(h, { role, prompt, model, signal, register, hiddenTools });
  const parent = await rootAgent(h);
  const run = await startChild(parent, { role, prompt, model, signal, hiddenTools, label: `junior-dev ${role}${h.worker?.nodeId ? ` ${h.worker.nodeId}` : ''}` });
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

/** DSH refuses a toolFilter naming tools that do not exist in the composition; learn and retry. */
let denyList = [...ROOT_ONLY_TOOLS];
const unknownTools = new Set();
async function startChild(parent, { role, prompt, model, signal, label, hiddenTools = [] }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await hub.host.subagents.start('spawn', {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        ...(model ? { agentOptions: { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) } } : {}),
        toolFilter: { deny: [...new Set([...denyList, ...hiddenTools])].filter((n) => !unknownTools.has(n)) },
        signal,
      });
    } catch (e) {
      const m = String(e?.message ?? e).match(/names unknown global tools ((?:"[^"]+",?\s*)+)/);
      if (!m) throw e;
      const unknown = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      denyList = denyList.filter((n) => !unknown.includes(n));
      for (const n of unknown) unknownTools.add(n);
      hub.logger.info?.(`junior-dev: tools not in this preset, dropped from the worker deny list: ${unknown.join(', ')}`);
    }
  }
  throw new Error(`could not start a ${role} worker`);
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

/** Run one DSH tool call through the host ToolRuntime; returns its value. Nothing calls this yet. */
export async function executeTool(h, { callId, name, arguments: args, signal }) {
  if (ov('executeTool')) return ov('executeTool')(h, { callId, name, arguments: args, signal });
  const res = await hub.host.tools.execute({ callId, name, arguments: args, signal });
  return res?.value;
}

/** v2-10: is an installed bundle loaded? The real check asks cordis_inspect_query. Returns {ok, detail}. */
export async function bundleLoaded(h, bundle) {
  if (ov('bundleLoaded')) return ov('bundleLoaded')(h, bundle);
  try {
    const v = await executeTool(h, { callId: `jd-bundle-${bundle.name}`, name: 'cordis_inspect_query', arguments: { query: bundle.name }, signal: new AbortController().signal });
    const ok = JSON.stringify(v ?? '').includes(bundle.name);
    return { ok, detail: ok ? '' : `cordis_inspect_query did not find ${bundle.name}` };
  } catch (e) {
    return { ok: false, detail: e.message };
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

/** After a run ends, the chat goes back to approval-gated local actions. */
export async function restoreAccess(h) {
  if (ov('restoreAccess')) return ov('restoreAccess')(h);
  if (ov('setFullAccess')) return true;
  try {
    const agent = await rootAgent(h);
    await hub.host.permissionPresets.set(agent.session, 'workspace-write');
    return true;
  } catch (e) {
    hub.logger.warn?.(`junior-dev: could not restore access: ${e.message}`);
    return false;
  }
}

/**
 * Spending guard (developer requirement: never spend paid extra-usage credits; subscription
 * exhaustion is fine). Reads the dsh-subscriptions settings namespace, if that plugin is present.
 */
export function subscriptionSettings() {
  if (ov('subscriptionSettings')) return ov('subscriptionSettings')();
  try {
    const svc = hub.host?.get?.('settings');
    const row = svc?.describe?.()?.find?.((d) => d.ns === 'dsh-subscriptions');
    if (!row) return null;
    const v = row.value ?? {};
    const slots = Array.isArray(v.slots) ? v.slots : [];
    return {
      providers: [...new Set(slots.map((s) => s?.provider).filter(Boolean))],
      subscriptionOnly: v.subscriptionOnly !== false, // default true
      cascadingFallback: v.cascadingFallback === true,
    };
  } catch {
    return null;
  }
}

/** A failure that means "the subscription is used up" (never retried; the run stops until it resets). */
export function isQuotaStop(res) {
  if (!res || res.stopReason === 'completed') return false;
  const t = `${res.text ?? ''} ${typeof res.diagnostic === 'string' ? res.diagnostic : JSON.stringify(res.diagnostic ?? '')}`;
  return /no usable subscription account|subscription (usage|window|limit)|usage limit|rate[_ ]?limit|RATE_LIMIT|extra[ _-]?usage|overage|quota/i.test(t);
}
