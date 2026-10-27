#!/usr/bin/env node
// Test stand-in for `claude -p`: reads its prompt from stdin, calls the worker MCP endpoint and the hook from its own flags.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const prompt = fs.readFileSync(0, 'utf8');
const mcp = JSON.parse(arg('--mcp-config')).mcpServers['junior-dev'];
const settings = JSON.parse(arg('--settings'));
const rpc = async (method, params, id = 1) => (await (await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json()).result;
const hook = (payload) => {
  try { return execSync(settings.hooks.PreToolUse[0].hooks[0].command, { input: JSON.stringify(payload), encoding: 'utf8' }).trim(); } catch (e) { return `hook-failed:${e.status}`; }
};
await rpc('initialize', { protocolVersion: '2025-06-18' });
const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
const node = await rpc('tools/call', { name: 'jd_node', arguments: {} }, 2);
const gated = hook({ tool_name: 'AskUserQuestion', tool_input: {}, cwd: process.cwd() });
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: JSON.stringify({ prompt, tools: tools.length, hasSubmit: tools.includes('jd_submit'), node: node.content[0].text, gated, argv: process.argv.slice(2).filter((a) => a.startsWith('--')) }),
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
}));
