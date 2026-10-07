// junior-dev host row: run registry, permission gate, progress route. The tools live in the preset row (./tools).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hub, jdHome } from './host/hub.js';
import { setStoreSecret } from './engine/store.js';
import { installGate } from './host/gate.js';
import { renderProgress } from './engine/progress.js';

export const name = 'junior-dev';

export const inject = ['webServer', 'connection', 'userQuestions', 'subagents', 'sessionController', 'llm', 'permissionPresets', 'sessionQuery'];

const API = '/api/junior-dev';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function progressFor(sessionId) {
  const key = hub.bySession.get(sessionId);
  const h = key && hub.runs.get(key);
  if (!h) return { active: false };
  const run = h.run;
  const p = run.state.tree.rootId ? run.progress() : null;
  return {
    active: true,
    feature: run.name,
    phase: run.state.phase,
    side: run.state.side,
    sideReason: run.state.sideReason,
    loopRunning: Boolean(h.loop),
    checklist: p?.checklist ?? [],
    bar: p?.bar ?? { done: 0, total: 0, pct: 0 },
    grewBy: p?.grewBy ?? 0,
    parked: p?.parked ?? 0,
    blocked: p?.blocked ?? 0,
    queued: run.openQueue().length,
    text: p ? renderProgress(p) : `junior-dev · ${run.state.phase}`,
  };
}

export function createHandler(connection) {
  return async function handler(req, res) {
    if (typeof connection?.requestRejection !== 'function') return send(res, 503, { error: 'dsh authentication is not available' });
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch {
      rejection = 403;
    }
    if (rejection !== undefined) return send(res, rejection === 401 ? 401 : 403, { error: 'refused' });
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET' || url.pathname !== `${API}/progress`) return send(res, 404, { error: 'not found' });
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return send(res, 400, { error: 'sessionId is required' });
    return send(res, 200, progressFor(sessionId));
  };
}

/** The store's chain key lives outside every docs folder (S1.6); created once, mode 0600. */
export function loadSecret() {
  const file = path.join(jdHome(), 'secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    fs.mkdirSync(jdHome(), { recursive: true, mode: 0o700 });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600, flag: 'wx' });
    return s;
  }
}

export function apply(ctx) {
  hub.host = ctx;
  hub.logger = ctx.logger?.(name) ?? console;
  setStoreSecret(loadSecret());
  installGate(ctx);
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API, handler: createHandler(ctx.connection) }), 'junior-dev: progress route');
  ctx.effect(
    () => () => {
      for (const h of hub.runs.values()) h.abort?.abort();
      if (hub.host === ctx) hub.host = null;
    },
    'junior-dev: stop loops on unload',
  );
}
