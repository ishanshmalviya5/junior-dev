// Process-wide registry shared by the host row and the preset-scoped tools row (same module instance).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Run, listFeatures } from '../engine/run.js';

export const hub = {
  /** Host-plane cordis context (set by the host row). */
  host: null,
  logger: console,
  /** featureKey → { run, rootSessionId, loop: Promise|null, pauseRequested, abort: AbortController|null, worker: {childId, nodeId}|null } */
  runs: new Map(),
  /** root session id → featureKey */
  bySession: new Map(),
  /** worker child session id → featureKey */
  byWorker: new Map(),
  /** test hook: replaces subagent spawning, asks and notifications */
  overrides: null,
};

export const keyOf = (sessionFolder, name) => `${path.resolve(sessionFolder)}::${name}`;

export const jdHome = () => process.env.JD_HOME ?? path.join(os.homedir(), '.junior-dev');

/** Persistent list of attached runs, so the gate re-attaches after a DSH restart (S24). */
const registryFile = () => path.join(jdHome(), 'active.json');
export function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeRegistry(reg) {
  try {
    fs.mkdirSync(jdHome(), { recursive: true });
    const tmp = registryFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, registryFile());
  } catch (e) {
    hub.logger.warn?.(`junior-dev: could not write ${registryFile()}: ${e.message}`);
  }
}
export function register(sessionId, run) {
  const reg = readRegistry();
  if (run.state.phase === 'done') delete reg[sessionId];
  else reg[sessionId] = { folder: run.sessionFolder, name: run.name };
  writeRegistry(reg);
}

/** One handle (and one Store) per run: re-attaching never opens a second writer. */
export function attach(run, rootSessionId) {
  const key = keyOf(run.sessionFolder, run.name);
  let h = hub.runs.get(key);
  if (!h) {
    h = { key, run, rootSessionId, loop: null, pauseRequested: null, abort: null, worker: null };
    hub.runs.set(key, h);
  }
  // keep the live run (and its Store) if one exists; the passed one is discarded
  if (!h.run) h.run = run;
  run = h.run;
  if (rootSessionId) register(rootSessionId, run);
  if (rootSessionId && h.rootSessionId !== rootSessionId) {
    if (h.rootSessionId) hub.bySession.delete(h.rootSessionId);
    h.rootSessionId = rootSessionId;
  }
  if (rootSessionId) hub.bySession.set(rootSessionId, key);
  if (rootSessionId && run.state.feature.sessionId !== rootSessionId) run.store.commit('note', { kind: 'attached', text: rootSessionId });
  return h;
}

export function rekey(h) {
  const key = keyOf(h.run.sessionFolder, h.run.name);
  if (key === h.key) return;
  hub.runs.delete(h.key);
  h.key = key;
  hub.runs.set(key, h);
  if (h.rootSessionId) hub.bySession.set(h.rootSessionId, key);
}

export const isChild = (agent) => Boolean(agent?.session?.header?.delegationDepth) || agent?.session?.header?.origin === 'subagent';

/** Open a run once: an existing handle's run is reused. */
export function openRun(sessionFolder, name) {
  const h = hub.runs.get(keyOf(sessionFolder, name));
  return h?.run ?? Run.open(sessionFolder, name);
}

export function handleForAgent(agent) {
  if (!agent) return null;
  const key = hub.bySession.get(agent.id) ?? hub.byWorker.get(agent.id);
  if (key) return hub.runs.get(key) ?? null;
  // after a restart: a root session recorded in the registry is re-attached on its first tool call
  const reg = readRegistry()[agent.id];
  if (reg) {
    try {
      return attach(openRun(reg.folder, reg.name), agent.id);
    } catch (e) {
      hub.logger.warn?.(`junior-dev: could not re-attach ${reg.name}: ${e.message}`);
    }
  }
  // a grandchild of a worker (should not exist: workers cannot delegate) or an unknown child
  const parent = agent.session?.header?.parentSession;
  if (parent) {
    const pk = hub.byWorker.get(parent) ?? hub.bySession.get(parent);
    if (pk) return hub.runs.get(pk) ?? null;
  }
  return null;
}

/** Find the run for a root session, re-attaching after a restart if the feature records this session. */
export function handleForSession(sessionId, cwd) {
  const key = hub.bySession.get(sessionId);
  if (key && hub.runs.has(key)) return hub.runs.get(key);
  if (!cwd) return null;
  for (const f of listFeatures(cwd)) {
    if (f.finished || f.broken) continue;
    const run = openRun(cwd, f.name);
    const attachedTo = [...run.state.notes].reverse().find((n) => n.kind === 'attached')?.text ?? run.state.feature.sessionId;
    if (attachedTo === sessionId) return attach(run, sessionId);
  }
  return null;
}
