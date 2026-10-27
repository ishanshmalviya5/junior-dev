// Claude Code host checks: the MCP core and the agent shim, in process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hub } from '../lib/host/hub.js';
import { handleRpc } from '../lib/claude/mcp.js';
import { promptFile } from '../lib/claude/agent.js';
import { tmpdir } from './helpers.js';

process.env.JD_HOME = tmpdir('jd-home-');

const call = (who, name, args = {}, id = 1) => handleRpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, who);
const rootWho = (cwd) => ({ role: 'root', id: `claude-root::${cwd}`, cwd });

test('cc-01: initialize negotiates a known protocol version; notifications get no reply; unknown methods are errors', async () => {
  const who = rootWho(tmpdir('jd-cc-'));
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, who);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, who)).result.protocolVersion, '2025-06-18');
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, who), null);
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 3, method: 'nope' }, who)).error.code, -32601);
});

test('cc-02: the root sees the root tools and a worker only the worker tools', async () => {
  const names = async (who) => (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, who)).result.tools.map((t) => t.name);
  const root = await names(rootWho('/x'));
  const worker = await names({ role: 'worker', id: 'W1', cwd: '/x' });
  assert.ok(root.includes('jd_start') && !root.includes('jd_submit'));
  assert.ok(worker.includes('jd_submit') && !worker.includes('jd_start'));
  const first = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, rootWho('/x'))).result.tools[0];
  assert.equal(first.inputSchema.type, 'object');
});

test('cc-03: jd_start reads the PRD verbatim from the prompt the hook recorded, and the run attaches to the root identity', async () => {
  const cwd = tmpdir('jd-cc-');
  const who = rootWho(cwd);
  const none = await call(who, 'jd_start');
  assert.equal(none.result.isError, true);
  assert.match(none.result.content[0].text, /No PRD found/);
  const prd = '# Greeting helper\n\nAdd greet(name) returning "Hello, <name>!" and export it from index.js.\n';
  fs.mkdirSync(path.dirname(promptFile(cwd)), { recursive: true });
  fs.writeFileSync(promptFile(cwd), prd);
  const res = await call(who, 'jd_start', { name: 'greet' });
  assert.notEqual(res.result.isError, true, res.result.content[0].text);
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.started, 'greet');
  assert.equal(fs.readFileSync(path.join(out.folder, 'prd.md'), 'utf8').trim(), prd.trim());
  assert.equal(hub.bySession.get(who.id) !== undefined, true);
});

test('cc-04: a worker cannot call root tools and a root cannot call worker tools; unknown tools are errors', async () => {
  const cwd = tmpdir('jd-cc-');
  const asWorker = await call({ role: 'worker', id: 'W1', cwd }, 'jd_start');
  assert.equal(asWorker.error.code, -32602);
  const asRoot = await call(rootWho(cwd), 'jd_submit');
  assert.equal(asRoot.error.code, -32602);
  assert.equal((await call(rootWho(cwd), 'nope')).error.code, -32602);
});

import { decide, toExec } from '../lib/claude/gate.js';

const fakeRun = (work) => ({
  run: { name: 'f', dir: path.join(work, 'docs', 'f'), sessionFolder: work, state: { phase: 'build', settings: { repos: [{ path: path.join(work, 'src'), workPath: path.join(work, 'wt') }], permissions: { push: false, pr: false, debugEnv: null } } } },
});
const denied = (d) => d?.hookSpecificOutput?.permissionDecision === 'deny';

test('cc-05: the gate maps Claude tool names and argument names onto the ones the judge knows', () => {
  const who = { role: 'worker', id: 'W1', cwd: '/w' };
  assert.equal(toExec({ tool_name: 'Write', tool_input: { file_path: '/a' } }, who).name, 'write');
  assert.equal(toExec({ tool_name: 'MultiEdit', tool_input: {} }, who).name, 'edit');
  assert.equal(toExec({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n.ipynb' } }, who).arguments.file_path, '/n.ipynb');
  assert.equal(toExec({ tool_name: 'mcp__junior-dev__jd_submit', tool_input: {} }, who).name, 'jd_submit');
  assert.equal(toExec({ tool_name: 'mcp__plugin_junior-dev_junior-dev__jd_status', tool_input: {} }, who).name, 'jd_status');
  assert.equal(toExec({ tool_name: 'mcp__github__create_issue', tool_input: {} }, who).name, 'mcp__github__create_issue');
  assert.equal(toExec({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/elsewhere' }, who).agent.session.header.cwd, '/elsewhere');
});

test('cc-06: a worker may write inside its work path and is denied outside it, in files and in bash', () => {
  const work = tmpdir('jd-cc-');
  const h = fakeRun(work);
  const who = { role: 'worker', id: 'W1', cwd: path.join(work, 'wt') };
  const call = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: who.cwd }, who, h);
  assert.equal(call('Write', { file_path: path.join(work, 'wt', 'a.js'), content: 'x' }), null);
  assert.ok(denied(call('Write', { file_path: path.join(work, 'src', 'a.js'), content: 'x' })));
  assert.ok(denied(call('Edit', { file_path: path.join(work, 'docs', 'f', 'state', 'events.jsonl') })));
  assert.ok(denied(call('Bash', { command: `rm ${path.join(work, 'src', 'index.js')}` })));
  assert.equal(call('Bash', { command: 'npm test' }), null);
});

test('cc-07: workers cannot ask, delegate or push; a worker with no run fails closed and the root fails open', () => {
  const work = tmpdir('jd-cc-');
  const h = fakeRun(work);
  const w = { role: 'worker', id: 'W1', cwd: path.join(work, 'wt') };
  assert.match(decide({ tool_name: 'AskUserQuestion', tool_input: {}, cwd: w.cwd }, w, h).hookSpecificOutput.permissionDecisionReason, /never ask the developer/);
  assert.match(decide({ tool_name: 'Agent', tool_input: {}, cwd: w.cwd }, w, h).hookSpecificOutput.permissionDecisionReason, /work alone/);
  assert.ok(denied(decide({ tool_name: 'Bash', tool_input: { command: 'git push origin junior-dev/f' }, cwd: w.cwd }, w, h)));
  assert.ok(denied(decide({ tool_name: 'Write', tool_input: { file_path: '/x' }, cwd: w.cwd }, w, null)));
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: '/x' }, cwd: '/x' }, { role: 'root', id: 'R', cwd: '/x' }, null), null);
  assert.equal(decide({ tool_name: 'AskUserQuestion', tool_input: {}, cwd: '/x' }, { role: 'root', id: 'R', cwd: '/x' }, h), null, 'the root may relay jd_answer questions');
});

import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startDriver, elicitationFor, answersFrom } from '../lib/claude/server.js';
import * as S from '../lib/host/services.js';
import { handleForSession } from '../lib/host/hub.js';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const GATE_HOOK = fileURLToPath(new URL('../bin/gate-hook.mjs', import.meta.url));
const lines = (stream) => { const q = []; stream.on('data', (d) => q.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l)))); return q; };

async function driverWorld() {
  const cwd = tmpdir('jd-cc-');
  fs.mkdirSync(path.dirname(promptFile(cwd)), { recursive: true });
  fs.writeFileSync(promptFile(cwd), '# Greeting helper\n\nAdd greet(name) returning "Hello, <name>!" and export it from index.js.\n');
  const input = new PassThrough();
  const output = new PassThrough();
  const out = lines(output);
  const driver = await startDriver({ input, output, projectDir: cwd, gateHook: GATE_HOOK });
  const rpc = async (method, params, id) => { input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); for (let i = 0; i < 200 && !out.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 10)); return out.find((m) => m.id === id); };
  return { cwd, input, output, out, driver, rpc };
}

test('cc-08: a worker spawned through the claude adapter reaches its tools over HTTP, is fenced by the gate hook, and its usage is counted', async () => {
  process.env.JD_CLAUDE_BIN = FAKE;
  const w = await driverWorld();
  let h;
  try {
    await w.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
    const started = await w.rpc('tools/call', { name: 'jd_start', arguments: { name: 'greet' } }, 2);
    assert.notEqual(started.result.isError, true, started.result.content[0].text);
    h = handleForSession(`claude-root::${w.cwd}`, w.cwd);
    assert.ok(h, 'the run is attached to the root identity');
    h.worker = { id: 'x', nodeId: null, childId: null };
    const res = await S.spawnWorker(h, { role: 'builder', prompt: 'do the item', model: { provider: 'claude', model: 'haiku' }, hiddenTools: ['mcp__xcode__BuildProject'] });
    const seen = JSON.parse(res.text);
    assert.equal(res.stopReason, 'completed');
    assert.equal(seen.prompt, 'do the item');
    assert.equal(seen.hasSubmit, true);
    assert.deepEqual(JSON.parse(seen.node), { check: null }, 'jd_node answered for the worker');
    assert.match(seen.gated, /deny/, 'the hook command from the worker settings reaches the gate');
    assert.ok(seen.argv.includes('--strict-mcp-config') && seen.argv.includes('--disallowedTools') && seen.argv.includes('--model'));
    assert.equal(res.tokens, 10 + 5 + 100 + 100);
    assert.equal(h.worker.childId, res.childId);
    assert.equal(hub.byWorker.has(res.childId), false, 'the worker is deregistered once it ends');
  } finally {
    h?.abort?.abort();
    await w.driver.close();
    delete process.env.JD_CLAUDE_BIN;
  }
});

test('cc-09: an unknown worker gets 404 and a wrong gate secret is refused', async () => {
  const w = await driverWorld();
  try {
    const post = (p, body) => fetch(`http://127.0.0.1:${w.driver.port}${p}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post('/mcp/W-00000000-0000-0000-0000-000000000000', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
    assert.equal((await post('/gate', { secret: 'wrong', payload: {} })).status, 403);
    assert.equal((await post('/gate', { secret: w.driver.secret, payload: { tool_name: 'Write', tool_input: { file_path: '/x' }, cwd: '/x' } })).status, 200);
  } finally {
    await w.driver.close();
  }
});

test('cc-10: questions the loop asks with no root call in flight wait in the inbox until jd_answer settles them', async () => {
  const w = await driverWorld();
  try {
    await w.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
    await w.rpc('tools/call', { name: 'jd_start', arguments: { name: 'greet' } }, 2);
    const h = handleForSession(`claude-root::${w.cwd}`, w.cwd);
    const asked = S.ask(h, [{ id: 'HC:1', question: 'Does the button look right?', options: [{ label: 'Pass' }, { label: 'Fail' }] }]);
    const listed = JSON.parse((await w.rpc('tools/call', { name: 'jd_answer', arguments: {} }, 3)).result.content[0].text);
    assert.deepEqual(listed.pending.map((p) => [p.id, p.options]), [['HC:1', ['Pass', 'Fail']]]);
    await w.rpc('tools/call', { name: 'jd_answer', arguments: { answers: [{ id: 'HC:1', selected: ['Pass'] }] } }, 4);
    assert.deepEqual(await asked, [{ id: 'HC:1', selected: ['Pass'], custom: null }]);
  } finally {
    await w.driver.close();
  }
});

test('cc-11: a question asked during a root tool call goes to the developer as an MCP elicitation and the answer comes back', async () => {
  const w = await driverWorld();
  try {
    await w.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } }, 1);
    await w.rpc('tools/call', { name: 'jd_start', arguments: { name: 'greet' } }, 2);
    const call = w.rpc('tools/call', { name: 'jd_ask', arguments: { question: 'Which greeting?', options: ['Hello', 'Hi'] } }, 3);
    for (let i = 0; i < 200 && !w.out.some((m) => m.method === 'elicitation/create'); i++) await new Promise((r) => setTimeout(r, 10));
    const el = w.out.find((m) => m.method === 'elicitation/create');
    assert.ok(el, 'the server asks the client');
    assert.deepEqual(el.params.requestedSchema.properties.Q1.enum, ['Hello', 'Hi']);
    w.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: el.id, result: { action: 'accept', content: { Q1: 'Hi' } } })}\n`);
    const res = await call;
    assert.equal(JSON.parse(res.result.content[0].text).answer, 'Hi');
  } finally {
    await w.driver.close();
  }
});

test('cc-12: elicitation forms and answers cover choice, multi-choice and free text', () => {
  const qs = [{ id: 'a', question: 'One?', options: [{ label: 'x' }, { label: 'y' }] }, { id: 'b', question: 'Many?', options: [{ label: 'p' }, { label: 'q' }], multiSelect: true }, { id: 'c', question: 'Text?' }];
  const f = elicitationFor(qs);
  assert.equal(f.requestedSchema.properties.b.type, 'array');
  assert.equal(f.requestedSchema.properties.c.type, 'string');
  assert.ok(f.requestedSchema.properties.a__other && !f.requestedSchema.properties.c__other);
  assert.deepEqual(answersFrom(qs, { a: 'y', a__other: 'but dark', b: ['p', 'q'], c: 'free' }), [
    { id: 'a', selected: ['y'], custom: 'but dark' },
    { id: 'b', selected: ['p', 'q'], custom: null },
    { id: 'c', selected: [], custom: 'free' },
  ]);
});

import { commandText } from '../lib/claude/command.js';

test('cc-13: commands/junior-dev.md is the one generated from PROTOCOL, with no DSH-only tools in it', () => {
  const file = fs.readFileSync(new URL('../commands/junior-dev.md', import.meta.url), 'utf8');
  assert.equal(file, commandText(), 'run npm run gen:command and commit the result');
  assert.doesNotMatch(file, /plugin_manager|ask_user_question|\{\{model\}\}|DSH bundle/);
  assert.match(file, /jd_answer/);
  assert.match(file, /\$ARGUMENTS/);
  assert.match(file, /paste the PRD as their next message/);
});
