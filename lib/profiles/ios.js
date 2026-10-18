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

/**
 * Shared schemes of a project or workspace: [{name, tests}], `tests` when its test action has testables or a test plan.
 * Only shared schemes count: a worktree has no xcuserdata. A workspace also sees the projects next to it.
 */
export function schemesOf(container) {
  const dirs = [path.join(container, 'xcshareddata', 'xcschemes')];
  if (container.endsWith('.xcworkspace')) {
    const up = path.dirname(container);
    for (const n of list(up)) if (n.endsWith('.xcodeproj')) dirs.push(path.join(up, n, 'xcshareddata', 'xcschemes'));
  }
  const out = new Map();
  for (const d of dirs) {
    for (const n of list(d)) {
      if (!n.endsWith('.xcscheme')) continue;
      let xml = '';
      try { xml = fs.readFileSync(path.join(d, n), 'utf8'); } catch {}
      out.set(n.slice(0, -'.xcscheme'.length), /<TestableReference\b|<TestPlanReference\b/.test(xml));
    }
  }
  return [...out].map(([name, tests]) => ({ name, tests }));
}

/**
 * The schemes the default checks use (X2#4: a multi-scheme project could build or test the wrong target).
 * One shared scheme, or the one named after the project, is taken; otherwise the check says what the root must settle.
 */
function pickSchemes(ws) {
  const all = schemesOf(ws);
  if (!all.length) return { build: null, test: null, noTests: false, notes: {} };
  const own = path.basename(ws).replace(/\.(xcodeproj|xcworkspace)$/, '');
  const named = (xs) => (xs.length === 1 ? xs[0] : xs.find((x) => x.name === own) ?? null);
  const build = named(all);
  const withTests = all.filter((x) => x.tests);
  const test = build?.tests ? build : named(withTests);
  const notes = {};
  if (!build) notes.build = `several shared schemes (${all.map((x) => x.name).join(', ')}): settle the scheme with the developer and add "scheme" to the arguments`;
  if (!withTests.length) notes.build = [notes.build, `no shared scheme has tests (${all.map((x) => x.name).join(', ')}), so no test check is offered: a test check needs a scheme with a test target or test plan`].filter(Boolean).join('; ');
  else if (!test) notes.test = `several shared schemes have tests (${withTests.map((x) => x.name).join(', ')}): settle the scheme with the developer and add "scheme" to the arguments`;
  return { build: build?.name ?? null, test: test?.name ?? null, noTests: !withTests.length, notes };
}

const errKind = (r) => (r?.error && typeof r.error === 'object' ? r.error.kind ?? 'error' : r?.error ?? r?.errorKind ?? null);
const toolCheck = (id, tool, args, pass, note) => ({ id, kind: 'tool', tool, arguments: args, pass, command: `tool:${tool} ${JSON.stringify(args)} pass:${pass}`, ...(note && { note }) });

export default {
  name: 'ios',
  // A .xcodeproj or .xcworkspace in the project folder, or a Package.swift that declares an iOS platform.
  markers: { all: [], anyOf: [/\.xcodeproj$/, /\.xcworkspace$/], extra: swiftPackageIsIos },
  // Preflight items, run through the same path as plan checks. Not ready or tool missing fails with the reasons.
  readiness: () => [{ id: 'ios-ready', what: 'dsh-ios can serve an unattended iOS run (Xcode-backed, simulator)', tool: IOS_TOOLS.status, arguments: { worktreesRoot: worktreesRoot() }, pass: 'ios-ready' }],
  // The simulator (destination) is dsh-ios's choice: its contract takes no destination.
  defaultChecks(dir) {
    const ws = workspaceOf(dir);
    const s = pickSchemes(ws);
    const args = (scheme) => ({ workspacePath: ws, ...(scheme && { scheme }) });
    const out = [toolCheck('build', IOS_TOOLS.build, args(s.build), 'ios-build', s.notes.build)];
    // shared schemes and none with tests: a test check could only pass on nothing, so none is offered
    if (!s.noTests) out.push(toolCheck('test', IOS_TOOLS.test, args(s.test), 'ios-test', s.notes.test));
    return out;
  },
  // For the root agent while it plans (R3: twice it read a missing folder grant on the source repo as "use xcodebuild").
  rootNote: 'iOS: plan builds and tests as dsh-ios tool checks (ios_build, ios_test), never xcodebuild. junior-dev runs every check in the run\'s worktree under ~/.junior-dev/worktrees, which is the folder Xcode\'s headless server must permit; a missing folder grant for the source repo is expected and does not matter. Preflight proves dsh-ios through its readiness check only.',
  guidance: [
    'iOS repo notes (simulator only):',
    '- Use only the dsh-ios tools (ios_*) for anything about the simulator, builds or tests; never sign, archive, export or upload, and never target a real device.',
    '- SwiftUI: keep views small and state-driven (@State, @Binding, @Observable); move logic out of the view body into plain types you can test.',
    '- Tests: write them with Swift Testing (@Test, #expect) or XCTest, whichever the repo already uses; test through public interfaces, not private details.',
    '- Do not change project settings, schemes, entitlements or signing unless a requirement calls for it.',
  ].join('\n'),
  passRules: {
    // test: no error kind, failed == 0, notRun == 0 and at least one test passed. A run of zero tests, or of
    // only skipped ones (wrong scheme, disabled suite), proves nothing and fails (X2#1).
    'ios-test': (r) => {
      const kind = errKind(r);
      if (kind) return { ok: false, output: `test run error: ${kind}${r?.error?.message ? ` (${r.error.message})` : ''}` };
      const c = r?.counts;
      if (!c || typeof c.failed !== 'number' || typeof c.notRun !== 'number') return { ok: false, output: 'test result has no counts' };
      const none = !(c.passed > 0);
      const ok = c.failed === 0 && c.notRun === 0 && !none;
      const bad = (r.failures ?? []).slice(0, 5).map((f) => `${f.name ?? '?'}: ${f.message ?? ''}`).join('; ');
      const why = none && c.failed === 0 ? ` — no test passed (${c.skipped ? `${c.skipped} skipped` : 'none ran'}), so nothing is proven; check the scheme and that its tests are enabled` : '';
      return { ok, output: `total ${c.total}, passed ${c.passed}, failed ${c.failed}, skipped ${c.skipped ?? 0}, notRun ${c.notRun}${why}${ok || !bad ? '' : ` — ${bad}`}${r.xcresultPath ? ` (xcresult ${r.xcresultPath})` : ''}` };
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
  // dsh-ios's tools: workers of a run with no iOS repo never see them (they are a large part of every request).
  ownTools: [/^ios_/],
  // Before the human-check batch: a simulator screenshot reference. Failure to capture is noted, never fatal;
  // the hand check then says it has no screenshot.
  humanEvidence: {
    // the worktree's app is built, installed and launched first, or the screenshot shows the home screen (R3)
    before: (workPath) => ({ tool: 'ios_sim_build_run', arguments: { projectPath: workspaceOf(workPath) } }),
    tool: IOS_TOOLS.screenshot,
    arguments: {},
    reference: (v) => (typeof v === 'string' ? v : v?.path ?? v?.file ?? v?.url ?? v?.screenshotPath ?? JSON.stringify(v)),
  },
  // Builds and tests are long (ms). byTool is for tool checks; checkMs for everything else.
  timeouts: { checkMs: 30 * 60 * 1000, byTool: { [IOS_TOOLS.build]: 30 * 60 * 1000, [IOS_TOOLS.test]: 45 * 60 * 1000 } },
};
