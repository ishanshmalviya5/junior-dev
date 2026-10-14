// v2-09: the one function every check run goes through (loop and tools.js). Dispatches shell vs tool-call.
import { runCheck } from '../engine/checks.js';
import { passRuleByName } from '../profiles/index.js';
import * as S from './services.js';

const SUMMARY_MAX = 1500;

/** Compact one-line JSON of a tool result, for evidence. */
export function summarizeResult(v) {
  let s;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…[truncated ${s.length - SUMMARY_MAX} chars]` : s;
}

/**
 * Run one check and return evidence {ok, output, code}. `check` is {command, cwd} or {tool, arguments, pass}.
 * Unknown tool / unknown rule / thrown error is a failed check with a clear output, never an exception.
 */
export async function runAnyCheck(h, check, { cwd, timeoutMs, signal } = {}) {
  if (!check.tool) return runCheck({ command: check.command, cwd }, { timeoutMs, signal });
  const fail = (output) => ({ ok: false, code: null, output });
  if (!check.pass) return fail(`tool check ${check.tool} has no pass rule`);
  const rule = passRuleByName(check.pass);
  if (!rule) return fail(`unknown pass rule "${check.pass}" for tool check ${check.tool}`);
  let value;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  try {
    const call = S.executeTool(h, { callId: `jd-check-${check.id ?? check.tool}-${Date.now()}`, name: check.tool, arguments: check.arguments ?? {}, signal: ctl.signal });
    const limit = timeoutMs ? new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs); }) : null;
    value = await (limit ? Promise.race([call, limit]) : call);
  } catch (e) {
    return fail(`tool ${check.tool} failed: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  const summary = summarizeResult(value);
  try {
    const j = await rule(value);
    const ok = Boolean(j?.ok);
    return { ok, code: null, output: `tool ${check.tool} → ${summary}\nrule ${check.pass}: ${ok ? 'pass' : 'fail'}${j?.output ? ` — ${j.output}` : ''}` };
  } catch (e) {
    return fail(`pass rule ${check.pass} threw: ${e?.message ?? e}\ntool ${check.tool} → ${summary}`);
  }
}
