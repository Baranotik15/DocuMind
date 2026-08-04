#!/bin/bash
# Full CI check hook (PreToolUse for `git commit`)
#
# Runs your project's lint / format / type-check / test / build commands before a
# commit is allowed, so failures surface locally instead of in CI. It is a
# deterministic gate: if it exits non-zero, the commit is blocked.
#
# ── HOW TO USE ──────────────────────────────────────────────────────────────
# This is a SKELETON. Fill in the sections below with the commands for your
# stack. Each section only runs when relevant files are staged, so a polyglot
# repo (e.g. `services/api`, `web`) can have one section per component.
#
# Helpers (from run_silent.sh) keep output minimal on success and verbose on
# failure — good for keeping the agent's context clean:
#   print_header "Name"
#   run_silent_lint "Label" "<command>"           # for linters/formatters/type-checkers
#   run_silent      "Label" "<command>"           # for builds
#   run_silent_with_test_count "Label" "<cmd>" "<runner>"   # for test suites
#
# Context-efficient backpressure pattern:
#   https://www.hlyr.dev/blog/context-efficient-backpressure

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$PROJECT_DIR" || exit 1

source "$PROJECT_DIR/.claude/hooks/run_silent.sh"

STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)
if [ -z "$STAGED_FILES" ]; then
    echo "No staged files, skipping CI checks"
    exit 0
fi

EXIT_CODE=0

# ── EXAMPLE: a component living under `src/` ────────────────────────────────
# Uncomment and adapt. Delete the sections you don't need.
#
# if echo "$STAGED_FILES" | grep -qE '^src/'; then
#     cd "$PROJECT_DIR" || exit 1
#     print_header "Checks"
#
#     run_silent_lint "Format"     "<your formatter --check>"   || EXIT_CODE=1
#     run_silent_lint "Lint"       "<your linter>"              || EXIT_CODE=1
#     run_silent_lint "Type check" "<your type checker>"        || EXIT_CODE=1
#     run_silent_with_test_count "Unit tests" "<your test command>" "generic" || EXIT_CODE=1
#     run_silent "Build" "<your build command>" || EXIT_CODE=1
# fi

# ── EXAMPLE: lint GitHub Actions workflow files ─────────────────────────────
# if echo "$STAGED_FILES" | grep -qE '^\.github/workflows/'; then
#     print_header "GitHub Actions"
#     STAGED_WORKFLOWS=$(echo "$STAGED_FILES" | grep '^\.github/workflows/' | tr '\n' ' ')
#     if command -v actionlint &>/dev/null && [ -n "$STAGED_WORKFLOWS" ]; then
#         run_silent_lint "Actionlint" "actionlint $STAGED_WORKFLOWS" || EXIT_CODE=1
#     fi
# fi

# ⚠ SKELETON NOTICE: no checks are configured above, so this gate currently
# passes every commit. Fill in a section above, then delete the line below.
echo "ℹ ci-full.sh: no checks configured yet — edit .claude/hooks/ci-full.sh"

if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    printf "\033[0;31m━━━ CI checks failed. Fix issues before committing. ━━━\033[0m\n"
    echo ""
fi

exit $EXIT_CODE
