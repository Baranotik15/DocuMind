#!/bin/bash
# Check PR merge status and detect conflicts
#
# Usage: .claude/hooks/check-pr-status.sh <PR_NUMBER>
#
# Returns structured status including:
# - Merge conflicts (CONFLICTING vs MERGEABLE)
# - Branch status (DIRTY vs CLEAN)
# - Conflicted files if applicable
#
# Exit codes:
#   0 - Clean, ready to proceed
#   1 - Has merge conflicts
#   2 - Status unknown (GitHub still calculating)

set -e

PR_NUMBER=$1

if [ -z "$PR_NUMBER" ]; then
    # Try to detect PR from current branch
    PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || echo "")
fi

if [ -z "$PR_NUMBER" ]; then
    echo "## Merge Status"
    echo "⚠️ No PR specified and couldn't detect from current branch"
    echo ""
    echo "Usage: check-pr-status.sh <PR_NUMBER>"
    exit 0
fi

# Get merge status from GitHub
MERGE_DATA=$(gh pr view "$PR_NUMBER" --json mergeable,headRefName,baseRefName 2>/dev/null || echo "{}")

if [ "$MERGE_DATA" = "{}" ]; then
    echo "## Merge Status"
    echo "❌ Could not fetch PR #$PR_NUMBER"
    exit 0
fi

MERGEABLE=$(echo "$MERGE_DATA" | jq -r '.mergeable')
HEAD_BRANCH=$(echo "$MERGE_DATA" | jq -r '.headRefName')
BASE_BRANCH=$(echo "$MERGE_DATA" | jq -r '.baseRefName')

# Output structured status
echo "## Merge Status"

case "$MERGEABLE" in
    "MERGEABLE")
        echo "✅ MERGEABLE - No conflicts detected"
        echo "Branch: $HEAD_BRANCH"
        echo "Base: $BASE_BRANCH"
        echo ""
        exit 0
        ;;
    "CONFLICTING")
        echo "⚠️ CONFLICTING - Has merge conflicts with $BASE_BRANCH"
        echo "Branch: $HEAD_BRANCH"
        echo "Base: $BASE_BRANCH"
        echo ""
        echo "### Conflicted Files"

        # Try to detect conflicted files locally if on the PR branch
        CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
        if [ "$CURRENT_BRANCH" = "$HEAD_BRANCH" ]; then
            # Fetch base branch
            git fetch origin "$BASE_BRANCH" 2>/dev/null || true

            # Check for conflicts
            CONFLICTS=$(git diff "origin/$BASE_BRANCH"..."$HEAD_BRANCH" --name-only --diff-filter=U 2>/dev/null || echo "")

            if [ -n "$CONFLICTS" ]; then
                echo "$CONFLICTS" | while IFS= read -r file; do
                    echo "- $file"
                done
            else
                echo "(Run 'git fetch origin $BASE_BRANCH && git rebase origin/$BASE_BRANCH' to see conflicts)"
            fi
        else
            echo "(Checkout branch '$HEAD_BRANCH' to see specific files)"
        fi

        echo ""
        echo "### Resolution Steps"
        echo "1. Checkout branch: git checkout $HEAD_BRANCH"
        echo "2. Fetch base: git fetch origin $BASE_BRANCH"
        echo "3. Rebase: git rebase origin/$BASE_BRANCH"
        echo "4. Resolve conflicts in each file"
        echo "5. Stage resolved files: git add <files>"
        echo "6. Continue rebase: git rebase --continue"
        echo "7. Push: git push --force-with-lease"
        echo ""
        exit 1
        ;;
    "UNKNOWN")
        echo "⏳ UNKNOWN - GitHub is still calculating merge status"
        echo "Branch: $HEAD_BRANCH"
        echo "Base: $BASE_BRANCH"
        echo ""
        echo "Try again in a few seconds, or proceed with CI fixes."
        echo ""
        exit 2
        ;;
    *)
        echo "❓ $MERGEABLE - Unexpected merge status"
        echo "Branch: $HEAD_BRANCH"
        echo "Base: $BASE_BRANCH"
        echo ""
        exit 0
        ;;
esac
