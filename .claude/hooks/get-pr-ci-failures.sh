#!/bin/bash
# Fetch and parse CI failures for a PR
#
# Usage: .claude/hooks/get-pr-ci-failures.sh <PR_NUMBER>
#
# Returns structured CI failure information including:
# - Failed check names
# - Parsed error messages from logs
# - Links to failure details
#
# Exit codes:
#   0 - No failures (all checks passing)
#   1 - Has failures
#   2 - No checks found or PR doesn't exist

set -e

PR_NUMBER=$1

if [ -z "$PR_NUMBER" ]; then
    # Try to detect PR from current branch
    PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || echo "")
fi

if [ -z "$PR_NUMBER" ]; then
    echo "## CI Status"
    echo "⚠️ No PR specified and couldn't detect from current branch"
    echo ""
    exit 0
fi

# Get CI check status
CHECKS=$(gh pr checks "$PR_NUMBER" --json name,state,bucket,link,workflow 2>/dev/null || echo "[]")

if [ "$CHECKS" = "[]" ]; then
    echo "## CI Status"
    echo "⚠️ No CI checks found for PR #$PR_NUMBER"
    echo ""
    exit 2
fi

# Count failures
FAILED_COUNT=$(echo "$CHECKS" | jq '[.[] | select(.bucket == "fail")] | length')

if [ "$FAILED_COUNT" -eq 0 ]; then
    echo "## CI Status"
    echo "✅ All checks passing"
    echo ""
    TOTAL_CHECKS=$(echo "$CHECKS" | jq 'length')
    echo "Total checks: $TOTAL_CHECKS"
    echo ""
    exit 0
fi

# Extract failed checks
echo "## CI Status"
echo "❌ $FAILED_COUNT check(s) failing"
echo ""

# List failed checks
echo "### Failed Checks"
echo "$CHECKS" | jq -r '.[] | select(.bucket == "fail") | "- \(.name) (\(.workflow))"'
echo ""

# Get the PR branch to find run IDs
BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName -q .headRefName)

# Get recent failed runs for this branch
FAILED_RUNS=$(gh run list --branch "$BRANCH" --status failure --json databaseId,name --limit 10 2>/dev/null || echo "[]")

if [ "$FAILED_RUNS" != "[]" ]; then
    echo "### Failure Details"
    echo ""

    # For each failed run, parse the logs
    echo "$FAILED_RUNS" | jq -r '.[].databaseId' | head -3 | while read -r RUN_ID; do
        RUN_NAME=$(echo "$FAILED_RUNS" | jq -r ".[] | select(.databaseId == $RUN_ID) | .name")

        echo "#### $RUN_NAME (Run #$RUN_ID)"
        echo ""

        # Get and parse the failure logs
        PARSED_ERRORS=$(gh run view "$RUN_ID" --log-failed 2>/dev/null | "$(dirname "$0")/parse-ci-failures.sh" 2>/dev/null || echo "")

        if [ -n "$PARSED_ERRORS" ]; then
            echo "$PARSED_ERRORS"
        else
            echo "_No parsed errors - check logs manually_"
        fi

        echo ""
    done
else
    echo "### Failure Details"
    echo ""
    echo "_Run logs not yet available - checks may still be running_"
    echo ""
fi

exit 1
