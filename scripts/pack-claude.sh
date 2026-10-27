#!/bin/sh
# Build dist/junior-dev-claude.zip: the Claude Code plugin alone (no tests, docs, DSH client or patch), wrapped in a
# one-plugin marketplace so it can be installed permanently. Usage: scripts/pack-claude.sh
set -eu
cd "$(dirname "$0")/.."
out=dist/junior-dev-claude
rm -rf dist && mkdir -p "$out/plugin/.claude-plugin" "$out/.claude-plugin"
cp -R lib bin hooks commands skills package.json CREDITS.md "$out/plugin/"
cp .claude-plugin/plugin.json "$out/plugin/.claude-plugin/plugin.json"
cat > "$out/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "junior-dev-share",
  "owner": { "name": "junior-dev" },
  "description": "junior-dev for Claude Code",
  "plugins": [
    { "name": "junior-dev", "source": "./plugin", "description": "Paste a PRD, agree it with the interviewer, then it builds, verifies and delivers the feature unattended." }
  ]
}
JSON
cat > "$out/README.md" <<'MD'
# junior-dev for Claude Code

Paste a PRD, answer the interview until you agree it was understood, then junior-dev builds, verifies and delivers the feature on local `junior-dev/*` branches while you do something else.

Experimental. Requirements: macOS, Node 26 or newer, Claude Code 2.1.275 or newer.

## Install

Unzip this folder somewhere permanent, then:

    claude plugin marketplace add /path/to/junior-dev-claude
    claude plugin install junior-dev@junior-dev-share

Start a new Claude Code session in the repo you want to change and run `/junior-dev:junior-dev`, then paste the PRD as your next message.
For the short `/junior-dev`: `mkdir -p ~/.claude/commands && ln -s /path/to/junior-dev-claude/plugin/commands/junior-dev.md ~/.claude/commands/junior-dev.md`.

If Claude Code runs in its sandbox, allow local port binding (`sandbox.network.allowLocalBinding: true`): the plugin runs a loopback server for its workers.

## What to know first

- Workers run as `claude -p` processes with permissions bypassed. A plugin hook is the boundary: it keeps their writes inside the run's work folders and blocks pushes, PRs and other remote writes unless you granted them in the interview. The bash check is a heuristic.
- Each worker is a separate Claude session and uses your Claude plan. Set a small time or token budget for a first run.
- Local state lives in `~/.junior-dev/`; the documents and run log are in `docs/<feature>/` of your repo (git-excluded).
- Nothing is pushed unless you grant push permission during the interview.
- Skills in `plugin/skills` are adapted from mattpocock/skills (MIT), see `plugin/CREDITS.md`.
MD
(cd dist && zip -qr junior-dev-claude.zip junior-dev-claude)
find "$out" -type f | wc -l
du -h dist/junior-dev-claude.zip
