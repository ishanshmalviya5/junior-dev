// Registry of stack profiles and repo-stack detection. Host side: engine code never imports this.
import fs from 'node:fs';
import ts from './ts.js';
import ios from './ios.js';
import { XCODE_TOOL_NAMES } from '../engine/classify.js';

export const PROFILES = [ts, ios];
/** v2-09: find a pass rule by name across the registered profiles (first match). Returns the function or null. */
export function passRuleByName(name) {
  for (const p of PROFILES) if (typeof p.passRules?.[name] === 'function') return p.passRules[name];
  return null;
}
export const profileByName = (name) => PROFILES.find((p) => p.name === name) ?? null;

/**
 * Pure: names of the profiles whose markers match `files` (a Set or array of root file names).
 * A profile matches when all of `markers.all` exist, or any root file matches a `markers.anyOf` pattern,
 * or its `markers.extra(repoPath)` says so (v2-11: Package.swift content). `repoPath` is optional.
 */
export function matchProfiles(files, profiles = PROFILES, repoPath = null) {
  const list = [...files];
  const have = new Set(list);
  const hit = (m) => (m.all?.length > 0 && m.all.every((f) => have.has(f)))
    || (m.anyOf ?? []).some((re) => list.some((f) => re.test(f)))
    || Boolean(repoPath && m.extra?.(repoPath));
  return profiles.filter((p) => hit(p.markers)).map((p) => p.name);
}

/** Detect one repo: {profile, candidates, checks}. Two matches leave profile null until the developer answers; none = "no profile". */
export function detectStack(repoPath, profiles = PROFILES) {
  let files = [];
  try { files = fs.readdirSync(repoPath); } catch {}
  const candidates = matchProfiles(files, profiles, repoPath);
  const profile = candidates.length === 1 ? candidates[0] : null;
  return { profile, candidates, checks: profile ? profileByName(profile).defaultChecks(repoPath) : [] };
}

export const detectStacks = (repos) => Object.fromEntries(repos.map((r) => [r.path, detectStack(r.path)]));

const labelOf = (s) => (s.profile ? s.profile : s.candidates.length > 1 ? `ambiguous (${s.candidates.join(' or ')})` : 'no profile');

/** Text for the root agent, from the recorded stacks (state.settings.stacks). */
export function stacksNote(stacks, { withChecks = false } = {}) {
  const entries = Object.entries(stacks ?? {});
  if (!entries.length) return '';
  const lines = [];
  for (const [repo, s] of entries) {
    let l = `- ${repo}: ${labelOf(s)}`;
    if (!s.profile && s.candidates.length > 1) l += ` — ask the developer ONE jd_ask question which stack it is, then record it with jd_set stacks {"${repo}":"<profile>"}`;
    if (!s.profile && !s.candidates.length) l += ' — shell checks only, no question needed';
    if (withChecks && s.checks?.length) l += `\n  suggested default checks (from the repo's own scripts; the developer's parity yes is still needed): ${s.checks.map((c) => `${c.id}: \`${c.command}\``).join(', ')}`;
    lines.push(l);
  }
  const notes = [...new Set(entries.map(([, s]) => (s.profile && profileByName(s.profile)?.rootNote) || '').filter(Boolean))];
  return `Detected stacks:\n${lines.join('\n')}${notes.length ? `\n${notes.join('\n')}` : ''}`;
}

/** Guidance text for the repos a leaf touches (`touched`: repo paths; empty = all repos). */
export function guidanceFor(stacks, touched) {
  const seen = new Set();
  const out = [];
  for (const [repo, s] of Object.entries(stacks ?? {})) {
    if (touched?.length && !touched.includes(repo)) continue;
    const p = s.profile && profileByName(s.profile);
    if (p?.guidance && !seen.has(p.name)) { seen.add(p.name); out.push(p.guidance); }
  }
  return out.join('\n\n');
}

/**
 * Worker tools to hide for the recorded stacks. A profile lists exact names and/or RegExps; a RegExp is
 * matched against `available` (live tool names, when the caller knows them) and is otherwise skipped.
 */
// Tools no worker needs, whatever the stack: Xcode MCP (the gate denies them to workers anyway; v2-12), the Creator
// and root-only tools, and the goal, plan-mode, present and agent-messaging tools. Hiding them keeps them out of every
// request: a TS builder was sent 116 tools, about 147 KB, mostly Xcode MCP and dsh-ios (R2).
export const WORKER_HIDDEN = [
  new RegExp(`^mcp__.+__(?:${XCODE_TOOL_NAMES.join('|')})$`),
  'plugin_manager', /^cordis_inspect_/,
  'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode', 'present', 'send_message', 'interrupt_agent',
];

/**
 * The worker deny list for a run's stacks: WORKER_HIDDEN, each present profile's hiddenTools, and the ownTools of
 * every profile no repo uses. Entries are names or RegExps; with `available` (live tool names) the RegExps are
 * expanded to names, otherwise they are returned for the caller to expand.
 */
export function hiddenToolsFor(stacks, available) {
  const present = new Set(Object.values(stacks ?? {}).map((s) => s.profile).filter(Boolean));
  const entries = [...WORKER_HIDDEN];
  for (const p of PROFILES) entries.push(...(present.has(p.name) ? p.hiddenTools ?? [] : p.ownTools ?? []));
  if (!available) return [...new Set(entries)];
  const out = new Set();
  for (const t of entries) {
    if (typeof t === 'string') out.add(t);
    else for (const n of available) if (t.test(n)) out.add(n);
  }
  return [...out];
}

/** Profile timeout (ms) for one check: tool checks use the profile's per-tool limit, everything else checkMs. */
export function timeoutFor(profile, check) {
  const t = profile?.timeouts ?? {};
  return (check?.tool && t.byTool?.[check.tool]) || t.checkMs;
}

/** The longest limit any of the recorded stacks' profiles gives this check (undefined when none says). */
export function stackTimeoutFor(stacks, check, repoPath = null) {
  const vals = Object.entries(stacks ?? {})
    .filter(([repo]) => !repoPath || repo === repoPath)
    .map(([, s]) => timeoutFor(s.profile && profileByName(s.profile), check))
    .filter(Boolean);
  return vals.length ? Math.max(...vals) : undefined;
}

/** Shell steps that make a freshly prepared workspace of `repoPath` runnable (profile `workspaceSetup(workPath)`). */
export function workspaceSetupItems(stacks, repoPath, workPath) {
  const name = stacks?.[repoPath]?.profile;
  const p = name && profileByName(name);
  return typeof p?.workspaceSetup === 'function' ? p.workspaceSetup(workPath) : [];
}

/** Preflight items the recorded stacks need beyond the plan's own commands (profile `readiness`: array or function(repo)). */
export function readinessItems(stacks) {
  const seen = new Set();
  const out = [];
  for (const [repo, s] of Object.entries(stacks ?? {})) {
    const p = s.profile && profileByName(s.profile);
    if (!p?.readiness || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(...(typeof p.readiness === 'function' ? p.readiness(repo) : p.readiness));
  }
  return out;
}
