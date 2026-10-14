// The iOS stack profile (v2 ticket 11). Simulator only; every iOS action goes through dsh-ios tools (ADR 0001).
// junior-dev never names Xcode MCP here: the hidden-tool list comes from the gate classifier's known names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XCODE_TOOL_NAMES } from '../engine/classify.js';

/**
 * The dsh-ios tools junior-dev expects, in one place. Argument and result shapes (docs/junior-dev-v2/handoff-dsh-ios.md):
 *  status     {worktreesRoot}  -> {ready, reasons:[string], setup?:[string]|string}
 *  build      {workspacePath, scheme?} -> {result:'success'|'failed'|'cancelled', errors:[{file,line,message}], logPath}
 *  test       {workspacePath, scheme?, tests?:[{targetName,testIdentifier}]}
 *             -> {counts:{total,passed,failed,skipped,expectedFailures,notRun}, failures:[{name,message}], xcresultPath, error?}
 *             error kinds: build_failed | cancelled | tests_running | test_not_found | nothing_to_run
 *  screenshot {} -> a reference (path or url) to a simulator screenshot (existing dsh-ios tool)
 */
export const IOS_TOOLS = { status: 'ios_status', build: 'ios_build', test: 'ios_test', screenshot: 'ios_sim_screenshot' };

const worktreesRoot = () => process.env.JD_WORKTREES_ROOT || path.join(process.env.JD_HOME || path.join(os.homedir(), '.junior-dev'), 'worktrees');
const list = (repo) => { try { return fs.readdirSync(repo); } catch { return []; } };
const swiftPackageIsIos = (repo) => { try { return /platforms\s*:[^\]]*\.iOS\s*\(/s.test(fs.readFileSync(path.join(repo, 'Package.swift'), 'utf8')); } catch { return false; } };

/** The project to build: a workspace beats a project; a Swift package is the repo folder itself. */
function workspaceOf(repo) {
  const names = list(repo);
  const hit = names.find((n) => n.endsWith('.xcworkspace')) ?? names.find((n) => n.endsWith('.xcodeproj'));
  return hit ? path.join(repo, hit) : repo;
}

const errKind = (r) => (r?.error && typeof r.error === 'object' ? r.error.kind ?? 'error' : r?.error ?? r?.errorKind ?? null);
const toolCheck = (id, tool, workspacePath, pass) => ({ id, kind: 'tool', tool, arguments: { workspacePath }, pass, command: `tool:${tool} ${JSON.stringify({ workspacePath })} pass:${pass}` });

export default {
  name: 'ios',
  // A .xcodeproj or .xcworkspace at the repo root, or a Package.swift that declares an iOS platform.
  markers: { all: [], anyOf: [/\.xcodeproj$/, /\.xcworkspace$/], extra: swiftPackageIsIos },
  // Preflight items, run through the same path as plan checks. Not ready or tool missing fails with the reasons.
  readiness: () => [{ id: 'ios-ready', what: 'dsh-ios can serve an unattended iOS run (Xcode-backed, simulator)', tool: IOS_TOOLS.status, arguments: { worktreesRoot: worktreesRoot() }, pass: 'ios-ready' }],
  defaultChecks(repo) {
    const ws = workspaceOf(repo);
    return [toolCheck('build', IOS_TOOLS.build, ws, 'ios-build'), toolCheck('test', IOS_TOOLS.test, ws, 'ios-test')];
  },
  guidance: [
    'iOS repo notes (simulator only):',
    '- Use only the dsh-ios tools (ios_*) for anything about the simulator, builds or tests; never sign, archive, export or upload, and never target a real device.',
    '- SwiftUI: keep views small and state-driven (@State, @Binding, @Observable); move logic out of the view body into plain types you can test.',
    '- Tests: write them with Swift Testing (@Test, #expect) or XCTest, whichever the repo already uses; test through public interfaces, not private details.',
    '- Do not change project settings, schemes, entitlements or signing unless a requirement calls for it.',
  ].join('\n'),
  passRules: {
    // test: no error kind, failed == 0 and notRun == 0
    'ios-test': (r) => {
      const kind = errKind(r);
      if (kind) return { ok: false, output: `test run error: ${kind}${r?.error?.message ? ` (${r.error.message})` : ''}` };
      const c = r?.counts;
      if (!c || typeof c.failed !== 'number' || typeof c.notRun !== 'number') return { ok: false, output: 'test result has no counts' };
      const ok = c.failed === 0 && c.notRun === 0;
      const bad = (r.failures ?? []).slice(0, 5).map((f) => `${f.name ?? '?'}: ${f.message ?? ''}`).join('; ');
      return { ok, output: `total ${c.total}, passed ${c.passed}, failed ${c.failed}, notRun ${c.notRun}${ok || !bad ? '' : ` — ${bad}`}${r.xcresultPath ? ` (xcresult ${r.xcresultPath})` : ''}` };
    },
    // build: result === 'success'
    'ios-build': (r) => {
      const ok = r?.result === 'success';
      const errs = (r?.errors ?? []).slice(0, 5).map((e) => `${e.file ?? '?'}:${e.line ?? '?'} ${e.message ?? ''}`).join('; ');
      return { ok, output: `build ${r?.result ?? 'unknown'}${ok || !errs ? '' : ` — ${errs}`}${r?.logPath ? ` (log ${r.logPath})` : ''}` };
    },
    // readiness: ready === true; otherwise the reasons plus the one-time setup hint
    'ios-ready': (r) => {
      if (r?.ready === true) return { ok: true, output: '' };
      const reasons = [].concat(r?.reasons ?? []).join('; ') || 'dsh-ios reported not ready';
      const hint = [].concat(r?.setup ?? r?.hint ?? []).join('; ');
      return { ok: false, output: `${reasons}${hint ? ` — one-time setup: ${hint}` : ''}` };
    },
  },
  // Xcode MCP tools: mcp__<any server>__<known Xcode tool>. The RegExp is matched against live tool names
  // when known; the exact names for a server called "xcode" are the fallback (unknown names are dropped by DSH retry).
  hiddenTools: [
    new RegExp(`^mcp__.+__(?:${XCODE_TOOL_NAMES.join('|')})$`),
    ...XCODE_TOOL_NAMES.map((n) => `mcp__xcode__${n}`),
  ],
  // Before the human-check batch: a simulator screenshot reference. Failure to capture is noted, never fatal.
  humanEvidence: {
    tool: IOS_TOOLS.screenshot,
    arguments: {},
    reference: (v) => (typeof v === 'string' ? v : v?.path ?? v?.file ?? v?.url ?? v?.screenshotPath ?? JSON.stringify(v)),
  },
  // Builds and tests are long (ms). byTool is for tool checks; checkMs for everything else.
  timeouts: { checkMs: 30 * 60 * 1000, byTool: { [IOS_TOOLS.build]: 30 * 60 * 1000, [IOS_TOOLS.test]: 45 * 60 * 1000 } },
};
