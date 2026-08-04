#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
NAME=$(echo "$INPUT" | jq -r '.name')
REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"

log() { echo "$*" >/dev/tty 2>/dev/null || echo "$*" >&2; }

if [ -z "$REPO" ]; then
  log "ERROR: Could not determine repository root"
  exit 1
fi

if [ -z "$NAME" ] || [ "$NAME" = "null" ]; then
  log "ERROR: Worktree name is required"
  exit 1
fi

DIR="${REPO}/.worktrees/${NAME}"

if [ -d "$DIR" ]; then
  log "ERROR: Worktree already exists at $DIR"
  exit 1
fi

mkdir -p "${REPO}/.worktrees"
log "Creating worktree: ${NAME}"

if git -C "$REPO" show-ref --verify --quiet "refs/heads/$NAME"; then
  git -C "$REPO" worktree add "$DIR" "$NAME" >/dev/null
else
  git -C "$REPO" worktree add "$DIR" -b "$NAME" HEAD >/dev/null
fi

# ── Optional: install dependencies for the new worktree ─────────────────────
# A fresh worktree shares .git but not ignored build artifacts (node_modules,
# virtualenvs, etc.). Uncomment and adapt to your stack so the worktree is
# ready to build/test immediately. Example:
#
#   log "Installing dependencies..."
#   (cd "$DIR" && <your install command>) >/dev/null 2>&1 \
#     || { log "ERROR: dependency install failed"; exit 1; }

echo "$DIR"
