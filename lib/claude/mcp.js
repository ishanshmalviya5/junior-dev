// Claude Code host: the jd_* tools as an MCP server. Transport-agnostic JSON-RPC core; server.js carries it over stdio and HTTP.
import { rootTools, workerTools } from '../host/tools.js';
import { shimAgent } from './agent.js';
import { claudeRootTools } from './tools.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ROOT = [...rootTools, ...claudeRootTools];
const toolsFor = (role) => (role === 'worker' ? workerTools : ROOT);

const describe = (def) => ({ name: def.name, description: def.description, inputSchema: def.parameters });

const textOf = (def, args, value) => {
  const blocks = def.output?.render ? def.output.render(args, value) : [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
  return blocks.filter((b) => b?.type === 'text');
};

/**
 * Handle one JSON-RPC message. who = {role: 'root'|'worker', id, cwd, signal?}: the caller's identity, decided by the
 * transport (stdio is the root; an HTTP path token is one worker), never by anything the model sends.
 * Returns the response object, or null for a notification.
 */
export async function handleRpc(msg, who) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined) return null; // notifications/initialized, notifications/cancelled, ...
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'junior-dev', version: '0.1.0' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolsFor(who.role).map(describe) });
    case 'tools/call': {
      const def = toolsFor(who.role).find((t) => t.name === msg.params?.name);
      if (!def) return fail(-32602, `unknown tool ${msg.params?.name}`);
      const args = msg.params?.arguments ?? {};
      try {
        const value = await def.execute(args, { agent: shimAgent(who), signal: who.signal ?? new AbortController().signal, callId: String(msg.id) });
        return reply({ content: textOf(def, args, value) });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}
