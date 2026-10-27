// Claude Code host: the PreToolUse hook's decision, made by the same judge() the DSH gate uses.
import { judge } from '../host/gate.js';
import { handleForAgent } from '../host/hub.js';
import { shimAgent } from './agent.js';

// our own tools are mcp__junior-dev__* for a worker (its own --mcp-config) and mcp__plugin_junior-dev_junior-dev__* for the root (the installed plugin)
const MCP_SELF = /^mcp__(?:plugin_junior-dev_)?junior-dev__(.+)$/;
const RENAME = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Bash: 'bash', AskUserQuestion: 'ask_user_question', Agent: 'subagent', Task: 'subagent' };

/** Claude Code's tool names and argument names → the ones judge() knows (mcp__<server>__<tool> is kept as is). */
export function toExec(payload, who) {
  const raw = String(payload.tool_name ?? '');
  const args = { ...(payload.tool_input ?? {}) };
  if (typeof args.notebook_path === 'string') args.file_path ??= args.notebook_path;
  return { agent: shimAgent({ ...who, cwd: payload.cwd ?? who.cwd }), name: MCP_SELF.exec(raw)?.[1] ?? RENAME[raw] ?? raw, arguments: args };
}

/**
 * The hook's JSON output for one tool call, or null for no opinion. A worker with no run behind it fails closed
 * (its process outlived the run); the root session fails open, since the hook fires in every Claude session.
 */
export function decide(payload, who, h) {
  // the root relays jd_answer questions with AskUserQuestion; the judge's "ask through jd_ask" rule is DSH's, workers stay denied
  if (who.role === 'root' && payload.tool_name === 'AskUserQuestion') return null;
  const exec = toExec(payload, who);
  let d;
  try {
    d = judge(exec, h === undefined ? handleForAgent(exec.agent) : h);
  } catch (e) {
    d = { kind: 'deny', reason: `junior-dev gate error: ${e.message}` };
  }
  if (!d && who.role === 'worker' && !(h ?? handleForAgent(exec.agent))) d = { kind: 'deny', reason: 'junior-dev: this worker no longer belongs to a running run.' };
  return d ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } } : null;
}
