---
name: fix-pr
description: Fix all PR blockers - CI failures and review comments. Use when a PR has failing checks or unresolved review feedback. Replaces /address-pr-comments.
tools: Read, Grep, Glob, Bash, Edit, Write, Task, TodoWrite, AskUserQuestion
model: opus
permissionMode: bypassPermissions
skills:
  - anti-patterns
  - testing
hooks:
  Start:
    - hooks:
        - type: command
          command: ".claude/hooks/check-pr-status.sh"
        - type: command
          command: ".claude/hooks/get-pr-ci-failures.sh"
        - type: command
          command: ".claude/hooks/get-pr-review-comments.sh"
  Stop:
    - hooks:
        - type: command
          command: ".claude/hooks/ci-full.sh"
---

# /fix-pr - Fix All PR Blockers

Fix CI failures and address PR review comments in a single command.

**Usage:**
```bash
/fix-pr                # Auto-detect PR from current branch, fix once and push
/fix-pr [PR]           # Fix specific PR number
/fix-pr watch          # Auto-detect, fix, push, then watch CI and loop if failures
/fix-pr [PR] watch     # Fix specific PR, push, then watch CI and loop if failures
```

**PR Detection:**
- If no PR number provided, automatically detects PR from current git branch
- Uses `gh pr view` to find PR associated with current branch
- Fails gracefully if branch has no PR (suggests creating one first)

**Core Principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

---

## Phase 1: Gather Information

**All information is automatically gathered by Start hooks before the skill begins.**

### How Auto-Detection Works

When `/fix-pr` is invoked without a PR number:
1. Hooks use `gh pr view` to detect PR from current git branch
2. If no PR exists for current branch, hooks report this gracefully
3. If PR exists, hooks gather complete status information

When `/fix-pr [PR]` is invoked with a specific PR number:
1. User provides PR number as argument to skill
2. Skill passes PR number to each hook as first argument
3. Hooks use the provided PR number instead of auto-detecting

### Start Hooks (Run Automatically)

The following hooks run before the skill begins:

1. **`.claude/hooks/check-pr-status.sh`** - Merge conflict detection
2. **`.claude/hooks/get-pr-ci-failures.sh`** - CI failure parsing
3. **`.claude/hooks/get-pr-review-comments.sh`** - Review comment extraction

Each hook:
- ✅ Auto-detects PR from current branch if no argument provided
- ✅ Accepts PR number as first argument (`./hook.sh 1234`)
- ✅ Returns structured markdown output
- ✅ Uses exit codes (0=success/no issues, 1=has issues, 2=error)

### Hook Output Summary

You will receive structured output from each hook:

#### Merge Status (`check-pr-status.sh`)

**Clean:**
```text
## Merge Status
✅ MERGEABLE - No conflicts detected
Branch: feature-branch
Base: main
```

**Conflicting:**
```text
## Merge Status
⚠️ CONFLICTING - Has merge conflicts with main
Branch: feature-branch
Base: main

### Conflicted Files
- src/api/auth.*
- src/models/user.*

### Resolution Steps
[step-by-step instructions]
```

**Action:** If `CONFLICTING`, resolve conflicts before proceeding (see Troubleshooting).

#### CI Failures (`get-pr-ci-failures.sh`)

**Passing:**
```text
## CI Status
✅ All checks passing

Total checks: 8
```

**Failing:**
```text
## CI Status
❌ 1 check(s) failing

### Failed Checks
- test (CI)

### Failure Details

#### CI (Run #20421548691)

## Test Suite
- ERROR tests/integration/services/test_site_service.py::TestSiteLookupByExternalId::test_get_site_by_external_id_respects_client - AttributeError: LITE
- FAILED tests/integration/api/test_admin.py::TestUpdatePlan::test_update_plan_success - assert 400 == 200
```

#### Review Comments (`get-pr-review-comments.sh`)

**No comments:**
```text
## Review Comments
✅ All review threads resolved

Total threads: 3 (all resolved)
```

**Has comments:**
```text
## Review Comments
📝 3 unresolved review thread(s)
🤖 1 background agent comment(s)

### 🔴 Critical Issues (2)
- src/jobs/equivalence_job.*:160 by @reviewer
- migrations/0007_remove_legacy_feature_flags.sql:22 by @reviewer

### 🟠 Major Issues (1)
- src/services/agent/squad_generator.*:20 by @reviewer

### Thread Details

#### src/jobs/equivalence_job.*:160

**Author:** @reviewer

**Comment preview:**
_⚠️ Potential issue_ | _🔴 Critical_
...

### 🤖 Background Agent Comments (1)

#### Comment (2025-01-15T10:30:00Z)

**URL:** https://github.com/org/repo/pull/123#issuecomment-456

[full comment body from the automation/review bot]

---
```

### Parse Hook Output

Use the structured hook output to understand:
- Whether conflicts need resolution first
- Which CI checks are failing and why
- Which review comments need addressing
- Whether the automation/review bot (configurable via the `PR_AGENT_LOGIN` env var used by `get-pr-review-comments.sh`) has posted feedback (shown in "Background Agent Comments" section)

**No manual commands needed** - all data is pre-gathered.

---

## Phase 2: Critically Analyze Review Comments

**Before implementing any review feedback, analyze each comment for validity.**

### Analysis Process

For each review comment from `.claude/hooks/get-pr-review-comments.sh` (including inline review threads AND the automation/review bot's PR comments):

1. **Read the complete comment** without reacting
2. **Read the affected code** to understand current implementation
3. **Categorize the feedback** into one of three buckets:

#### Category 1: Legitimate Bugs (Must Fix)

Comments that identify actual defects:
- Null pointer / undefined errors
- Logic errors causing incorrect behavior
- Security vulnerabilities
- Data loss or corruption risks
- Missing error handling for real failure cases
- Race conditions or concurrency bugs
- API contract violations

**Action:** Auto-fix without asking (document in commit)

#### Category 2: Nice to Haves (Evaluate)

Suggestions that may improve code quality:
- Code organization / readability improvements
- Additional test coverage (not critical gaps)
- Performance optimizations (non-critical)
- Type safety improvements
- Better error messages
- Documentation additions
- Simplified logic (without changing behavior)

**Action:** Evaluate merit on case-by-case basis:
- **Implement if:** Low effort, clear benefit, aligns with codebase patterns
- **Skip if:** Out of scope, adds complexity, contradicts intentional design
- **Ask if:** Uncertain about trade-offs or scope creep

#### Category 3: Ignore (Explain Why)

Comments that are technically incorrect or inappropriate:
- **False positives** - Reviewer misunderstood the code
- **Out of scope** - Feature requests unrelated to PR purpose
- **Premature optimization** - YAGNI violations
- **Architectural mismatches** - Contradicts intentional design decisions
- **Context-unaware** - Doesn't account for surrounding system constraints
- **Already handled** - Edge case is actually covered elsewhere

**Action:** Document reason for declining, do not implement

### Output Format

After analysis, create a summary:

```markdown
## Review Comment Analysis

### Legitimate Bugs (X comments) - Will Fix
- [file:line] - [brief description of bug]
- [file:line] - [brief description of bug]

### Nice to Haves (X comments) - Evaluating
**Implementing:**
- [file:line] - [why this is worth doing]

**Skipping:**
- [file:line] - [why this is out of scope / low value]

### Ignoring (X comments) - Technically Incorrect
- [file:line] - [why this is wrong / not applicable]
  **Reasoning:** [specific technical explanation]
```

### Reasoning Guidelines

When declining feedback:
- **Be specific** - Reference actual code, not general principles
- **Be factual** - State what the code does, not opinions
- **Be brief** - 1-2 sentences explaining the technical reason
- **Avoid social fluff** - No "I appreciate the feedback" or "great point"

**Good example:**
> Ignoring suggestion to add null check for `user.email`. The `User` model enforces `email` as non-nullable at the database level (see `migrations/0002_add_users.sql:12`), and the ORM validates this on insert.

**Bad example:**
> Thanks for the suggestion! I appreciate you taking the time to review. However, I think we're okay without the null check here.

---

## Phase 3: Categorize & Prioritize

Use TodoWrite to create prioritized list based on analysis from Phase 2.

### Priority Order

1. **CI Failures** (blocking merge)
   - Test failures
   - Lint/type errors
   - Build failures
2. **Legitimate Bugs** (from Phase 2 analysis)
3. **Nice to Haves** flagged for implementation (from Phase 2 analysis)
4. **Simple fixes** (typos, style)

### Categorization Rules

- CI failures always come first (they block merge)
- Within CI failures: test failures > type errors > lint errors
- Legitimate bugs from Phase 2 come next
- Nice to haves flagged for implementation follow
- Ignored comments are documented but not tracked as todos

### Create Todo List

Use TodoWrite to track each item with priority:

```text
- [ ] CI: [check_name] - [error summary]
- [ ] Bug: [file:line] - [summary from Phase 2 analysis]
- [ ] Nice-to-have: [file:line] - [summary from Phase 2 analysis]
- [ ] Simple: [file:line] - [summary]
```

---

## Phase 4: Fix Iteratively

For each item in priority order:

### For CI Failures

1. Parse the failure log to identify:
   - File and line number
   - Error message
   - Test name (if test failure)
2. Read the relevant code
3. Identify root cause
4. Apply fix
5. Run local verification:
   ```bash
   # Test failure
   <run the single failing test>

   # Type error
   <run the type checker on the file>

   # Lint error
   <run the linter on the file>

   # Compile / build error
   <run the build/compile>
   ```
6. Mark as complete in TodoWrite

### For Review Comments

Review comments have already been analyzed in Phase 2 and categorized:
- **Legitimate bugs** - tracked in todo list, implement directly
- **Nice to haves** - tracked only if flagged for implementation in Phase 2
- **Ignored comments** - already documented with reasoning, skip

Implementation should be straightforward since evaluation already happened.

### Response Pattern

Replies are posted in Phase 7 (one reply per comment, on its own thread). The reasoning you reply with comes from this analysis:

**DO:** State factually, with the logic
- "Fixed in <sha> — null check was missing, added validation"
- "Edge case now handled in <sha>"

**DON'T:** Performative praise
- "Great suggestion!"
- "You're absolutely right!"
- "Thanks for catching that!"

For declined comments (from Phase 2 "Ignore" category):
- Reuse the reasoning from Phase 2 analysis
- Be specific and factual
- Example: "Keeping current approach - `email` field is non-nullable at DB level (see migration 0002)"

---

## Phase 5: Commit & Push

**At the very end, delegate committing and pushing to the dedicated skills — do not run raw `git` commands here.**

1. **Invoke the `commit` skill** to stage, validate, and commit the fixes. It runs the pre-commit hooks (the checks configured in `ci-full.sh`) and stages only the specific files you changed. Give it commit context describing what was addressed:

   ```text
   CI Fixes:
   - [list of CI failures fixed]

   Review Feedback (Implemented):
   - [list of legitimate bugs fixed]
   - [list of nice-to-haves implemented]

   Review Feedback (Declined):
   - [list of ignored comments with brief reason]
   ```

2. **Then invoke the `push` skill (plain, no watch mode)** to push the branch and update the PR.

**Do NOT pass watch mode to `/push`.** `/push --watch` re-invokes `/fix-pr <PR> watch`, which would re-enter this skill and loop indefinitely. CI watching is owned solely by Phase 6 below — when `/fix-pr watch` is active, Phase 6 runs the bounded (max 3 iterations) watch loop after this phase completes.

**Why delegate:** `/commit` and `/push` own the validation gates and PR conventions. Reimplementing `git add`/`commit`/`push` here would bypass those hooks and drift out of sync with the canonical workflow.

---

## Phase 6: Watch Mode (if `watch` arg provided)

If the user invoked `/fix-pr watch`, enter watch mode after pushing.

### Watch Mode Loop

```bash
# Watch the workflow run until completion
gh run watch

# If run fails:
# 1. Get new failure logs
.claude/hooks/get-pr-ci-failures.sh

# 2. Check for new review comments (including inline threads)
.claude/hooks/get-pr-review-comments.sh

# 3. Loop back to Phase 2 (Categorize & Prioritize)
```

### Watch Mode Flow

1. Push changes
2. Run `gh run watch` to monitor CI
3. If CI passes → Done, exit with success summary
4. If CI fails:
   - Parse new failures (via `get-pr-ci-failures.sh` hook)
   - Check for new review comments (via `get-pr-review-comments.sh` hook)
   - Re-run Phase 2 analysis for new comments
   - Fix new issues
   - Commit & push via Phase 5 (the `commit` then `push` skills)
   - Return to step 2 (watch again)
5. Maximum 3 iterations to prevent infinite loops

---

## Phase 7: Reply to Each Comment

**CRITICAL: DO NOT submit reviews, request reviews, or open review flows.**

After pushing fixes, **reply to each comment individually**, carrying the reasoning from your Phase 2 analysis. Prefer one focused reply per comment over a single lumped summary — it lets each reviewer see exactly how their specific point was handled, in context.

### How to Reply (safe mechanism)

Phase 1 surfaces **two comment types**, each needing a different endpoint. Both post immediately **without** opening a pending review or re-requesting reviewers — pick by the comment's source:

**1. Inline review-thread comments** — the `path:line` threads (reviewers, inline bot comments, from `reviewThreads`). Reply onto the thread with the **review replies** endpoint, keyed by the review comment's ID:

```bash
# List review (diff) comments to get their IDs
gh api repos/<owner>/<repo>/pulls/<PR>/comments \
  --jq '.[] | {id, path, line, author: .user.login, body: .body[0:80]}'

# Reply on the thread by review-comment ID
gh api repos/<owner>/<repo>/pulls/<PR>/comments/<COMMENT_ID>/replies \
  -f body="Fixed in <sha>: added the missing null check."
```

**2. PR conversation comments** — the "🤖 Background Agent Comments" entries (the automation/review bot posts these as top-level PR comments, from `pullRequest.comments`, not review threads). They have **no thread to reply into** — the replies endpoint above will **404** on their IDs. Respond with a new top-level comment via the **issues comments** endpoint (a PR's issue number is its PR number):

```bash
gh api repos/<owner>/<repo>/issues/<PR>/comments \
  -f body="@review-bot Fixed in <sha>: <what changed / reasoning>."
```

### What to Say (reuse Phase 2 reasoning)

One reply per comment, factual, **always carrying the logic** — not just "done":

- **Fixed (bug / nice-to-have):** state what changed and the commit sha
  - "Fixed in a1b2c3d — `user.email` can be null on legacy rows, added a guard."
- **Declined (Phase 2 "Ignore"):** give the specific technical reason
  - "Keeping current approach — `email` is non-nullable at the DB level (migration 0002) and the ORM validates on insert."
- **Implemented differently than suggested:** explain the chosen tradeoff
  - "Went with X instead of the suggested Y because Y would re-fetch on every render; X memoizes the result."

**DO:** State factually and include the reasoning.
**DON'T:** Performative praise ("Great suggestion!", "You're absolutely right!", "Thanks for catching that!").

### What NOT to Do

**NEVER:**
- Submit a review via `gh pr review --approve` or `gh pr review --comment`
- Request review via `gh pr ready` or review request APIs
- Use the GraphQL `submitPullRequestReview` (pending-review) flow
- Mark PR as ready for review if it's in draft state
- Trigger any review-related workflows

**Why the `/replies` endpoint is allowed but the above are not:** the replies endpoint posts a standalone comment onto an existing thread immediately — it does not open a pending review, submit a review, or re-request reviewers. The forbidden commands do, which spams notifications and review queues.

### Thread Resolution (Optional)

After replying, you may mark the thread resolved:

```bash
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { isResolved }
  }
}' -f threadId="<THREAD_NODE_ID>"
```

---

## Summary Output

After completion, provide:

```markdown
## PR Fixed

### Review Comment Analysis
- **Legitimate Bugs:** X identified, X fixed
- **Nice to Haves:** X identified, X implemented, X skipped
- **Ignored:** X comments (technically incorrect or out of scope)

### CI Failures Resolved (X items)
| Check | Error | Fix |
|-------|-------|-----|
| tests | test_foo failed | Fixed assertion |
| type check | Missing return type | Added type hint |

### Review Comments Implemented (X items)
**Legitimate Bugs:**
- [file:line] - [what was fixed]

**Nice to Haves:**
- [file:line] - [what was improved]

### Review Comments Declined (X items)
- [file:line] - [specific technical reason]

### Verification
- Local tests passing
- Type checks clean
- Lint clean

### Next Steps
- CI will run on push
- Check: [PR URL]
- Team members can review the commit messages for details on what was fixed
```

---

## Troubleshooting

### Can't Find PR

```bash
# Check current branch has PR
gh pr view

# List open PRs
gh pr list
```

### Merge Conflicts

**Detected via:** `.claude/hooks/check-pr-status.sh` (runs automatically at start)

**Resolution workflow:**

#### Step 1: Start Rebase

```bash
# Ensure on PR branch
git checkout <head-branch>

# Fetch latest base branch
git fetch origin <base-branch>

# Start rebase
git rebase origin/<base-branch>
```

If conflicts occur, git will pause and show conflicted files.

#### Step 2: Identify Conflicts

```bash
# List conflicted files
git status --short | grep "^UU\|^AA\|^DD"

# Or use:
git diff --name-only --diff-filter=U
```

#### Step 3: Resolve Each File

For each conflicted file:

1. **Read the file** to see conflict markers:
   ```text
   <<<<<<< HEAD (your changes)
   your code
   =======
   their code (from main)
   >>>>>>> origin/main
   ```

2. **Understand both sides:**
   - What changed in main?
   - What changed in the PR?
   - Are they independent or conflicting?

3. **Resolution strategies:**

   **Independent changes (both needed):**
   ```python
   # Keep both changes, merge them logically
   # Example: Both added different functions
   def new_function_from_pr():
       pass

   def new_function_from_main():
       pass
   ```

   **Conflicting changes (same code modified):**
   ```python
   # Prefer PR's intent, but update for main's context
   # Example: PR changed function signature, main changed implementation
   # Combine both: new signature + updated implementation
   ```

   **Deletions vs modifications:**
   - If PR deleted something main modified → usually keep PR's deletion (intended removal)
   - If main deleted something PR modified → understand why, usually keep main's deletion

4. **Remove conflict markers** - Ensure no `<<<<<<<`, `=======`, `>>>>>>>` remain

5. **Test the resolution** - Ensure code is syntactically valid

#### Step 4: Stage and Continue

```bash
# Stage resolved files
git add <resolved-file-1> <resolved-file-2> ...

# Continue rebase
git rebase --continue
```

If more conflicts exist, repeat Step 3-4.

#### Step 5: Verify and Push

```bash
# Verify branch is clean
git status

# Run quick sanity checks
<run the build/compile>
<run the type checker on the resolved files>

# Push with force-with-lease (safer than --force)
git push --force-with-lease
```

#### When to Ask for Help

Use `AskUserQuestion` if:
- **Unclear intent** - Can't determine what main or PR was trying to achieve
- **Complex business logic** - Conflicts in domain logic requiring product knowledge
- **Test failures** - Resolved conflicts but tests fail
- **Large conflicts** - More than 5 files or 100+ lines conflicted

**Example question:**
```text
The PR changed X to do Y, but main changed X to do Z. Both approaches have trade-offs:
- PR approach: [benefits/drawbacks]
- Main approach: [benefits/drawbacks]

Which should we keep?
```

### CI Still Failing

```bash
# Check what's failing
gh pr checks

# Run locally
<run the linter and type checker>
<run the test suite>
```

---

## Key `gh` Commands Reference

```bash
# Get PR checks with status
gh pr checks <PR> --json name,state,bucket,link

# Get failed checks only
gh pr checks <PR> --json name,state,bucket --jq '.[] | select(.bucket == "fail")'

# Get recent failed runs for branch
gh run list --branch <branch> --status failure --json databaseId,name -L 5

# Get ONLY failure logs
gh run view <run-id> --log-failed

# Pipe through parser for targeted errors
gh run view <run-id> --log-failed | .claude/hooks/parse-ci-failures.sh

# Get full run details
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion == "failure")'

# Watch mode - monitor workflow until completion
gh run watch

# Get latest run for branch (after push)
gh run list --branch <branch> --limit 1 --json databaseId,status,conclusion
```

---

## Handling Multi-Component PRs

If the PR touches more than one component (e.g. an API/backend and a web/frontend):

### First Component

```bash
<run the linter on the component>
<run the type checker on the component>
<run the test suite for the component>
```

### Second Component

```bash
<run the build/compile for the component>
<run the test suite for the component>
```

### Both

- Ensure the shared contract between components stays compatible (auth tokens, API schema)
- Check shared database schema
- Verify generated/shared types stay in sync

---

## Related Commands

- `/commit` - Review and commit changes
- `/push` - Push and update PR
- `/review` - Full code review mode
