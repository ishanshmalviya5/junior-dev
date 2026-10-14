// Check runner (S7): the only producer of check evidence.
import { spawn } from 'node:child_process';

/** Human-readable form of a check (shell command, or the tool spec). */
export const describeCheck = (c) => (c.tool ? `tool:${c.tool} ${JSON.stringify(c.arguments ?? {})} pass:${c.pass ?? '?'}` : c.command);

const MAX_OUT = 8 * 1024;

export function runCheck({ command, cwd }, { timeoutMs = 10 * 60 * 1000, env = process.env, signal } = {}) {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ ok: false, code: null, output: 'no command defined for this check' });
      return;
    }
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const take = (b) => {
      out += b.toString();
      if (out.length > MAX_OUT * 2) out = out.slice(-MAX_OUT);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: `failed to start: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.length > MAX_OUT ? out.slice(-MAX_OUT) : out;
      resolve({ ok: code === 0 && !timedOut, code, output: timedOut ? `${tail}\n[timed out after ${timeoutMs} ms]` : tail });
    });
  });
}
