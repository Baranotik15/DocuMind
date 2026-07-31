#!/bin/bash
# Parse CI failure logs to extract targeted errors with file:line references
#
# Usage: gh run view <run-id> --log-failed | .claude/hooks/parse-ci-failures.sh
#
# Input: Raw output from `gh run view <run-id> --log-failed`
# Output: Structured, minimal error list grouped by type
#
# Example output:
#   ## Python (pytest)
#   - FAILED tests/unit/test_auth.py::test_foo - AssertionError: expected 200
#
#   ## Python (mypy)
#   - app/services/auth.py:23 - error: Incompatible return type

set -e

# Temporary files for collecting errors
PYTEST_ERRORS=$(mktemp)
MYPY_ERRORS=$(mktemp)
RUFF_ERRORS=$(mktemp)
TSC_ERRORS=$(mktemp)
VITEST_ERRORS=$(mktemp)
SCALA_ERRORS=$(mktemp)
OTHER_ERRORS=$(mktemp)

cleanup() {
    rm -f "$PYTEST_ERRORS" "$MYPY_ERRORS" "$RUFF_ERRORS" "$TSC_ERRORS" "$VITEST_ERRORS" "$SCALA_ERRORS" "$OTHER_ERRORS"
}
trap cleanup EXIT

# Read all input
INPUT=$(cat)

# Parse pytest failures
# GitHub Actions logs have prefix: "test	UNKNOWN STEP	<timestamp> [gwX] [XX%] FAILED tests/..."
# The summary section has: "FAILED tests/path.py::test_name - error message"
# We want the summary lines (with " - " containing the error message)
# Remove JSON noise that sometimes appears at the end (cut at first '{')
echo "$INPUT" | grep -E "FAILED tests/[^ ]+\.py::.* - " | \
    sed 's/^.*FAILED /- FAILED /; s/{.*//' | \
    head -50 >> "$PYTEST_ERRORS" 2>/dev/null || true

# Also catch ERROR tests (collection errors) - summary lines only
echo "$INPUT" | grep -E "ERROR tests/[^ ]+\.py::.* - " | \
    sed 's/^.*ERROR /- ERROR /; s/{.*//' | \
    head -50 >> "$PYTEST_ERRORS" 2>/dev/null || true

# Parse mypy errors
# Match patterns like: app/services/auth.py:23: error: Incompatible return type
echo "$INPUT" | grep -E "\.py:[0-9]+: error:" | \
    sed -E 's/^[[:space:]]*/- /' | \
    grep "^- " | \
    head -50 >> "$MYPY_ERRORS" 2>/dev/null || true

# Parse ruff errors
# Match patterns like: app/api/v1/users.py:15:1: E501 Line too long
echo "$INPUT" | grep -E "\.py:[0-9]+:[0-9]+: [A-Z][0-9]+" | \
    sed -E 's/^[[:space:]]*/- /' | \
    grep "^- " | \
    head -50 >> "$RUFF_ERRORS" 2>/dev/null || true

# Parse TypeScript errors
# Match patterns like: src/components/Auth.tsx(45,12): error TS2339
echo "$INPUT" | grep -E "\.tsx?[:(][0-9]+" | grep -E "error TS[0-9]+" | \
    sed -E 's/(\(([0-9]+),([0-9]+)\))/:\2:\3/; s/^[[:space:]]*/- /' | \
    head -50 >> "$TSC_ERRORS" 2>/dev/null || true

# Parse Vitest failures
# Match patterns like: FAIL src/components/Auth.test.tsx > test name
echo "$INPUT" | grep -E "^(FAIL|×) " | \
    sed 's/^FAIL /- /; s/^× /- /' | \
    head -50 >> "$VITEST_ERRORS" 2>/dev/null || true

# Parse Scala compile errors
# Match patterns like: [error] backend/migration/src/Foo.scala:123: type mismatch
echo "$INPUT" | grep -E "\[error\].*\.scala:[0-9]+" | \
    sed 's/^\[error\] */- /' | \
    head -50 >> "$SCALA_ERRORS" 2>/dev/null || true

# Also catch mill test failures
echo "$INPUT" | grep -E " - .* \*\*\* FAILED \*\*\*" | \
    sed 's/^.* - /- /' | \
    head -20 >> "$SCALA_ERRORS" 2>/dev/null || true

# Output results
OUTPUT=""

if [ -s "$PYTEST_ERRORS" ]; then
    OUTPUT+="## Python (pytest)\n"
    OUTPUT+=$(sort -u "$PYTEST_ERRORS")
    OUTPUT+="\n\n"
fi

if [ -s "$MYPY_ERRORS" ]; then
    OUTPUT+="## Python (mypy)\n"
    OUTPUT+=$(sort -u "$MYPY_ERRORS")
    OUTPUT+="\n\n"
fi

if [ -s "$RUFF_ERRORS" ]; then
    OUTPUT+="## Python (ruff)\n"
    OUTPUT+=$(sort -u "$RUFF_ERRORS")
    OUTPUT+="\n\n"
fi

if [ -s "$TSC_ERRORS" ]; then
    OUTPUT+="## Frontend (TypeScript)\n"
    OUTPUT+=$(sort -u "$TSC_ERRORS")
    OUTPUT+="\n\n"
fi

if [ -s "$VITEST_ERRORS" ]; then
    OUTPUT+="## Frontend (Vitest)\n"
    OUTPUT+=$(sort -u "$VITEST_ERRORS")
    OUTPUT+="\n\n"
fi

if [ -s "$SCALA_ERRORS" ]; then
    OUTPUT+="## Scala (compile/test)\n"
    OUTPUT+=$(sort -u "$SCALA_ERRORS")
    OUTPUT+="\n\n"
fi

if [ -z "$OUTPUT" ]; then
    echo "## No parsed errors found"
    echo ""
    echo "Raw failure output may not match expected patterns."
    echo "Check the raw logs with: gh run view <run-id> --log-failed"
else
    echo -e "$OUTPUT"
fi
