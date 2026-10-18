# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

junior-dev is a DSH (DeepSeek Harness, `@deepseek-ai/dsh`) plugin package. It ships an agent preset ("Junior Dev"): you paste a PRD, it interviews the developer until they agree it has understood the work (parity), then builds, verifies and delivers the feature unattended. The run is driven by plugin code (a state machine plus a scheduler), not by the LLM. Plain JavaScript ES modules, Node ≥ 26, macOS only, with no runtime dependencies (`@deepseek-ai/cordis` is a peer dependency).

**Branches:**
- `main` now carries v2 (fast-forwarded from `v2` on 2026-10-16, after R2 and R3 passed). v1 is the history before that.
- v2 added:
  - practices adapted from mattpocock/skills;
  - stack profiles, TS and iOS;
  - tool-call checks;
  - creator capability.

This file describes v2. It passed the manual real-AI runs R2 (TS) and R3 (iOS, and mixed iOS + TS).

**Hard rule: nothing goes to a remote.** No push, no PR, no remote branch, no remote ticket. This is a local test project.

## Commands

```sh
npm run check                                   # lint + all tests (what to run before committing)
npm run lint                                    # node --check on every .js/.mjs in lib/ test/ scripts/ client/ (syntax only, no style linter)
npm test                                        # node --test --test-concurrency=1 "test/*.test.js"
node --test --test-name-pattern="v2-03" test/host.test.js   # one test (names start with their check ID)
npm run gen:patch [path/to/dsh]                 # regenerate cordis.patch.yml (default: /opt/homebrew/lib/node_modules/@deepseek-ai/dsh)
DSH_HOME=~/.dsh scripts/deploy.sh web HEAD dsh  # deploy a COMMIT into dsh profile "web", then restart dsh web
```

- Tests must run serially (`--test-concurrency=1`). The host tests mutate `process.env` (`JD_HOME`, `JD_WORKTREES_ROOT`, `PATH` with a fake `gh`) and share the `hub` singleton.
- The full suite takes about 40–60 s. It builds real throwaway git repos with local bare remotes in the OS temp dir. `v2` has 136 tests, including `test/client.test.js`, which renders the progress dock with a stub React.
- Deploys are commit-only. `deploy.sh` snapshots a commit into a detached worktree under `$DSH_HOME/local-plugins/.deployed/`, and uncommitted changes are never deployed. Ask before restarting dsh web (see the user's global CLAUDE.md for the host vs container instances on port 3080).

## Architecture

### Two halves
- **Engine (`lib/engine/`)**: pure logic with **no DSH imports and no stack code**. It covers the event store, the reducer, the run phase machine, the work tree and its ripple rules, the scheduler, thresholds, the permission classifier, document parsers and validators, budget, locks, progress and the report (including the risk call). Its tests are the U-checks.
- **Host (`lib/host/`, `client/`)**: the DSH glue. It covers the tools, the permission gate, the background loop, the check runner, worker spawning and the briefs. Its tests are the T-checks, in `test/host.test.js`.
  - DSH services are reached only through `lib/host/services.js`: `spawnWorker`, `ask`, `notifyRoot`, `executeTool`, `bundleLoaded` and others.
  - Tests replace these services with `hub.overrides`. That is the main test seam.
- **Stack profiles (`lib/profiles/`)**: one module per stack (`ts.js`, `ios.js`) plus a registry. The engine never imports them.

### Two plugin rows, one shared module instance
`cordis.patch.yml` inserts two rows:
1. **`junior-dev`** (`lib/index.js`) is the host-plane plugin. It:
   - sets `hub.host`;
   - loads the store secret from `~/.junior-dev/secret`;
   - installs the `tools/pre-execute` gate (`lib/host/gate.js`);
   - serves `GET /api/junior-dev/progress`, which the `client/client.js` progress dock polls.
2. **`preset-junior-dev`** is a full copy of DSH's `standard` preset, because presets cannot extend each other. On top of that copy:
   - the persona prefix is replaced with `PROTOCOL` from `lib/host/prompts.js`;
   - **Creator mode's three rows** are added: the read-only cordis inspect tools, the plugin-development skills, and an enabled `plugin_manager`;
   - `skill-filesystem` mounts both Creator's skills and junior-dev's own `skills/`;
   - the `junior-dev/tools` row (`lib/tools-plugin.js`) is appended to register the `jd_*` tools.

Both rows meet through `lib/host/hub.js`, a process-wide registry of runs keyed by `sessionFolder::featureName`, with session→run and worker→run maps. It also persists `~/.junior-dev/active.json`, so runs re-attach after a DSH restart.

**`cordis.patch.yml` is generated. Never edit it by hand.** Run `npm run gen:patch` and commit the result after changing `PROTOCOL`, after changing the skill or creator rows in `scripts/gen-patch.mjs`, or after a DSH upgrade.

### State: event-sourced, single writer
- Each run lives in `<sessionFolder>/docs/<feature>/`. The state is in `state/events.jsonl` (append-only, fsynced before acting) and `state/snapshot.json` (atomic tmp+rename). The snapshot also stores a hash chain used to detect direct edits.
- Every change goes through `Store.commit(event)` → pure `reduce(state, event)` (`lib/engine/store.js`, `lib/engine/reducer.js`). Replay and live use run the same reducer, so a new state change means a new event type handled in the reducer. Never mutate state directly.
- `lib/engine/run.js` (`Run`) is the façade the host uses. It wraps the store, phases, tree, ledger, queue and docs.
- The gate refuses any agent write to the state dir or docs, including writes through Xcode MCP file tools. The docs folder is added to the repo's `.git/info/exclude`, and delivery refuses if any doc is tracked.

### Run phases (`lib/engine/phases.js`)
`intake → research → interview → prd_parity → requirements → verification_plan → specs → implementation_plan → preflight → final_parity → build → verify → human_checks → deliver → done`. The side states are `paused`, `stopped` and `blocked`. Every edge has a guard. `advance` commits either a `phase` event or a `phase_refused` event that lists reasons. The document guards (traceability between requirement IDs, check IDs, spec items and plan steps) live in `lib/engine/docs.js`. Leaving verify requires a `review_done` note.

### Checks (`lib/host/run-check.js`)
Every check run goes through `runAnyCheck`: the loop, preflight and `jd_decide`. Workers never judge their own checks. A check is one of two kinds:
- **Shell:** `{command, cwd}`. It passes on exit 0.
- **Tool call:** `{tool, arguments, pass}`. The plugin calls the tool itself through `executeTool` and judges the result with the named **pass rule** from a stack profile. In plan and verification-plan tables it is written as `` `tool:<name> <json-args> pass:<rule>` ``.

Timeouts come from the repo's stack profile unless a limit is given explicitly.

### Stack profiles (`lib/profiles/`)
- **Fields:** each profile has `markers`, `readiness`, `defaultChecks`, `passRules`, `guidance`, `rootNote`, `hiddenTools`, `ownTools`, `humanEvidence`, `timeouts` and `workspaceSetup`. `workspaceSetup` runs in `jd_prepare` for a fresh worktree (TS: install the declared deps with the lockfile's own tool). A failed setup is a failed preflight entry and blocks the build.
- **Detection:** happens when repos are set (`jd_set repos`). The result is stored as `settings.stacks` per repo, and an ambiguous repo is resolved with `jd_set stacks`. A repo with no profile runs on shell checks only.
  - The repo root wins. Only when it matches nothing are the folders below it searched (3 levels deep; dependency and build folders are skipped), e.g. `ios/App.xcodeproj` or `bff/packages/api`. The matched folders are stored as `dirs`. Their shell checks get a `cwd`, and workspace setup and the screenshot launch run there.
  - It is still one profile per repo: iOS and a BFF in one repo come out ambiguous.
- **Worker tools:** `WORKER_HIDDEN` in `lib/profiles/index.js` (Xcode MCP, Creator and root-only, goal, plan-mode and messaging tools) plus each absent profile's `ownTools` (dsh-ios's `ios_*` when no repo is iOS) are filtered out of every worker. `services.startChild` learns the names DSH can filter from its `tools.restrict()` error and expands the RegExps. Tools DSH can't filter out of a child (`subagent`, `workflow` and the like) are denied by the gate.
- **What a profile feeds:**
  - a leaf's brief gets the guidance for the repo(s) its checks target;
  - `hiddenTools` feed the worker deny filter;
  - default checks are offered to the root agent for the verification plan.
- **TS:** uses the repo's own `test`, typecheck and `lint` scripts. It installs only the repo's declared deps (in `workspaceSetup`), never extra tooling.
- **iOS:** junior-dev knows **only dsh-ios** (ADR 0001). It expects these tools: `ios_status`, `ios_build`, `ios_test` and `ios_sim_screenshot`. Their exact contract is in `docs/junior-dev-v2/handoff-dsh-ios.md`. dsh-ios provides all four (verified live in DSH at dsh-ios 0a5ff64).
  - It is simulator-only: never sign, archive or upload.
  - Default checks name a shared scheme. They use the only scheme, or the one named after the project, and the test check uses a scheme that has tests. When the choice is unclear, the check carries a `note` for the root agent. The simulator is dsh-ios's choice.
  - The `ios-test` pass rule fails a run in which no test passed (zero tests, or all skipped).
  - The gate denies workers any `mcp__<server>__<Xcode tool>`, whatever the server is called.
  - Human checks in iOS repos carry a simulator screenshot. If the capture fails, the check says it is "unverified by screenshot".

### Tools
- **Root tools** (developer-facing agent) drive the interview and the documents: `jd_status`, `jd_start`, `jd_ask`, `jd_parity`, `jd_write_doc`, `jd_tree`, `jd_set` (including `repos`, `stacks` and `bundles`), `jd_advance`, `jd_run` and others.
- **Worker tools** act only on the current item: `jd_node`, `jd_submit` (with an optional `rootCause`), `jd_split`, `jd_add`, `jd_contract`, `jd_decide`, `jd_block` and `jd_set_checks` (only for a leaf found green before work).
- All of them are in `lib/host/tools.js`. Root-only tools refuse child agents. Workers never ask the developer: `ask_user_question` is denied, and uncertain calls go through `jd_decide`, which may park the item and queue its question.
- Models often send structured arguments as JSON text, so the tools accept both (`maybeJson`).
- `plugin_manager` (Creator capability, ADR 0002):
  - workers are always denied it;
  - the root agent is denied it from `build` on;
  - bundles are built under `docs/<feature>/plugins/` and installed before final parity;
  - preflight confirms each one is loaded (`cordis_inspect_query` Config/listConfigs);
  - the report lists them.

### The unattended loop (`lib/host/loop.js`)
Plugin code drives build → verify → human_checks → deliver, one worker at a time:
- **Write access:** workers inherit the chat's sandbox, and the worktrees (`~/.junior-dev/worktrees/<feature>/`) are outside the chat's workspace. So every loop start and resume sets the chat to Full access (`setFullAccess`); the gate stays the boundary. Ending the run restores Workspace Write. If access can't be set, the run stops with that reason.
- **Budget (`lib/engine/budget.js`):** tokens count cache reads at a tenth (`effectiveTokens`). Time counts only while the loop runs (`runningMs`, from `usage.runMs`/`runSince` in the reducer), so a stopped run resumed later isn't stopped at once.
- **Pick and spawn:** the scheduler (`lib/engine/scheduler.js`) picks the next ready leaf, critical path first. A worker is spawned with a brief from `prompts.js`, which contains its role's **practice skill** from `skills/`:
  - planner: slicing;
  - builder: red-first building and test quality;
  - fixer: debugging;
  - reviewer: review axes.

  The brief also carries stack guidance and the repo's glossary.
- **Red-first:** every leaf is a **behaviour leaf** or a **refactor leaf** (`leafKind`; the tree refuses a leaf without one). The plugin runs a leaf's checks *before* the builder starts.
  - A behaviour leaf that is already green goes back to the planner once. If it's still green, it parks with a question, and the developer's answer decides: rewrite the check, already done, or drop the leaf.
  - A refactor leaf must be green both before and after.
  - Before/after evidence goes into the report and the PR.
- **Commit or roll back:** on submit, the plugin runs the checks. A pass commits. A fail, or a `JD-DEBUG` tagged line left in the diff, rolls back to the last good commit.
- **Verify and deliver:**
  - regression checks, then the full verification plan;
  - **review**, once per repo and always on, reported on two axes: Standards (the repo's own rule files) and Spec;
  - Standards violations and missing requirements go to the capped fix loop; scope creep is only reported;
  - one batch of human checks plus queued questions;
  - delivery: a PR per repo or local branches, plus `report.md`.
- **The report and PR body:**
  - both carry the risk call (High/Medium/Low, from the ledger), the red-first evidence and the review;
  - "suggestions for your repo" is the report's last section and never appears in the PR.

### Work tree (`lib/engine/tree.js`)
Nodes are broken down just in time. Ripple rules R1–R7 keep the tree consistent:
- R1 cover: children's done-when covers the parent's.
- R2 trace: every node traces to a requirement.
- R3 roll-up: a parent is done only when its children are done and its integration check passes.
- R4 contracts: changing a provided contract marks its users for recheck.
- R5 order: a node waits for its dependencies; cycles are refused.
- R6 push-down: a parent's changed done-when re-checks its descendants.
- R7 budget: overspend rolls up.

Rule K1 refuses a leaf with no valid kind. The item states are `new → ready → working → submitted → checking → done`, with the side states `split`, `recheck`, `parked` and `blocked`. Decision thresholds scale with blast radius (`lib/engine/threshold.js`). Changes to the contract (requirements or checks), irreversible changes and remote changes always become questions for the developer.

### Safety invariants (enforced in code; tests cover them)
- **Remote writes are gated.** `lib/engine/classify.js` classifies git push, PRs, databases, cloud CLIs, MCP write tools, and iOS uploads (altool, notarytool, Transporter, `xcodebuild -exportArchive`, fastlane). The gate blocks them unless the interview recorded permission. Read-only remote calls pass.
- **Worker write boundary.** Workers change files only inside the run's work paths and the temp dir, never in the developer's own checkout (`gate.js`, `bashWriteOutside`). This covers write and edit tools, and bash commands after following `workdir`, `cd`, redirects and operands. It is a heuristic: code a command runs, such as `node -e`, is not seen. The root agent is not limited by it.
- **Branch rules.** `commit` and `rollback` in `lib/engine/git.js` refuse any branch that is not `junior-dev/*`. Pushes go only to `junior-dev/*` and never use force.
- **Locks.** Checkouts are locked per run (`lib/engine/locks.js`).

## Conventions

- **Check IDs** name the tests and appear in code comments, so search by ID:
  - `U*`: engine unit checks.
  - `T*`: in-process host checks with a fake AI.
  - `W*`: browser checks.
  - `R*`: real runs.
  - `X*`: independent review findings.
  - `H*`: human checks.
  - `v2-NN`: tests added for v2 ticket NN.

  Spec items are `S*`, requirements are letter+number (`A1`, `J4`…), plan steps are `P*`. Comments like `// S24:` point into the design docs.
- **Domain terms** are in `GLOSSARY.md`: stack profile, leaf, behaviour leaf, refactor leaf, red-first, check, pass rule, review, practice skill and tooling skill. Use them.
- **Local-only documents.** Decisions are in `docs/adr/` and the design docs in `docs/junior-dev/` (v1) and `docs/junior-dev-v2/` (v2 tickets in `issues/`, plus the dsh-ios handoff). All of them, and `GLOSSARY.md`, are local only through `.git/info/exclude` and never committed. Read the relevant ticket or ADR before changing engine behaviour.
- **Practice skills** in `skills/` are adapted from mattpocock/skills (MIT, see `CREDITS.md`). Keep them in junior-dev's terms, and never tell a worker to ask the user.
- **Commit messages** are one plain sentence, often tagged with where the finding came from, e.g. "Fixes from the real-AI toy run (R1)" or "(v2 ticket 03)".

## Real-DSH e2e (manual)
- The isolated DSH copy lives at `~/.dsh-test` and serves on port 3091. The toy repo is `~/.dsh-test/work/toy`.
- `test/e2e/fake-llm` is a test-only DSH plugin. When `JD_FAKE_SCRIPT` names a JSON script (`test/e2e/script-*.json`), it intercepts `llm/stream` and replays that script. Without one, it passes calls through to the real models.
- `test/e2e/make-script-full.mjs` regenerates `script-full.json`.

Environment variables:
- `JD_HOME`: default `~/.junior-dev`.
- `JD_WORKTREES_ROOT`: default `~/.junior-dev/worktrees`.
- `JD_RETRY_ASK_MS`: how long the loop waits before retrying an ask.
- `JD_STORE_SECRET`: the store's hash-chain key.
