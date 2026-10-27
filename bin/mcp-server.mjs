#!/usr/bin/env node
// The plugin's stdio MCP server (see lib/claude/server.js). Claude Code starts it; stdout carries only JSON-RPC.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDriver } from '../lib/claude/server.js';
import { loadSecret } from '../lib/index.js';
import { setStoreSecret } from '../lib/engine/store.js';

setStoreSecret(loadSecret());
const here = path.dirname(fileURLToPath(import.meta.url));
const driver = await startDriver({ input: process.stdin, output: process.stdout, projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), gateHook: path.join(here, 'gate-hook.mjs') });
process.stdin.on('end', async () => { await driver.close(); process.exit(0); });
