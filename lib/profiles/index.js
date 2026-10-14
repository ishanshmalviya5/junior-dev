// Registry of stack profiles and repo-stack detection. Host side: engine code never imports this.
import fs from 'node:fs';
import ts from './ts.js';

export const PROFILES = [ts];
/** v2-09: find a pass rule by name across the registered profiles (first match). Returns the function or null. */
export function passRuleByName(name) {
  for (const p of PROFILES) if (typeof p.passRules?.[name] === 'function') return p.passRules[name];
  return null;
}
export const profileByName = (name) => PROFILES.find((p) => p.name === name) ?? null;

/** Pure: names of the profiles whose markers are all present in `files` (a Set or array of root file names). */
export function matchProfiles(files, profiles = PROFILES) {
  const have = new Set(files);
  return profiles.filter((p) => p.markers.all.every((f) => have.has(f))).map((p) => p.name);
}

/** Detect one repo: {profile, candidates, checks}. Two matches leave profile null until the developer answers; none = "no profile". */
export function detectStack(repoPath, profiles = PROFILES) {
  let files = [];
  try { files = fs.readdirSync(repoPath); } catch {}
  const candidates = matchProfiles(files, profiles);
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
  return `Detected stacks:\n${lines.join('\n')}`;
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

export const hiddenToolsFor = (stacks) => [...new Set(Object.values(stacks ?? {}).flatMap((s) => (s.profile && profileByName(s.profile)?.hiddenTools) || []))];
