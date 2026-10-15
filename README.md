# junior-dev

A DSH (DeepSeek Harness) agent preset. Paste a PRD into a **Junior Dev** chat. junior-dev researches first, then interviews you one simple question at a time until you agree it understands the work exactly (parity). It then builds, verifies and delivers the feature unattended.

## How a run goes
1. **Research, interview, PRD parity.** junior-dev asks only what research couldn't answer.
2. **Requirements and verification plan.** Both are written by interview and need your parity yes.
3. **Specs and implementation plan.** Written without an interview. You're asked only if something new comes up.
4. **Preflight.** Every tool, credential and model is checked while you're still there. Then comes the final parity.
5. **Unattended loop (plugin code, not an AI):**
   - The work tree is broken down as needed, in vertical slices, and built one item at a time.
   - **Red-first:** the plugin runs each item's checks before the builder starts. A behaviour item must fail first; a refactor item must pass before and after.
   - The plugin runs each item's checks again after the work, then commits (pass) or rolls back (fail).
   - Then verification, a capped fix loop, optional cross-model review, and one batch of hand checks.
   - **Review**, once per repo, on two axes: Standards (the repo's own rule files) and Spec.
   - Then delivery: a PR per repo, or local branches, plus the report in the chat. The report and PR carry a risk call (High/Medium/Low) and the red-first evidence; the report ends with suggestions for your repo.
   - The loop gives the chat Full access while it runs (the workers' worktrees are outside the chat's folder) and restores Workspace Write when it ends.

Everything lives in `docs/<feature>/` in the chat's folder, excluded from git locally:
- the documents;
- `state/events.jsonl` + `state/snapshot.json`, the run's state machine;
- `report.md` and `ledger.md`.

Running junior-dev again resumes from the last checkpoint.

## Stacks
- **Stack profiles** (`lib/profiles/`) are detected per repo: **TS** (the repo's own test, typecheck and lint scripts; a fresh worktree gets its declared deps installed) and **iOS** (through the [dsh-ios](https://github.com/ZSeven-W/dsh-ios) plugin's `ios_status`, `ios_build`, `ios_test` and `ios_sim_screenshot`, simulator only). One run can span both.
- A check is a shell command or a tool call judged by the profile's pass rule.
- Workers get a practice skill for their role (adapted from [mattpocock/skills](https://github.com/mattpocock/skills), see `CREDITS.md`).

## Safety
- Remote writes are blocked in code unless the interview recorded permission. This covers git push, PRs, databases, cloud CLIs and MCP write tools. Read-only remote calls are allowed.
- Pushes go only to `junior-dev/*` branches and never use force.
- Rollback and commit refuse to run on any branch other than `junior-dev/*`.
- iOS uploads (altool, notarytool, Transporter, archive export, fastlane) count as remote writes. Workers can't use Xcode MCP tools or the plugin manager.
- Workers can't ask you anything. Uncertain calls are scored against evidence; below the bar, the item parks and its question waits for one batch.

## Develop
```sh
npm run check            # lint + 126 tests (engine U-checks, in-process T-checks, v2-NN ticket checks)
npm run gen:patch        # regenerate cordis.patch.yml from the installed dsh's standard preset
DSH_HOME=~/.dsh scripts/deploy.sh web HEAD dsh   # commit-only deploy, then restart dsh web
```

Isolated real-DSH e2e:
- Test copy: `~/.dsh-test`, port 3091.
- Uses `test/e2e/fake-llm` (scripted model) and `test/e2e/script-*.json`.

Design docs: `docs/junior-dev/` (v1) and `docs/junior-dev-v2/` (v2 tickets), kept locally and not committed.
