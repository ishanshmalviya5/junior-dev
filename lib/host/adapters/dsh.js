// DSH adapter: the only file that reaches DSH host services (hub.host). services.js delegates here.
import crypto from 'node:crypto';
import { hub } from '../hub.js';
import { effectiveTokens } from '../../engine/budget.js';

const ROOT_ONLY_TOOLS = [
  'ask_user_question',
  'jd_status', 'jd_start', 'jd_resume', 'jd_fact', 'jd_ask', 'jd_set', 'jd_models', 'jd_tiers', 'jd_write_doc', 'jd_parity',
  'jd_tree', 'jd_preflight', 'jd_advance', 'jd_prepare', 'jd_run', 'jd_pause', 'jd_resettle',
  'subagent', 'subagent_fork', 'subagent_control', 'list_agents', 'workflow', 'ralph',
];

async function rootAgent(h) {
  const r = await hub.host.sessionController.resolveAgent(h.rootSessionId);
  if (r?.error || !r?.agent) throw new Error(`root session ${h.rootSessionId} is not available: ${r?.error?.message ?? r?.error ?? 'unknown'}`);
  return r.agent;
}

const textOf = (blocks) => (blocks ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();

/** Spawn one worker on a model; resolves when it ends. Registers the child for the gate and worker tools. */
async function spawnWorker(h, { role, prompt, model, signal, register = true, hiddenTools = [] }) {
  const parent = await rootAgent(h);
  const childId = crypto.randomUUID();
  hub.byWorker.set(childId, h.key); // before start: the child's first tool call must already resolve to this run
  let run;
  try {
    run = await startChild(parent, { role, prompt, model, signal, hiddenTools, childId, label: `junior-dev ${role}${h.worker?.nodeId ? ` ${h.worker.nodeId}` : ''}` });
  } catch (e) {
    hub.byWorker.delete(childId);
    throw e;
  }
  if (run.id !== childId) {
    hub.byWorker.delete(childId);
    hub.byWorker.set(run.id, h.key);
  }
  if (register && h.worker) h.worker.childId = run.id;
  try {
    const res = await run.result;
    return { childId: run.id, text: textOf(res.output), stopReason: res.stopReason, diagnostic: res.diagnostic ?? null, tokens: await tokensOf(run.id) };
  } finally {
    await run.dispose().catch(() => {});
    hub.byWorker.delete(run.id);
  }
}

/**
 * DSH refuses a toolFilter naming a tool its filter cannot see, and its error lists every name it can; learn that list,
 * expand the RegExp entries of hiddenTools against it, and retry. A probe name gets the list on the first spawn.
 * Tools DSH cannot filter (those in the child's own scope, like subagent) are denied by the gate instead.
 */
let denyList = [...ROOT_ONLY_TOOLS];
const unknownTools = new Set();
let knownTools = null;
let probed = false; // one probe per process: if DSH's error ever stops listing the names, the RegExps just stay unexpanded
const PROBE = '__junior_dev_probe__';
function denyFor(hiddenTools, known = knownTools) {
  const names = new Set(denyList);
  for (const t of hiddenTools) {
    if (typeof t === 'string') names.add(t);
    else if (known) for (const n of known) if (t.test(n)) names.add(n);
  }
  return [...names].filter((n) => !unknownTools.has(n) && (!known || known.has(n)));
}
async function startChild(parent, { role, prompt, model, signal, label, childId, hiddenTools = [] }) {
  const agentOptions = model ? { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) } : undefined;
  if (typeof hub.host.subagents.start !== 'function') {
    // newer DSH: no toolFilter on the request; the gate and the root-only tool checks keep workers in bounds
    const act = await hub.host.subagents.startActivation({
      provider: 'spawn',
      label,
      childId,
      request: { prompt: [{ type: 'text', text: prompt }], parent, ...(agentOptions ? { agentOptions } : {}) },
      signal,
      delivery: 'caller',
    });
    return { id: act.childId, result: act.result, dispose: () => act.dispose() };
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const probe = !knownTools && !probed && hiddenTools.some((t) => typeof t !== 'string');
    if (probe) probed = true;
    try {
      return await hub.host.subagents.start('spawn', {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        ...(agentOptions ? { agentOptions } : {}),
        toolFilter: { deny: [...denyFor(hiddenTools), ...(probe ? [PROBE] : [])] },
        signal,
      });
    } catch (e) {
      const msg = String(e?.message ?? e);
      const m = msg.match(/names unknown global tools? ((?:"[^"]+",?\s*)+)/);
      if (!m) throw e;
      const known = msg.match(/known global tools: ([^\n]*)$/m)?.[1];
      if (known !== undefined) knownTools = new Set(known === '(none)' ? [] : known.split(', ').map((n) => n.trim()).filter(Boolean));
      const unknown = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((n) => n !== PROBE);
      denyList = denyList.filter((n) => !unknown.includes(n));
      for (const n of unknown) unknownTools.add(n);
      if (unknown.length) hub.logger.info?.(`junior-dev: tools not in this preset, dropped from the worker deny list: ${unknown.join(', ')}`);
    }
  }
  throw new Error(`could not start a ${role} worker`);
}

async function tokensOf(sessionId) {
  try {
    const o = await hub.host.sessionQuery.observeSession(sessionId, { projectionMode: 'all' });
    try {
      return effectiveTokens(o?.projections?.values?.tokenUsage);
    } finally {
      o?.[Symbol.dispose]?.();
      o?.dispose?.();
    }
  } catch {
    return 0;
  }
}

/** Ask the developer (root agent only). questions: [{id, question, header, detail, options:[{label, description}], multiSelect}] */
async function ask(h, questions, { agent, signal } = {}) {
  const a = agent ?? (await rootAgent(h));
  const res = await hub.host.userQuestions.ask({
    questions: toAskPayload(questions),
    agent: a,
    signal: signal ?? new AbortController().signal,
  });
  return res.answers.map((x) => ({ id: x.id, selected: x.selected ?? [], custom: x.custom ?? null }));
}

/** The gateway relays only lossless JSON: no undefined fields anywhere. */
function toAskPayload(questions) {
  return questions.map((q) => {
    const out = { id: String(q.id), question: String(q.question) };
    if (q.header) out.header = String(q.header).slice(0, 12);
    if (q.detail) out.detail = String(q.detail);
    if (q.options?.length) out.options = q.options.map((o) => (o.description ? { label: String(o.label), description: String(o.description) } : { label: String(o.label) }));
    if (q.multiSelect) out.multiSelect = true;
    return JSON.parse(JSON.stringify(out));
  });
}

/** Send a message into the root chat (queued); the root agent relays it. */
async function notifyRoot(h, text) {
  try {
    await hub.host.sessionController.prompt({ requestId: `junior-dev-${crypto.randomUUID()}`, sessionId: h.rootSessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal);
  } catch (e) {
    hub.logger.warn?.(`junior-dev: could not notify session ${h.rootSessionId}: ${e.message}`);
  }
}

/** Run one DSH tool call through the host ToolRuntime; returns its value. Nothing calls this yet. */
async function executeTool(h, { callId, name, arguments: args, signal }) {
  // As the root agent: preset-scoped tools (dsh-ios's) are invisible to an agentless call (R3).
  const agent = h.rootSessionId ? await rootAgent(h).catch(() => undefined) : undefined;
  const res = await hub.host.tools.execute({ callId, name, arguments: args, signal, ...(agent ? { agent } : {}) });
  if (res?.isError) throw new Error(res.error?.message ?? (textOf(res.content) || 'the tool returned an error'));
  return res?.value;
}

async function checkModel(model) {
  try {
    const info = await hub.host.llm.resolveModelInfo(model.provider, model.model);
    return { ok: true, detail: `${model.provider}/${info?.model ?? model.model}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function listModels() {
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
async function setFullAccess(h) {
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
async function restoreAccess(h) {
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
function subscriptionSettings() {
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

/**
 * v2-10: is an installed bundle loaded? Asks the Host inspect provider Config.listConfigs
 * (dsh-tool-cordis/host) through cordis_inspect_query: a directory of live Loader entries,
 * filtered to the exact plugin package name. Loaded = at least one entry whose status is not
 * 'inactive' (inactive = disabled or its fiber never started). Returns {ok, detail}.
 */
async function bundleLoaded(h, bundle, executeTool) {
  try {
    const v = await executeTool(h, {
      callId: `jd-bundle-${bundle.name}`,
      name: 'cordis_inspect_query',
      arguments: { platform: 'host', provider: 'Config', method: 'listConfigs', input: { name: bundle.name, limit: 100 } },
      signal: new AbortController().signal,
    });
    const entries = (v?.data ?? v)?.entries;
    if (!Array.isArray(entries)) return { ok: false, detail: `cordis_inspect_query Config.listConfigs returned no entries for ${bundle.name}` };
    if (!entries.length) return { ok: false, detail: `${bundle.name} is not in the running plugin tree` };
    const live = entries.filter((e) => e.name === bundle.name && e.status !== 'inactive');
    return live.length ? { ok: true, detail: '' } : { ok: false, detail: `${bundle.name} is in the plugin tree but inactive` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}


export { denyFor, toAskPayload };

export const dsh = { spawnWorker, tokensOf, ask, notifyRoot, executeTool, checkModel, listModels, setFullAccess, restoreAccess, subscriptionSettings, bundleLoaded };
