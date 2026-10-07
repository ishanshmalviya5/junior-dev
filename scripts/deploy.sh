#!/usr/bin/env bash
# Deploy a COMMIT of junior-dev into a dsh profile (commit-only rule), the same way
# dsh-local-plugins deploys itself:
#   $DSH_HOME/local-plugins/.deployed/junior-dev@<sha12>   detached worktree snapshot
#   $DSH_HOME/local-plugins/.deployed/junior-dev           stable link -> snapshot (atomic swap)
# First run also adds `link:<stable>` to the profile. Restart dsh web afterwards.
# Usage: DSH_HOME=~/.dsh scripts/deploy.sh <profile> [ref] [dsh-bin]
set -euo pipefail
PROFILE="${1:?profile}"; REF="${2:-HEAD}"; DSH_BIN="${3:-dsh}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DEPLOYED="$HOME_DIR/local-plugins/.deployed"
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
SNAP="$DEPLOYED/junior-dev@${SHA:0:12}"
STABLE="$DEPLOYED/junior-dev"

if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then echo "note: uncommitted changes are NOT deployed (commit-only rule)"; fi
mkdir -p "$DEPLOYED"
git -C "$REPO" worktree prune
if [ ! -d "$SNAP" ]; then git -C "$REPO" worktree add -q --detach "$SNAP" "$SHA"; fi
printf '%s\n' "$SHA" > "$SNAP/.jd-deployed"
ln -s "$SNAP" "$STABLE.tmp.$$" && node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$STABLE.tmp.$$" "$STABLE"
echo "live -> $(basename "$SNAP")"

PJ="$HOME_DIR/profiles/$PROFILE/package.json"
if ! grep -q "\"junior-dev\": \"link:$STABLE\"" "$PJ"; then
  DSH_HOME="$HOME_DIR" "$DSH_BIN" plugin --profile "$PROFILE" add "link:$STABLE"
fi
NM="$HOME_DIR/profiles/$PROFILE/node_modules/junior-dev"
if [ "$(readlink "$NM" || true)" != "$STABLE" ]; then rm -rf "$NM"; ln -s "$STABLE" "$NM"; fi
echo "profile $PROFILE -> $STABLE (restart dsh web to load)"
