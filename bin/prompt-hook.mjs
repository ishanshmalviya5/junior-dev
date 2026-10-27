#!/usr/bin/env node
// UserPromptSubmit hook: keeps the developer's latest substantial prompt, so jd_start reads the PRD verbatim.
import fs from 'node:fs';
import path from 'node:path';
import { promptFile } from '../lib/claude/agent.js';

if (process.env.JD_WORKER_ID) process.exit(0); // a worker's prompt is never a PRD
const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const text = String(payload.prompt ?? '').replace(/^\/junior-dev(?::[\w-]+)?\s+/, '').trim();
if (text.length >= 40) {
  const file = promptFile(process.env.CLAUDE_PROJECT_DIR ?? payload.cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
