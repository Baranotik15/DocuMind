#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
WORKTREE_PATH=$(echo "$INPUT" | jq -r '.worktree_path')
REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"

[ ! -d "$WORKTREE_PATH" ] && exit 0

BRANCH=$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)

git -C "$REPO" worktree remove "$WORKTREE_PATH" --force 2>/dev/null || true

if [ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  if ! git -C "$REPO" branch -d "$BRANCH" 2>/dev/null; then
    echo "Warning: branch '$BRANCH' has unmerged commits, keeping it. Use 'git branch -D $BRANCH' to force delete." >&2
  fi
fi

git -C "$REPO" worktree prune 2>/dev/null || true
exit 0
