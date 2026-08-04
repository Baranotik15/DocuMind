#!/bin/bash
# Session Finalize Hook
# Triggers when a Claude Code session ends (cloud only)
# Checks for branch changes vs main and reminds to run /finalize for PR-ready code

set -euo pipefail

# Only run in remote Claude Code Web environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

# Check if git is available
if ! command -v git &>/dev/null; then
    echo "=== Session End ==="
    echo "WARNING: git command not found. Cannot check for changes."
    exit 0
fi

# Get project directory with explicit error handling
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    PROJECT_DIR="$CLAUDE_PROJECT_DIR"
elif git_toplevel=$(git rev-parse --show-toplevel 2>&1); then
    PROJECT_DIR="$git_toplevel"
else
    echo "=== Session End ==="
    echo "WARNING: Not in a git repository. Cannot check for changes."
    exit 0
fi

# Change to project directory with error handling
if ! cd "$PROJECT_DIR" 2>/dev/null; then
    echo "=== Session End ==="
    echo "WARNING: Cannot access project directory: $PROJECT_DIR"
    exit 0
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if [ -z "$CURRENT_BRANCH" ]; then
    echo "=== Session End ==="
    echo "WARNING: Not on a branch (detached HEAD). Cannot check for changes."
    exit 0
fi

# Skip if on main branch
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
    echo "=== Session End ==="
    echo "On $CURRENT_BRANCH branch. No PR review needed."
    exit 0
fi

# Check for all changes in branch vs main (full branch diff)
if ! BRANCH_CHANGES=$(git diff --name-only origin/main...HEAD 2>&1); then
    # Fallback to local main if origin/main doesn't exist
    if ! BRANCH_CHANGES=$(git diff --name-only main...HEAD 2>&1); then
        echo "=== Session End ==="
        echo "WARNING: Failed to compare branch to main: $BRANCH_CHANGES"
        exit 0
    fi
fi

# Also check for uncommitted changes
UNCOMMITTED=$(git diff --name-only 2>/dev/null || true)
STAGED=$(git diff --cached --name-only 2>/dev/null || true)

# Combine all changes (branch + uncommitted + staged)
# Use printf instead of echo -e to avoid interpreting backslashes in filenames
ALL_CHANGES=$(printf '%s\n%s\n%s\n' "$BRANCH_CHANGES" "$UNCOMMITTED" "$STAGED" | grep -v '^$' | sort -u || true)

if [ -z "$ALL_CHANGES" ]; then
    echo "=== Session End ==="
    echo "No changes detected in branch '$CURRENT_BRANCH' vs main."
    exit 0
fi

# Count files
FILE_COUNT=$(echo "$ALL_CHANGES" | wc -l | tr -d ' ')

# Check for uncommitted work
UNCOMMITTED_COUNT=0
if [ -n "$UNCOMMITTED" ] || [ -n "$STAGED" ]; then
    UNCOMMITTED_COUNT=$(printf '%s\n%s\n' "$UNCOMMITTED" "$STAGED" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
fi

echo "=== Session End Review Required ==="
echo ""
echo "Branch: $CURRENT_BRANCH"
echo "Total files changed vs main: $FILE_COUNT"
if [ "$UNCOMMITTED_COUNT" -gt 0 ]; then
    echo "Uncommitted changes: $UNCOMMITTED_COUNT file(s)"
fi
echo ""
echo "Files:"
echo "$ALL_CHANGES" | head -15
if [ "$FILE_COUNT" -gt 15 ]; then
    echo "... and $((FILE_COUNT - 15)) more"
fi
echo ""
echo "ACTION REQUIRED: Run /finalize to review code before creating PR."
echo ""
echo "The /finalize command will:"
echo "  1. Review ALL changes in branch vs main"
echo "  2. Launch review agents in parallel"
echo "  3. Critically evaluate and auto-fix issues"
echo "  4. Deliver production-ready code"
echo ""

exit 0
