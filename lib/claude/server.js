// Claude Code host: the driver. One process per Claude session, started by Claude Code as the plugin's stdio MCP server.
// stdio = the root agent's tools; an HTTP listener on 127.0.0.1 = each worker's tools (the URL path is the worker's identity)
// and the gate that the PreToolUse hooks ask. The run, its store and the loop live here, as they live in DSH's process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { hub, jdHome, handleForAgent } from '../host/hub.js';
import { claude } from '../host/adapters/claude.js';
import { setStoreSecret } from '../engine/store.js';
import { handleRpc } from './mcp.js';
import { decide } from './gate.js';
import { shimAgent, driverFile } from './agent.js';

export const rootIdFor = (projectDir) => `claude-root::${path.resolve(projectDir)}`;

/** The developer's questions the run could not put to them directly; jd_answer settles them. */
function createInbox() {
  const waiting = new Map(); // runKey → Map(questionId → {q, resolve})
  const notes = new Map(); // runKey → [text]
  const of = (h) => (waiting.has(h.key) ? waiting.get(h.key) : waiting.set(h.key, new Map()).get(h.key));
  return {
    post(h, questions, signal) {
      return Promise.all(
        questions.map(
          (q) =>
            new Promise((resolve, reject) => {
              of(h).set(String(q.id), { q, resolve });
              signal?.addEventListener('abort', () => { of(h).delete(String(q.id)); reject(new Error('aborted')); }, { once: true });
            }),
        ),
      );
    },
    pending: (h) => [...of(h).values()].map(({ q }) => ({ id: q.id, question: q.question, header: q.header, detail: q.detail, options: (q.options ?? []).map((o) => o.label ?? o), multiSelect: Boolean(q.multiSelect) })),
    answer(h, answers) {
      for (const a of answers) {
        const w = of(h).get(String(a.id));
        if (!w) continue;
        of(h).delete(String(a.id));
        w.resolve({ id: String(a.id), selected: a.selected ?? [], custom: a.custom ?? null });
      }
    },
    note(h, text) {
      (notes.get(h.key) ?? notes.set(h.key, []).get(h.key)).push(text);
    },
    drainNotes(h) {
      const n = notes.get(h.key) ?? [];
      notes.set(h.key, []);
      return n;
    },
  };
}

/** Elicitation form for a batch of questions, and the answers read back from it. */
export function elicitationFor(questions) {
  const properties = {};
  for (const q of questions) {
    const labels = (q.options ?? []).map((o) => String(o.label ?? o));
    const title = String(q.header ?? q.question).slice(0, 60);
    const description = [q.question, q.detail].filter(Boolean).join('\n\n');
    if (!labels.length) properties[q.id] = { type: 'string', title, description };
    else if (q.multiSelect) properties[q.id] = { type: 'array', title, description, items: { type: 'string', enum: labels } };
    else properties[q.id] = { type: 'string', title, description, enum: labels };
    if (labels.length) properties[`${q.id}__other`] = { type: 'string', title: `${title}: something else`, description: 'Optional: your own answer or note' };
  }
  return { message: 'junior-dev needs your answer', requestedSchema: { type: 'object', properties, required: [] } };
}
export function answersFrom(questions, content = {}) {
  return questions.map((q) => {
    const v = content[q.id];
    const other = content[`${q.id}__other`];
    const selected = Array.isArray(v) ? v.map(String) : v && (q.options ?? []).length ? [String(v)] : [];
    return { id: String(q.id), selected, custom: other ? String(other) : !(q.options ?? []).length && v ? String(v) : null };
  });
}

/**
 * Start the driver. io = {input, output} for the root's stdio MCP connection (the process's own stdin/stdout in bin/mcp-server.mjs).
 * Returns {port, secret, close()}.
 */
export async function startDriver({ input, output, projectDir = process.cwd(), gateHook, port = 0 } = {}) {
  const secret = crypto.randomBytes(16).toString('hex');
  const rootId = rootIdFor(projectDir);
  const inbox = createInbox();
  const root = { calls: 0, elicitation: false, pending: new Map(), seq: 0 };
  const rootWho = { role: 'root', id: rootId, cwd: path.resolve(projectDir) };
  const send = (obj) => output.write(`${JSON.stringify(obj)}\n`);

  const c = (hub.claude = {
    port: 0,
    secret,
    gateHook,
    inbox,
    canElicit: () => root.elicitation && root.calls > 0,
    elicit(_h, questions, signal) {
      const id = `jd-elicit-${++root.seq}`;
      return new Promise((resolve, reject) => {
        root.pending.set(id, (res) => resolve(res?.result?.action === 'accept' ? answersFrom(questions, res.result.content) : res?.result ? questions.map((q) => ({ id: String(q.id), selected: [], custom: null })) : null));
        signal?.addEventListener('abort', () => { root.pending.delete(id); reject(new Error('aborted')); }, { once: true });
        send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: elicitationFor(questions) });
      });
    },
  });
  hub.adapter = claude;

  // ---- root: line-delimited JSON-RPC on stdio
  const rl = readline.createInterface({ input });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === undefined && msg.id !== undefined) return root.pending.get(msg.id)?.(msg), root.pending.delete(msg.id); // reply to our elicitation
    if (msg.method === 'initialize') root.elicitation = Boolean(msg.params?.capabilities?.elicitation);
    root.calls += msg.method === 'tools/call' ? 1 : 0;
    try {
      const res = await handleRpc(msg, rootWho);
      if (res) send(res);
    } finally {
      if (msg.method === 'tools/call') root.calls -= 1;
    }
  });

  // ---- workers and hooks: HTTP on loopback
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => resolve(b)); });
  const reply = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const worker = /^\/mcp\/(W-[0-9a-f-]+)$/.exec(url.pathname)?.[1];
      if (worker && req.method === 'POST') {
        const key = hub.byWorker.get(worker);
        const h = key && hub.runs.get(key);
        if (!h) return reply(res, 404, { error: 'unknown worker' });
        const who = { role: 'worker', id: worker, cwd: h.run.sessionFolder, parent: h.rootSessionId, signal: h.abort?.signal };
        const out = await handleRpc(JSON.parse(await readBody(req)), who);
        return out ? reply(res, 200, out) : reply(res, 202);
      }
      if (url.pathname === '/gate' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.secret !== secret) return reply(res, 403, { error: 'refused' });
        const who = body.worker ? { role: 'worker', id: body.worker, cwd: body.payload?.cwd, parent: rootId } : { ...rootWho };
        return reply(res, 200, decide(body.payload ?? {}, who) ?? {});
      }
      return reply(res, 404, { error: 'not found' });
    } catch (e) {
      return reply(res, 500, { error: e.message });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  c.port = server.address().port;

  const file = driverFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port: c.port, secret, pid: process.pid, projectDir: path.resolve(projectDir) }), { mode: 0o600 });

  return {
    port: c.port,
    secret,
    async close() {
      rl.close();
      await new Promise((r) => server.close(r));
      try { fs.rmSync(file); } catch {}
      for (const h of hub.runs.values()) h.abort?.abort();
      if (hub.claude === c) { hub.claude = null; hub.adapter = null; }
    },
  };
}

export { setStoreSecret };
