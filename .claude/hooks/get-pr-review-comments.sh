#!/bin/bash
# Fetch PR review comments and threads
#
# Usage: .claude/hooks/get-pr-review-comments.sh <PR_NUMBER>
#
# Returns structured review comment information including:
# - Unresolved review threads
# - Review-bot comments with severity (bots that prefix with 🔴/🟠/🟡)
# - File/line context
# - PR timeline comments from an optional automation bot (set PR_AGENT_LOGIN
#   to that bot's GitHub login to surface its latest comment; leave unset to skip)
#
# Exit codes:
#   0 - No unresolved comments
#   1 - Has unresolved comments
#   2 - PR doesn't exist

set -e

PR_NUMBER=$1
# GitHub login of an automation/review bot whose latest PR comment should be
# surfaced (e.g. a CI review bot). Leave empty to disable this behavior.
PR_AGENT_LOGIN="${PR_AGENT_LOGIN:-}"

if [ -z "$PR_NUMBER" ]; then
    # Try to detect PR from current branch
    PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || echo "")
fi

if [ -z "$PR_NUMBER" ]; then
    echo "## Review Comments"
    echo "⚠️ No PR specified and couldn't detect from current branch"
    echo ""
    exit 0
fi

# Get repo owner and name
OWNER=$(gh repo view --json owner -q .owner.login 2>/dev/null || echo "")
REPO=$(gh repo view --json name -q .name 2>/dev/null || echo "")

if [ -z "$OWNER" ] || [ -z "$REPO" ]; then
    echo "## Review Comments"
    echo "❌ Could not determine repository information"
    echo ""
    exit 2
fi

# Get review threads and PR comments via GraphQL
REVIEW_RESPONSE=$(gh api graphql -f query="
query {
  repository(owner: \"$OWNER\", name: \"$REPO\") {
    pullRequest(number: $PR_NUMBER) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          line
          comments(first: 10) {
            nodes {
              body
              author { login }
            }
          }
        }
      }
      comments(last: 100) {
        nodes {
          id
          body
          author { login }
          createdAt
          url
        }
      }
    }
  }
}" 2>/dev/null)

# Check if PR exists (pullRequest will be null if not found)
PR_EXISTS=$(echo "$REVIEW_RESPONSE" | jq -r '.data.repository.pullRequest')
if [ "$PR_EXISTS" = "null" ] || [ -z "$PR_EXISTS" ]; then
    echo "## Review Comments"
    echo "❌ PR #$PR_NUMBER not found"
    echo ""
    exit 2
fi

REVIEW_THREADS=$(echo "$REVIEW_RESPONSE" | jq '.data.repository.pullRequest.reviewThreads.nodes' 2>/dev/null || echo "[]")

# Extract only the latest PR timeline comment from the configured automation bot.
# Using last: 100 above gets recent comments; we only surface the latest agent comment
# to avoid accumulating stale feedback (unlike review threads, PR comments have no isResolved state)
if [ -n "$PR_AGENT_LOGIN" ]; then
    AGENT_COMMENTS=$(echo "$REVIEW_RESPONSE" | jq --arg login "$PR_AGENT_LOGIN" '[.data.repository.pullRequest.comments.nodes[] | select(.author.login == $login)] | if length > 0 then [last] else [] end' 2>/dev/null || echo "[]")
else
    AGENT_COMMENTS="[]"
fi
AGENT_COMMENT_COUNT=$(echo "$AGENT_COMMENTS" | jq 'length' 2>/dev/null || echo "0")

if { [ "$REVIEW_THREADS" = "[]" ] || [ "$REVIEW_THREADS" = "null" ]; } && [ "$AGENT_COMMENT_COUNT" -eq 0 ]; then
    echo "## Review Comments"
    echo "✅ No review comments found"
    echo ""
    exit 0
fi

# Count unresolved threads
UNRESOLVED_COUNT=$(echo "$REVIEW_THREADS" | jq '[.[] | select(.isResolved == false)] | length')

if [ "$UNRESOLVED_COUNT" -eq 0 ] && [ "$AGENT_COMMENT_COUNT" -eq 0 ]; then
    echo "## Review Comments"
    echo "✅ All review threads resolved"
    echo ""
    TOTAL_THREADS=$(echo "$REVIEW_THREADS" | jq 'length')
    echo "Total threads: $TOTAL_THREADS (all resolved)"
    echo ""
    exit 0
fi

echo "## Review Comments"
if [ "$UNRESOLVED_COUNT" -gt 0 ]; then
    echo "📝 $UNRESOLVED_COUNT unresolved review thread(s)"
fi
if [ "$AGENT_COMMENT_COUNT" -gt 0 ]; then
    echo "🤖 $AGENT_COMMENT_COUNT background agent comment(s)"
fi
echo ""

# Group by severity (some review bots prefix comments with severity emojis)
CRITICAL=$(echo "$REVIEW_THREADS" | jq -r '[.[] | select(.isResolved == false) | select(.comments.nodes[0].body | contains("🔴 Critical"))] | length')
MAJOR=$(echo "$REVIEW_THREADS" | jq -r '[.[] | select(.isResolved == false) | select(.comments.nodes[0].body | contains("🟠 Major"))] | length')
MINOR=$(echo "$REVIEW_THREADS" | jq -r '[.[] | select(.isResolved == false) | select(.comments.nodes[0].body | contains("🟡 Minor"))] | length')
OTHER=$((UNRESOLVED_COUNT - CRITICAL - MAJOR - MINOR))

if [ "$CRITICAL" -gt 0 ]; then
    echo "### 🔴 Critical Issues ($CRITICAL)"
    echo ""
    echo "$REVIEW_THREADS" | jq -r '.[] | select(.isResolved == false) | select(.comments.nodes[0].body | contains("🔴 Critical")) | "- \(.path):\(.line) by @\(.comments.nodes[0].author.login)"'
    echo ""
fi

if [ "$MAJOR" -gt 0 ]; then
    echo "### 🟠 Major Issues ($MAJOR)"
    echo ""
    echo "$REVIEW_THREADS" | jq -r '.[] | select(.isResolved == false) | select(.comments.nodes[0].body | contains("🟠 Major")) | "- \(.path):\(.line) by @\(.comments.nodes[0].author.login)"'
    echo ""
fi

if [ "$MINOR" -gt 0 ]; then
    echo "### 🟡 Minor Issues ($MINOR)"
    echo ""
    echo "$REVIEW_THREADS" | jq -r '.[] | select(.isResolved == false) | select(.comments.nodes[0].body | contains("🟡 Minor")) | "- \(.path):\(.line) by @\(.comments.nodes[0].author.login)"'
    echo ""
fi

if [ "$OTHER" -gt 0 ]; then
    echo "### 💬 Other Comments ($OTHER)"
    echo ""
    echo "$REVIEW_THREADS" | jq -r '.[] | select(.isResolved == false) | select(.comments.nodes[0].body | contains("🔴 Critical") | not) | select(.comments.nodes[0].body | contains("🟠 Major") | not) | select(.comments.nodes[0].body | contains("🟡 Minor") | not) | "- \(.path):\(.line) by @\(.comments.nodes[0].author.login)"'
    echo ""
fi

if [ "$UNRESOLVED_COUNT" -gt 0 ]; then
    echo "### Thread Details"
    echo ""
    echo "$REVIEW_THREADS" | jq -r '.[] | select(.isResolved == false) | "#### \(.path):\(.line)\n\n**Author:** @\(.comments.nodes[0].author.login)\n\n**Comment preview:**\n```\n\(.comments.nodes[0].body | split("\n")[0:3] | join("\n"))\n...\n```\n"'
fi

# Output automation-bot comments
if [ "$AGENT_COMMENT_COUNT" -gt 0 ]; then
    echo "### 🤖 Background Agent Comments ($AGENT_COMMENT_COUNT)"
    echo ""
    echo "$AGENT_COMMENTS" | jq -r '.[] |
      if (.body | split("\n") | length) > 10 then
        "#### Comment (\(.createdAt))\n\n**URL:** \(.url)\n\n\(.body | split("\n")[0:10] | join("\n"))\n\n... (see full comment at URL)\n\n---\n"
      else
        "#### Comment (\(.createdAt))\n\n**URL:** \(.url)\n\n\(.body)\n\n---\n"
      end'
fi

exit 1
