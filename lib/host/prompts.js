// Model-facing text: the preset protocol, per-phase next steps, document formats and worker briefs.
import fs from 'node:fs';
import path from 'node:path';
import { describeCheck } from '../engine/checks.js';
import { unsettled } from '../engine/phases.js';
import { stacksNote } from '../profiles/index.js';

// Practice skills (v2-02): the plugin writes each role's skill text into its brief, read once from the
// package's skills folder at load time so it is deterministic and cannot be skipped.
export const SKILLS_DIR = new URL('../../skills/', import.meta.url);
function loadSkill(name) {
  const raw = fs.readFileSync(new URL(`${name}/SKILL.md`, SKILLS_DIR), 'utf8');
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}
// v2-04: every temporary debug log carries this tag; the plugin refuses to commit while a tagged line is in the diff.
export const DEBUG_TAG = 'JD-DEBUG';

export const SKILL_TEXT = Object.fromEntries(['slicing', 'red-first-building', 'test-quality', 'debugging', 'review-axes'].map((n) => [n, loadSkill(n)]));
export const ROLE_SKILLS = {
  planner: ['slicing'],
  builder: ['red-first-building', 'test-quality'],
  fixer: ['debugging'],
  reviewer: ['review-axes'],
};
const skillsFor = (role) => (ROLE_SKILLS[role] ?? ROLE_SKILLS.builder).map((n) => SKILL_TEXT[n]).join('\n\n');

export const PROTOCOL = `You are junior-dev, a coding agent powered by the {{model}} model.

junior-dev turns a PRD into a delivered feature. The plugin's code owns the process: a state machine with guarded phases, a work tree, a scheduler, checks and a permission gate. You drive it only through the jd_* tools.

Rules:
1. Call jd_status first in every turn where junior-dev is involved, and follow its "next" instructions exactly.
2. If the developer pasted a PRD and no run is active, call jd_start (it reads the PRD from their message verbatim; never retype it). If they invoke you without a PRD, call jd_resume.
3. Research before asking: query the repos, tools and MCP servers first; record what you learn with jd_fact (text + source). Never ask what research can answer.
4. Research reads each repo's domain docs when present (GLOSSARY.md, GLOSSARY-MAP.md, CONTEXT.md, docs/adr/ or adr/) and records the relevant terms and decisions with jd_fact, the file as source. Use the repo's terms in documents and questions. Never contradict an ADR without raising it as a question.
5. Ask the developer only through jd_ask: exactly one simple question per call, plain words, multiple choice when possible with your recommended option. Never use ask_user_question.
6. Interview in design-tree order: keep a tree of open decisions in mind and ask only questions whose prerequisite decisions are settled.
7. No assumptions. Anything uncertain becomes a question.
8. Parity: restate your understanding with jd_parity; the plugin asks the developer and records their yes.
9. Write junior-dev documents only with jd_write_doc and fix every reason it returns.
10. If a repo already keeps a glossary or ADRs, new terms or hard-to-reverse decisions settled in the interview become requirements and plan leaves that update those files, so the PR carries them. If it keeps none, never create them.
11. Once the build loop runs (jd_run), do not do the work yourself and do not ask anything. If the developer sends a message about a change, call jd_pause, settle the change with them, update the documents, call jd_resettle, then jd_run.
12. If a capability is missing, you may build a DSH bundle under docs/<feature>/plugins/<name>/ (follow the cordis-plugin-development skill) and install it with plugin_manager install_bundle before final parity, then record it with jd_fact and jd_set bundles. Never during the loop.
13. When the loop sends you its report, relay it to the developer in full.`;

export const DOC_FORMATS = {
  requirements: `Format for requirements.md (the validator is strict):
# <feature> — Requirements
## Highlights
### What gets built
- 3–5 plain bullets
### What doesn't
- explicitly out of scope
### Decisions & assumptions
- every choice made by research or defaults, so the developer can veto it
### What needs you
- permissions, human checks, risks
## Requirements
Group by area. Each requirement is a bullet that starts with a bold ID, then acceptance criteria as sub-bullets:
- **A1 Short title.** What must be true.
  - acceptance criterion
IDs: one capital letter (area) + number (A1, A2, B1 …). IDs never change once given.`,
  verificationPlan: `Format for verification-plan.md (the validator is strict):
# <feature> — Verification plan
## Highlights   (same four ### subsections as requirements: What gets built / What doesn't / Decisions & assumptions / What needs you)
## Checks
| ID | Kind | Check | Proves | Command |
|---|---|---|---|---|
| U1 | automated | what is checked | A1, A2 | \`npm test -- greet\` |
| H1 | human | what the developer looks at | B1 | |
Rules: every requirement ID appears in at least one Proves cell. Kind is exactly "automated" or "human". Prefer automated; use human only when no script can judge it. Commands run from the first repo's work directory unless the implementation plan gives a Cwd; they must exit 0 on pass.
Tool check: instead of a shell command, the Command cell may hold \`tool:<name> <json-args> pass:<rule>\` (e.g. \`tool:xcode_build {"scheme":"App"} pass:build_ok\`). The plugin calls that tool itself and judges the result with the stack profile's pass rule <rule>; the JSON args are optional and must be an object; \`pass:\` is required and the rule must exist in the detected stack profile.`,
  specs: `Format for specs.md:
# <feature> — Specs
- **S1 Title.** What to build and how, precisely enough that no design decision is left. [A1, A2]
- **S1.1 Sub-item.** ... [A1]
Every spec item cites the requirement IDs it serves in [brackets]; every requirement is cited at least once.`,
  implementationPlan: `Format for implementation-plan.md:
# <feature> — Implementation plan
| Step | Work | Specs | Checks |
|---|---|---|---|
| P1 | what to do | S1, S1.1 | U1 |
## Check commands
| Check | Command | Cwd |
|---|---|---|
| U2 | \`node --test test/export.test.js\` | /abs/path/to/repo |
Every step cites spec items and check IDs. Every automated check must end up with a command or tool check (in the verification plan or here); the Command cell here accepts the same \`tool:<name> <json-args> pass:<rule>\` form.`,
};

const TREE_HELP = `Work tree: call jd_tree {op:"init"} once (root = all requirements), then jd_tree {op:"split", nodeId:"N", children:[...]} with the top-level items. Each child:
{ "title": "...", "doneWhen": ["criterion", ...], "covers": ["N#A1", ...], "traces": {"requirements": ["A1"], "checks": ["U1"]},
  "checks": [{"command": "a shell command that exits 0 when this item is done", "cwd": "/abs/repo"} or {"tool": "tool_name", "arguments": {...}, "pass": "a pass rule of the stack profile"}]  (or "needsSplit": true for an item a planner will break down later),
  "kind": "behaviour" (changes what the software does: its check must FAIL before the work) or "refactor" (structure only: its check must PASS before and after) — required on every leaf, not on needsSplit items,
  "dependsOn": ["#1"] (siblings by 1-based index), "provides": [{"name": "greet()", "description": "signature + behaviour"}], "uses": ["C:N.1:greet()"], "risk": "low|med|high" }
Slice vertically: the first leaf is the thinnest end-to-end slice (one case through the public interface, with its test); each later leaf adds behaviour that only its own check exercises. Never make a "foundations" leaf that builds what later leaves are for: their checks would go red only because a test is new, which proves nothing.
Rules enforced by code: children together cover every parent criterion (R1); every item traces to requirements inside its parent's (R2); no dependency loops (R5); a leaf needs a check and a kind (or needsSplit). The plugin runs a leaf's check before any builder starts (red-first).`;

// Workers inherit this chat's sandbox and the worktrees lie outside its folder; the plugin, not the developer, grants
// the access (R2b: a write probe before jd_prepare failed and the agent twice recommended in-place mode instead).
const WRITE_ACCESS_NOTE = 'jd_prepare gives this chat Full access for the build, because workers inherit it and the worktrees (~/.junior-dev/worktrees) lie outside this folder; the loop grants it again on every resume and restores Workspace Write when the run ends. A write into a worktree before jd_prepare fails, and that is expected: it is no reason to work in place.';

// R2 finding 6: six one-setting questions became one confirmation of proposed defaults.
const RUN_SETTINGS_HELP = `Run settings: once the repos are known, call jd_models, then propose every unsettled run setting together in ONE jd_ask, listed in its detail: repo mode (recommend "worktree"), permissions (recommend local commits only: no push, no PR, no remote writes, no paid models), a model per role (planner, builder, checker; recommend subscription models: they never spend paid extra credits, the run stops when the subscription is used up), cross-model check (recommend off), budget (time and tokens) and dial (recommend "balanced"). Options: "Use these settings" (recommended) and "Change some". On "Change some", ask one question per setting the developer wants to change. Then record each with jd_set. A pay-per-token model needs the developer's explicit yes, recorded as permissions.paidModels: true. ${WRITE_ACCESS_NOTE}`;

export function nextStep(state, { loopRunning = false } = {}) {
  const miss = unsettled(state);
  const phase = state.phase;
  const stacks = stacksNote(state.settings?.stacks);
  const stacksWithChecks = stacksNote(state.settings?.stacks, { withChecks: true });
  if (state.side === 'paused') return `The run is paused (${state.sideReason}). Settle the change with the developer (jd_ask), update the affected documents with jd_write_doc, then call jd_resettle with the earliest affected phase (requirements, verification_plan, specs, implementation_plan or build), then continue from there.`;
  if (state.side === 'stopped') return `The run stopped: ${state.sideReason}. The report is in report.md. If the developer raises the budget (jd_set budget), call jd_run to resume.`;
  if (state.side === 'blocked') return `The run is blocked: ${state.sideReason}. Relay the report (report.md) to the developer.`;
  switch (phase) {
    case 'intake':
    case 'research':
      return 'Research the PRD: read the relevant repos, tools, MCP servers and any sources the developer named. Record each useful finding with jd_fact (text + source). If there is truly nothing to research, call jd_fact with note:"nothing_to_research". Then jd_advance to "interview".';
    case 'interview':
      return `Interview the developer with jd_ask about everything research could not settle, one question per call, until nothing is uncertain. Confirm the feature name (jd_set name). Settle and record with jd_set when known: ${miss.join('; ') || 'all settings are settled'}. ${RUN_SETTINGS_HELP} Then jd_advance to "prd_parity".${stacks ? `\n\n${stacks}` : ''}`;
    case 'prd_parity':
      return `Restate your full understanding of the PRD in plain words (what will be built, for whom, what is out, constraints${stacks ? ', and the detected stack of each repo' : ''}) and call jd_parity {key:"prd", restatement}. If the developer says it is not right, ask follow-ups with jd_ask and call jd_parity again. On yes: jd_advance to "requirements".${stacks ? `\n\n${stacks}` : ''}`;
    case 'requirements':
      return `Write the requirements with jd_write_doc {key:"requirements"} and fix every reason it returns. Then interview the developer on anything still open in it (jd_ask), update the doc, and get parity with jd_parity {key:"requirements", restatement} (a plain-words summary). Then jd_advance to "verification_plan".\n\n${DOC_FORMATS.requirements}`;
    case 'verification_plan':
      return `Write the verification plan with jd_write_doc {key:"verificationPlan"}, fix every reason, interview the developer on open points, then jd_parity {key:"verificationPlan", restatement}. Then jd_advance to "specs".${stacksWithChecks ? `\n\n${stacksWithChecks}` : ''}\n\n${DOC_FORMATS.verificationPlan}`;
    case 'specs':
      return `Write the specs with jd_write_doc {key:"specs"} WITHOUT an interview; ask (jd_ask) only about something earlier interviews left open. Then jd_advance to "implementation_plan".\n\n${DOC_FORMATS.specs}`;
    case 'implementation_plan':
      return `Write the implementation plan with jd_write_doc {key:"implementationPlan"} (no interview). Then build the work tree.\n\n${DOC_FORMATS.implementationPlan}\n\n${TREE_HELP}\n\nThen jd_advance to "preflight".`;
    case 'preflight':
      return `Settle anything still open with the developer (jd_ask + jd_set): ${miss.join('; ') || 'nothing — all settled'}. Then call jd_preflight with shell commands that prove every tool, MCP, credential and repo the plan needs works (e.g. "gh auth status" if PRs are allowed, the test runner's --version). The plugin also checks every chosen model. Fix failures with the developer now. Then jd_advance to "final_parity".`;
    case 'final_parity':
      return `Call jd_prepare (locks + workspaces). ${WRITE_ACCESS_NOTE} Then restate the whole plan in plain words — what will be built, what will not, permissions, budget, models, the human checks that will come at the end — and call jd_parity {key:"final", restatement}. On yes: call jd_run. Tell the developer they can step away; the plugin works alone from here.`;
    case 'build':
    case 'verify':
    case 'human_checks':
    case 'deliver':
      return loopRunning
        ? 'The build loop is running. Do not do the work yourself and do not ask anything. If the developer asks for a change, call jd_pause first.'
        : 'The build loop is not running (for example after a restart). Call jd_run to resume it from the last checkpoint.';
    case 'done':
      return 'The run is done. Relay the report (report.md) to the developer if you have not already.';
    default:
      return 'Call jd_start with the PRD, or jd_resume.';
  }
}

// v2-07: workers use the repo's own terms. Finds glossary files at the root of each work path; a small file
// is included whole, a larger one is only pointed to.
export const DOMAIN_DOC_NAMES = ['GLOSSARY.md', 'GLOSSARY-MAP.md', 'CONTEXT.md'];
export const DOMAIN_DOC_INLINE_MAX = 4096;
export function domainDocsNote(workPaths) {
  const out = [];
  for (const wp of workPaths) {
    for (const name of DOMAIN_DOC_NAMES) {
      const file = path.join(wp, name);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      out.push(text.length <= DOMAIN_DOC_INLINE_MAX ? `- ${file} (use these terms):\n${text.trim()}` : `- ${file}: read it and use these terms`);
    }
  }
  return out.length ? `This repo keeps a glossary; use its terms in code, names and comments:\n${out.join('\n')}` : '';
}

export const RULES_INLINE_MAX = 4096;
/** The repo's own rule files (Standards), inlined when short so workers follow them without a read. */
export function repoRulesNote(workPaths) {
  const out = [];
  for (const wp of workPaths) {
    let names = [];
    try { names = fs.readdirSync(wp).sort(); } catch { continue; }
    for (const n of names.filter((x) => /^(CLAUDE|AGENTS)\.md$|^(CONTRIBUTING|CODING_STANDARDS)/i.test(x))) {
      const file = path.join(wp, n);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      out.push(text.length <= RULES_INLINE_MAX ? `- ${file}:\n${text.trim()}` : `- ${file}: read it before you change anything`);
    }
  }
  return out.length ? `This repo's own rules (the review judges your work against them):\n${out.join('\n')}` : '';
}

/** Where a check runs: a repo path (or a path inside one) is shown as its work path. */
function workCwd(run, cwd) {
  for (const r of run.state?.settings?.repos ?? []) {
    if (!r.workPath) continue;
    if (cwd === r.path) return r.workPath;
    if (cwd.startsWith(`${r.path}/`)) return r.workPath + cwd.slice(r.path.length);
  }
  return cwd;
}

/** A check as it actually runs: its cwd and a tool check's workspacePath point into the worktree (R3: a builder called ios_build on the source repo). */
function workCheck(run, c) {
  const ws = c.arguments?.workspacePath;
  return { ...c, ...(c.cwd ? { cwd: workCwd(run, c.cwd) } : {}), ...(typeof ws === 'string' ? { arguments: { ...c.arguments, workspacePath: workCwd(run, ws) } } : {}) };
}

/** The documents name the source repos; checks run in the worktrees. Without this the reviewer flagged correct checks (R3). */
function worktreeMapNote(run) {
  const map = (run.state?.settings?.repos ?? []).filter((r) => r.workPath).map((r) => `${r.path} → ${r.workPath}`);
  return map.length ? `The documents name the source repos, but the plugin runs every check in the worktrees (${map.join('; ')}). A check path that names a source repo is not a finding.` : '';
}

/** Every DSH bash call needs a short description; workers lost their first turn to this in R2. */
const BASH_NOTE = 'Every bash call needs a short "description" argument (what the command does), or it is refused. Run it with "workdir" set to your work path: changes outside the work paths (and the temp dir) are refused.';

/** Build only this leaf: the other unfinished leaves are named so the builder leaves their behaviour alone. */
function othersNote(run, node) {
  const nodes = Object.values(run.state?.tree?.nodes ?? {});
  const parents = new Set(nodes.map((n) => n.parentId).filter(Boolean));
  const others = nodes.filter((n) => n.id !== node.id && !parents.has(n.id) && n.parentId && n.status !== 'done').map((n) => `- ${n.id} ${n.title}`);
  return [
    'Build only what this item\'s checks and done-when criteria need. Do not build behaviour that belongs to other items, even if it is easy.',
    others.length ? `Other items still to build (not yours):\n${others.slice(0, 15).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export function workerBrief({ role, node, run, contracts, workPaths, failure, stackGuidance = '' }) {
  const reqText = node.traces.requirements.join(', ');
  const lines = [
    `You are a junior-dev ${role}. You work alone: you cannot ask the developer anything.`,
    `Feature: ${run.name}. Documents (read them first): ${run.dir}/requirements.md, verification-plan.md, specs.md, implementation-plan.md.`,
    `Work in: ${workPaths.join(', ')} (branch junior-dev/${run.name}). Never commit, push or touch ${run.dir}; the plugin commits after its checks pass.`,
    '',
    `Your item: ${node.id} — ${node.title}`,
    `Goal: ${node.goal}`,
    `Done when:\n${node.doneWhen.map((c) => `- ${c.text}`).join('\n')}`,
    `Serves requirements: ${reqText}`,
    node.checks.length ? `The plugin will run these checks after you submit (all must exit 0):\n${node.checks.map((c) => `- ${describeCheck(workCheck(run, c))}${c.cwd ? ` (in ${workCwd(run, c.cwd)})` : ''}`).join('\n')}` : '',
    contracts.length ? `Contracts:\n${contracts.map((c) => `- ${c.id} v${c.version}${c.ownerNodeId === node.id ? ' (you provide it)' : ''}: ${c.description}`).join('\n')}` : '',
    failure ? `\nPrevious attempt failed. Check output:\n${failure}` : '',
    '',
  ];
  if (role === 'planner') {
    const ev = run.state?.leafEvidence?.[node.id];
    if (ev?.before?.ok && ev.kind === 'behaviour') {
      lines.push(
        'RED-FIRST REPLAN: this is a behaviour leaf, but its check already PASSES before any work, so it proves nothing.',
        `Check output:\n${ev.before.output}`,
        'Your job: rewrite the check so it fails until the behaviour exists (jd_set_checks {checks:[{command, cwd}]}), or split the item (jd_split) if it is too coarse. Do not write code. You get one replan.',
      );
    } else lines.push(
      'Your job: break this item into smaller children with jd_split. Do not write code.',
      'Each child must be small enough to build and check in one go, with its own check command.',
      TREE_HELP.replace('jd_tree {op:"split", nodeId:"N", children:[...]}', 'jd_split {children:[...]}').replace(/"N#/g, `"${node.id}#`),
      `Parent criteria to cover: ${node.doneWhen.map((c) => c.id).join(', ')}.`,
    );
  } else {
    lines.push(
      node.leafKind === 'refactor' ? 'This is a refactor leaf: change structure only. Its checks passed before you started and must still pass; behaviour must not change.' : node.leafKind === 'behaviour' ? 'This is a behaviour leaf: its checks failed before you started (red-first); make them pass by building the behaviour.' : '',
      'Your job: implement this item so its checks pass. Then call jd_submit with a short summary.',
      othersNote(run, node),
      `Temporary debug logs must carry the tag ${DEBUG_TAG}; the plugin refuses to commit while any tagged line remains, so remove them before you submit.`,
      'Any choice the documents do not settle: call jd_decide (with your evidence). If it answers "park", stop working on this item and end.',
      'If something stops you (missing access, a contradiction, a broken dependency): call jd_block with what, why, how you found it and fixes that break no guideline and add no tech debt, then end. Never work around a blocker.',
      'If this item is too big, call jd_split instead of implementing it.',
      'Changing something other items rely on (a contract): call jd_contract with the new description.',
    );
  }
  lines.push('', BASH_NOTE, repoRulesNote(workPaths), domainDocsNote(workPaths), stackGuidance, 'Practice skills you must follow:', skillsFor(role === 'planner' ? 'planner' : 'builder'));
  return lines.filter((l) => l !== '').join('\n');
}

export function fixBrief({ run, check, output, workPaths, requirementText }) {
  return [
    'You are a junior-dev builder fixing a failed verification check. You cannot ask the developer anything.',
    `Feature: ${run.name}. Documents: ${run.dir}/requirements.md, verification-plan.md, specs.md.`,
    `Work in: ${workPaths.join(', ')}. Never commit, push or touch ${run.dir}.`,
    `Failed check ${check.id} (${check.kind}): ${check.text ?? ''}`,
    check.command || check.tool ? `Command: ${describeCheck(workCheck(run, check))}` : '',
    `It proves: ${check.requirementIds.join(', ')}${requirementText ? `\n${requirementText}` : ''}`,
    `Output / finding:\n${output}`,
    BASH_NOTE,
    repoRulesNote(workPaths),
    domainDocsNote(workPaths),
    'Fix the cause (not the check). Any unsettled choice → jd_decide. Anything blocking → jd_block, then end. When done, call jd_submit with a summary and rootCause (the confirmed root cause; it goes into the commit message).',
    `Temporary debug logs must carry the tag ${DEBUG_TAG}; the plugin refuses to commit while any tagged line remains.`,
    '',
    'Practice skill you must follow:',
    skillsFor('fixer'),
  ]
    .filter(Boolean)
    .join('\n');
}

export function reviewBrief({ run, workPaths, diffStat, standardsFiles = [] }) {
  return [
    'You are an independent reviewer for junior-dev. You did not write this code. Be strict.',
    `Read ${run.dir}/requirements.md and verification-plan.md, then review the changes in ${workPaths.join(', ')} (branch junior-dev/${run.name}; compare with its base).`,
    diffStat ? `Changed files:\n${diffStat}` : '',
    worktreeMapNote(run),
    domainDocsNote(workPaths),
    standardsFiles.length ? `This repo's standards files (the Standards axis is judged against these): ${standardsFiles.join(', ')}` : 'This repo has no standards files; judge Standards only against common smells.',
    'Report only real problems: a requirement not met, a bug, a missing check, a silent workaround.',
    'Answer with JSON only: {"findings":[{"requirement":"A1","problem":"...","where":"file:line","severity":"high|med|low"}]} — an empty list if everything is right. Add an "axis":"standards|spec" field to each finding, and for a spec finding a "kind":"missing|wrong|scope creep" field.',
    'Optionally add a top-level "suggestions":["..."] list: checks, standards or tooling this repo lacks that would have helped this run (for example no typecheck script, no CONTRIBUTING). These are advice for the developer only and are never acted on.',
    '',
    'Practice skill you must follow:',
    skillsFor('reviewer'),
  ]
    .filter(Boolean)
    .join('\n');
}

export function secondOpinionBrief(decision) {
  return [
    'You are a second, independent reviewer of one engineering decision. Answer with JSON only: {"agree":true|false,"why":"..."}.',
    `Decision: ${decision.what}`,
    `Options: ${(decision.options ?? []).join(' | ') || '(not listed)'}`,
    `Chosen: ${decision.choice}`,
    `Reasoning: ${decision.why ?? ''}`,
    `Evidence: ${(decision.evidence ?? []).join(' | ')}`,
  ].join('\n');
}
