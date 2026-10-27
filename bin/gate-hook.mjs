#!/usr/bin/env node
// PreToolUse hook: asks the driver's gate. A worker's hook carries --port/--secret/--worker and fails closed when the
// driver is unreachable; the plugin's hook for the root session finds the driver by project folder and fails open.
import fs from 'node:fs';
import http from 'node:http';
import { driverFile } from '../lib/claude/agent.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const worker = arg('worker');
if (!worker && process.env.JD_WORKER_ID) process.exit(0); // inside a worker the plugin's own hook is a second copy of the worker's one
let target = arg('port') && { port: Number(arg('port')), secret: arg('secret') };
if (!target) {
  try { target = JSON.parse(fs.readFileSync(driverFile(process.env.CLAUDE_PROJECT_DIR ?? payload.cwd), 'utf8')); } catch { process.exit(0); }
}
const deny = (reason) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
const req = http.request({ host: '127.0.0.1', port: target.port, path: '/gate', method: 'POST', timeout: 10000 }, (res) => {
  let b = '';
  res.on('data', (d) => (b += d));
  res.on('end', () => {
    if (res.statusCode !== 200) return worker ? deny(`junior-dev gate answered ${res.statusCode}`) : process.exit(0);
    if (b.trim() && b.trim() !== '{}') console.log(b);
  });
});
req.on('error', () => (worker ? deny('junior-dev gate is unreachable; a worker cannot act without it') : process.exit(0)));
req.on('timeout', () => req.destroy());
req.end(JSON.stringify({ secret: target.secret, worker, payload }));
