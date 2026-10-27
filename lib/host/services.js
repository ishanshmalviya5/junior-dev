// Thin seam between the engine/host and the hosting product. Tests replace services through hub.overrides;
// everything else goes to the active adapter (hub.adapter, default: DSH).
import { dsh } from './adapters/dsh.js';
import { hub } from './hub.js';

export { denyFor, toAskPayload } from './adapters/dsh.js';

const ov = (name) => hub.overrides?.[name];
const adapter = () => hub.adapter ?? dsh;
const via = (name, fallback) => async (...args) => (ov(name) ?? adapter()[name] ?? fallback ?? (() => { throw new Error(`${name} is not supported by this host`); }))(...args);

const viaSync = (name, fallback) => (...args) => (ov(name) ?? adapter()[name] ?? fallback)(...args);

/** Spawn one worker on a model; resolves when it ends. Registers the child for the gate and worker tools. */
export const spawnWorker = via('spawnWorker');
export const tokensOf = via('tokensOf');
/** Ask the developer (root agent only). questions: [{id, question, header, detail, options:[{label, description}], multiSelect}] */
export const ask = via('ask');
/** Send a message into the root chat (queued); the root agent relays it. */
export const notifyRoot = via('notifyRoot');
/** Run one host tool call; returns its value. */
export const executeTool = via('executeTool');
export const checkModel = via('checkModel');
export const listModels = via('listModels');
/** E4: local actions need no approval during the run; the gate is the boundary. */
export const setFullAccess = via('setFullAccess');
/** After a run ends, the chat goes back to approval-gated local actions. */
export const restoreAccess = (...a) => (ov('setFullAccess') ? true : via('restoreAccess')(...a));
/** Spending guard: the subscription settings, or null when the host has none. */
export const subscriptionSettings = viaSync('subscriptionSettings', () => null);
/** v2-10: is an installed bundle loaded? DSH only; asks through the (overridable) executeTool. */
export const bundleLoaded = (h, bundle) => (ov('bundleLoaded') ?? adapter().bundleLoaded ?? (async () => ({ ok: false, detail: 'bundles are not supported by this host' })))(h, bundle, executeTool);

export const answerText = (a) => [...(a?.selected ?? []), ...(a?.custom ? [a.custom] : [])].join('; ').replace(/ \(Recommended\)/g, '');

/** A worker that errored before using any tokens (spawn refused, model or provider unusable): retrying cannot help. */
export function isLaunchFailure(res) {
  return Boolean(res) && res.stopReason === 'error' && !res.tokens;
}

/** The real reason a worker could not run: its text plus DSH's diagnostic. */
export function launchReason(res) {
  const d = res.diagnostic == null ? '' : typeof res.diagnostic === 'string' ? res.diagnostic : JSON.stringify(res.diagnostic);
  return [res.text, d].filter(Boolean).join(' — ').slice(0, 500) || 'no detail from the host';
}

/** A failure that means "the subscription is used up" (never retried; the run stops until it resets). */
export function isQuotaStop(res) {
  if (!res || res.stopReason === 'completed') return false;
  const t = `${res.text ?? ''} ${typeof res.diagnostic === 'string' ? res.diagnostic : JSON.stringify(res.diagnostic ?? '')}`;
  return /no usable subscription account|subscription (usage|window|limit)|usage limit|rate[_ ]?limit|RATE_LIMIT|extra[ _-]?usage|overage|quota/i.test(t);
}
