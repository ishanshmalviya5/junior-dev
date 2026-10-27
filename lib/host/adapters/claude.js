// Claude Code adapter: workers are `claude -p` child processes that reach the run through this process's HTTP MCP
// endpoint and are fenced by a PreToolUse hook that asks this process's gate. See lib/claude/server.js.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { hub } from '../hub.js';
import { effectiveTokens } from '../../engine/budget.js';

const ROOT_ONLY_TOOLS = [
  'AskUserQuestion', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'SendMessage', 'EnterPlanMode', 'ExitPlanMode', 'Workflow', 'CronCreate', 'CronDelete',
];

const claudeBin = () => process.env.JD_CLAUDE_BIN ?? 'claude';
const textFrom = (s) => String(s ?? '').trim();

/** The hook command a worker's settings carry: asks this process's gate about every tool call. */
const hookCommand = (c, id) => `${JSON.stringify(process.execPath)} ${JSON.stringify(c.gateHook)} --port ${c.port} --secret ${c.secret} --worker ${id}`;

/** Pure: the argv for one worker. */
export function workerArgv(c, { id, model, deny }) {
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand(c, id) }] }] } };
  const mcp = { mcpServers: { 'junior-dev': { type: 'http', url: `http://127.0.0.1:${c.port}/mcp/${id}` } } };
  return [
    '-p', '--output-format', 'json', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--settings', JSON.stringify(settings),
    // E4: local actions need no approval during the run; the gate hook is the boundary
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', ...deny,
    ...(model?.model ? ['--model', model.model] : []),
    ...(model?.reasoningEffort ? ['--effort', model.reasoningEffort] : []),
  ];
}

/** Pure: a worker's `claude -p --output-format json` result → what the loop reads. */
export function parseResult(stdout, code) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    return { text: textFrom(stdout).slice(-500), stopReason: 'error', diagnostic: `claude exited ${code} with no JSON result` };
  }
  const u = r.usage ?? {};
  const tokens = effectiveTokens({ uncachedInputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheWriteTokens: u.cache_creation_input_tokens, cacheReadTokens: u.cache_read_input_tokens });
  const failed = r.is_error === true || (r.subtype && r.subtype !== 'success');
  return { text: textFrom(r.result), stopReason: failed ? 'error' : 'completed', diagnostic: failed ? (r.subtype ?? r.terminal_reason ?? 'error') : null, tokens };
}

async function spawnWorker(h, { role, prompt, model, signal, register = true, hiddenTools = [] }) {
  const c = hub.claude;
  if (!c) throw new Error('the junior-dev MCP server is not running (hub.claude is unset)');
  const id = `W-${crypto.randomUUID()}`;
  const repos = h.run.state.settings.repos ?? [];
  const cwd = repos.map((r) => r.workPath).find(Boolean) ?? h.run.sessionFolder;
  hub.byWorker.set(id, h.key);
  if (register && h.worker) h.worker.childId = id;
  try {
    const deny = [...new Set([...ROOT_ONLY_TOOLS, ...hiddenTools.filter((t) => typeof t === 'string'), 'mcp__junior-dev__jd_start'])];
    const child = spawn(claudeBin(), workerArgv(c, { id, model, deny }), { cwd, env: { ...process.env, JD_WORKER_ID: id }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const onAbort = () => child.kill('SIGTERM');
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.end(prompt);
    const code = await new Promise((resolve) => {
      child.on('error', (e) => { err += e.message; resolve(-1); });
      child.on('close', resolve);
    });
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) return { childId: id, text: '', stopReason: 'aborted', diagnostic: null, tokens: 0 };
    const res = parseResult(out, code);
    if (res.stopReason === 'error' && !res.diagnostic?.length) res.diagnostic = err.slice(-500);
    return { childId: id, ...res, diagnostic: res.diagnostic ?? (code ? err.slice(-500) : null) };
  } finally {
    hub.byWorker.delete(id);
  }
}

/** The root asks the developer: through MCP elicitation while a root tool call is in flight, else through the inbox. */
async function ask(h, questions, { signal } = {}) {
  const c = hub.claude;
  if (!c) throw new Error('the junior-dev MCP server is not running (hub.claude is unset)');
  if (c.canElicit?.()) {
    const got = await c.elicit(h, questions, signal).catch(() => null);
    if (got) return got;
  }
  return c.inbox.post(h, questions, signal);
}

async function notifyRoot(h, text) {
  // Channels are an experimental, flag-gated route; the inbox (jd_answer / jd_status) is the one that always works.
  hub.claude?.inbox?.note(h, text);
  await hub.claude?.channel?.(text);
}

async function executeTool(_h, { name }) {
  throw new Error(`tool checks (${name}) run through DSH tools; Claude Code runs shell checks only`);
}

async function checkModel(model) {
  const ok = typeof model?.model === 'string' && model.model.length > 0;
  return { ok, detail: ok ? `${model.provider ?? 'claude'}/${model.model}` : 'no model given' };
}

// The claude CLI has no model listing; tiers (jd_tiers) are the source.
async function listModels() {
  return [];
}

export const claude = {
  spawnWorker,
  tokensOf: async () => 0,
  ask,
  notifyRoot,
  executeTool,
  checkModel,
  listModels,
  setFullAccess: async () => true,
  restoreAccess: async () => true,
  subscriptionSettings: () => null,
};
