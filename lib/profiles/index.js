// Registry of stack profiles and repo-stack detection. Host side: engine code never imports this.
import fs from 'node:fs';
import path from 'node:path';
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

// Folders never searched for a project: dependencies, build output and bundles.
const SKIP_DIRS = new Set(['node_modules', 'Pods', 'Carthage', 'build', 'dist', 'out', 'DerivedData', 'vendor', 'coverage']);
const DETECT_DEPTH = 3;

/** Folders below `repo` (relative, shallowest first), up to DETECT_DEPTH, skipping hidden, dependency and bundle folders. */
function subdirs(repo) {
  const out = [];
  let level = [''];
  for (let d = 0; d < DETECT_DEPTH; d++) {
    const nextLevel = [];
    for (const rel of level) {
      let ents = [];
      try { ents = fs.readdirSync(path.join(repo, rel), { withFileTypes: true }); } catch {}
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name) || /\.(xcodeproj|xcworkspace|xcassets|app|framework|bundle)$/.test(e.name)) continue;
        nextLevel.push(path.join(rel, e.name));
      }
    }
    out.push(...nextLevel);
    level = nextLevel;
  }
  return out;
}

/**
 * Which profiles match where: {profileName: [relative folders]}. The repo root wins; only when it matches nothing are
 * the folders below it searched (X2#4: ios/App.xcodeproj, bff/packages/api). A folder inside one
 * already matched by the same profile is not counted again.
 */
export function findProjects(repoPath, profiles = PROFILES) {
  const at = (rel) => {
    let files = [];
    try { files = fs.readdirSync(path.join(repoPath, rel)); } catch {}
    return matchProfiles(files, profiles, path.join(repoPath, rel));
  };
  const root = at('');
  if (root.length) return Object.fromEntries(root.map((n) => [n, ['']]));
  const found = {};
  for (const rel of subdirs(repoPath)) {
    for (const n of at(rel)) {
      const dirs = (found[n] ??= []);
      if (!dirs.some((d) => rel.startsWith(`${d}${path.sep}`))) dirs.push(rel);
    }
  }
  return found;
}

/** Default checks of `profile` for its project folders in `repoPath`. A folder below the root gives shell checks its cwd. */
export function checksFor(repoPath, profile, dirs = ['']) {
  const p = profileByName(profile);
  if (!p) return [];
  return dirs.flatMap((rel) => p.defaultChecks(path.join(repoPath, rel)).map((c) => ({
    ...c,
    ...(dirs.length > 1 && { id: `${c.id}@${rel}` }),
    ...(rel && !c.tool && !c.cwd && { cwd: path.join(repoPath, rel) }),
  })));
}

/**
 * Detect one repo: {profile, candidates, dirs, found, checks}. Two profiles leave profile null until the developer
 * answers; none = "no profile". `dirs` are the profile's project folders, relative to the repo ('' = the root).
 */
export function detectStack(repoPath, profiles = PROFILES) {
  const found = findProjects(repoPath, profiles);
  const candidates = Object.keys(found);
  const profile = candidates.length === 1 ? candidates[0] : null;
  const dirs = profile ? found[profile] : [];
  return { profile, candidates, dirs, found, checks: profile ? checksFor(repoPath, profile, dirs) : [] };
}

/** The recorded stack of a repo after the developer named its profile (jd_set stacks): folders from detection. */
export function stackFor(repoPath, cur, profile) {
  const dirs = profile ? cur?.found?.[profile] ?? [''] : [];
  return { ...cur, profile, dirs, checks: profile ? checksFor(repoPath, profile, dirs) : [] };
}

/** Project folders of a recorded stack ('' = the repo root; stacks recorded before folders existed are at the root). */
export const projectDirs = (s) => (s?.dirs?.length ? s.dirs : ['']);

export const detectStacks = (repos) => Object.fromEntries(repos.map((r) => [r.path, detectStack(r.path)]));

const where = (dirs) => (dirs?.some(Boolean) ? ` in ${dirs.map((d) => d || '.').join(', ')}` : '');
const labelOf = (s) => (s.profile ? `${s.profile}${where(s.dirs)}` : s.candidates.length > 1 ? `ambiguous (${s.candidates.map((c) => `${c}${where(s.found?.[c])}`).join(' or ')})` : 'no profile');
const checkLine = (c) => `${c.id}: \`${c.command}\`${c.cwd ? ` (cwd ${c.cwd})` : ''}${c.note ? ` [${c.note}]` : ''}`;

/** Text for the root agent, from the recorded stacks (state.settings.stacks). */
export function stacksNote(stacks, { withChecks = false } = {}) {
  const entries = Object.entries(stacks ?? {});
  if (!entries.length) return '';
  const lines = [];
  for (const [repo, s] of entries) {
    let l = `- ${repo}: ${labelOf(s)}`;
    if (!s.profile && s.candidates.length > 1) l += ` — ask the developer ONE jd_ask question which stack it is, then record it with jd_set stacks {"${repo}":"<profile>"}`;
    if (!s.profile && !s.candidates.length) l += ' — shell checks only, no question needed';
    if (withChecks && s.checks?.length) l += `\n  suggested default checks (from the repo's own scripts; the developer's parity yes is still needed): ${s.checks.map(checkLine).join(', ')}`;
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

/**
 * Shell steps that make a freshly prepared workspace of `repoPath` runnable: profile `workspaceSetup(projectPath, workPath)`
 * for each project folder, deduplicated by where they run. An item's `cwd` (absent = the work path) is where it runs.
 */
export function workspaceSetupItems(stacks, repoPath, workPath) {
  const s = stacks?.[repoPath];
  const p = s?.profile && profileByName(s.profile);
  if (typeof p?.workspaceSetup !== 'function') return [];
  const seen = new Set();
  const out = [];
  for (const rel of projectDirs(s)) {
    for (const it of p.workspaceSetup(path.join(workPath, rel), workPath)) {
      const at = it.cwd ?? workPath;
      if (seen.has(`${at}@@${it.command}`)) continue;
      seen.add(`${at}@@${it.command}`);
      out.push({ ...it, ...(at !== workPath && { id: `${it.id}@${path.relative(workPath, at)}`, cwd: at }) });
    }
  }
  return out;
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
