---
name: push
description: Push and create PR with optional watch mode
tools: Bash, Read, Grep, Skill, TodoWrite
---

# /push - Push and Create PR

Pushes committed changes to remote and creates a GitHub Pull Request with AI-generated description. Optionally enters watch mode to automatically fix CI failures and review comments.

## What it does:

1. **Validates** - Runs pre-push hook with comprehensive checks (~1-5 min)
   - All linting, formatting, type checking
   - Unit tests with coverage
   - Application builds
   - Compilation
2. **Pushes** to remote branch
3. **Generates comprehensive PR description** using LLM
4. **Creates** GitHub Pull Request
5. **Watch Mode (optional)** - Automatically fixes CI failures and review comments until resolved or max iterations

## Usage:

```bash
/push              # Standard: validate, push, create PR, exit
/push --watch      # Watch mode: validate, push, create PR, then auto-fix issues until resolved (max 3 iterations)
```

## Prerequisites:

You must have committed changes first. Use `/commit` to review and commit.

## IMPORTANT - How This Command Works:

When the user types `/push`, you (the AI agent) MUST:

1. **Check current branch:**
   ```bash
   git branch --show-current
   ```
   - Exit with error if on main/master

2. **Check if PR already exists:**
   ```bash
   gh pr view --json url 2>/dev/null
   ```
   - If PR exists, just push and exit (no need to generate description)

3. **Push to remote:**
   ```bash
   git push -u origin $(git branch --show-current)
   ```
   - **PreToolUse hook runs BEFORE push:**
     - Runs `.claude/hooks/ci-full.sh` on all changes
     - Comprehensive validation (~1-5 min)
     - Includes tests, builds, type-checking
     - Blocks push if validation fails

4. **If no PR exists, analyze changes** to generate PR title and body:
   - All commits on branch: `git log origin/main..HEAD --pretty=format:"%s%n%b"`
   - Changed files: `git diff --name-only origin/main..HEAD`
   - Actual changes: `git diff origin/main..HEAD`
   - Branch name for context (Jira ticket, feature name)

5. **Generate PR title and body** (hold in memory, don't write to files)

   **PR Body Format:**
   ```markdown
   ## Summary
   - High-level bullet points of what changed
   - Key fixes or features added
   - Impact on the system

   ## Root Cause (for bug fixes)
   Explain what was broken and why

   ## Changes
   Detailed description of modifications made

   ## Testing
   ✅ What was tested and verified

   ## Impact
   - ✅ Benefits and improvements
   - ✅ What this enables

   ## Verification Steps (if applicable)
   Steps to verify the changes work in production
   ```

6. **Create PR directly with gh CLI:**
   ```bash
   gh pr create --title "YOUR_GENERATED_TITLE" --body "YOUR_GENERATED_BODY"
   ```

   - Pass title and body directly as arguments
   - No temp files needed

### Step 6: Watch Mode (Optional)

If `--watch` flag was provided, enter watch mode after PR creation:

1. **Get PR number:**
   ```bash
   # From gh pr create output or:
   gh pr view --json number -q '.number'
   ```

2. **CRITICAL: Wait for CI and automated reviewers before checking status:**

   **Why this is necessary:**
   - GitHub Actions workflows take time to start (5-15 seconds)
   - Automated reviewers need time to analyze and post comments (15-30 seconds)
   - If we check too early, hooks will report "all good" when CI/comments are still incoming

   **Waiting strategy:**
   ```bash
   echo "⏳ Waiting for GitHub Actions workflows to start..."

   # Wait up to 60 seconds for at least one workflow to start
   WAITED=0
   MAX_WAIT=60
   while [ $WAITED -lt $MAX_WAIT ]; do
       # Check if any workflows have started
       WORKFLOW_STATUS=$(gh run list --branch $(git branch --show-current) --limit 1 --json status --jq '.[0].status' 2>/dev/null || echo "")

       if [ -n "$WORKFLOW_STATUS" ]; then
           echo "✅ Workflow started (status: $WORKFLOW_STATUS)"
           break
       fi

       sleep 5
       WAITED=$((WAITED + 5))
       echo "   Still waiting... (${WAITED}s / ${MAX_WAIT}s)"
   done

   if [ $WAITED -ge $MAX_WAIT ]; then
       echo "⚠️ No workflows detected after ${MAX_WAIT}s - proceeding anyway"
   fi

   # Additional wait for automated reviewers to post comments
   echo "⏳ Waiting for automated reviewers..."
   sleep 30

   echo "✅ Ready to check PR status"
   ```

3. **Invoke fix-pr with watch mode:**
   ```bash
   # This invokes the fix-pr skill
   /fix-pr <PR_NUMBER> watch
   ```

3. **fix-pr handles iteration:**
   - Gathers CI failures and review comments (via Start hooks)
   - Fixes issues iteratively
   - Commits and pushes after each fix
   - Watches CI with `gh run watch`
   - Loops up to 3 times or until all issues resolved
   - Exits with summary

**Watch Mode Flow:**
```
/push --watch
  ↓
[Standard push flow: validate, push, create PR]
  ↓
⏳ WAIT for workflows to start (up to 60s)
  ↓
⏳ WAIT for automated reviewers (30s)
  ↓
Invoke: /fix-pr <PR> watch
  ↓
fix-pr Phase 1: Gather info (Start hooks)
  ↓
fix-pr Phase 2: Categorize & prioritize
  ↓
fix-pr Phase 3: Fix iteratively
  ↓
fix-pr Phase 4: Commit & push
  ↓
fix-pr Phase 5: Watch CI with gh run watch
  ↓ (Iteration 1)
CI fails? → Parse failures → Fix → Commit → Push → Watch again
  ↓ (Iteration 2)
CI fails? → Parse failures → Fix → Commit → Push → Watch again
  ↓ (Iteration 3)
CI fails? → Parse failures → Fix → Commit → Push → Watch again
  ↓
Max iterations reached or CI passes
  ↓
Done
```

## What happens:

### Step 1: Validate Branch
- **Requires** you're on a feature branch (not main/master)
- Exits with error if on main/master

### Step 2: Check for Existing PR
- If PR already exists, skip to push only
- No need to regenerate description for existing PRs

### Step 3: Pre-Push Hook (Comprehensive Checks)
- 🧪 Runs automatically before push (~1-5 min depending on changes)
- **PreToolUse hook runs `.claude/hooks/ci-full.sh` BEFORE `git push`**
- Runs the checks configured for your stack, scoped to what changed. Typically:
  - Formatting + linting
  - Type checking
  - Tests (with coverage, if configured)
  - Build / compilation
  - (Adapt the exact commands per component in `ci-full.sh`.)

### Step 4: Push to Remote
- If all checks pass, pushes to remote branch
- If checks fail, fix issues and try again

### Step 5: Generate PR (if new)
- LLM analyzes all commits and changes
- Generates concise PR title summarizing all changes
- Generates comprehensive, structured PR body
- Runs `gh pr create` with title and body as arguments
- Links to the issue tracker ticket (if in branch name)

### Step 6: Watch Mode (if --watch flag)
- Automatically invokes `/fix-pr <PR> watch`
- fix-pr monitors CI, fixes failures, commits, pushes
- Iterates up to 3 times until issues resolved
- See `/fix-pr` skill documentation for details

## Example Flow:

```
/push

🚀 Validating branch...
Current branch: feature/ABC-1234-fix-log-ingestion
✅ On feature branch (not main/master)

🔍 Checking for existing PR...
No existing PR found

🔧 Running pre-push hook (ci-full.sh)...
✅ Lint: passed
✅ Type check: passed
✅ Tests: 42 tests passed
[1-5 min of comprehensive checks]

🚀 Pushing to remote...
✅ Pushed to origin/feature/ABC-1234-fix-log-ingestion

📝 Analyzing changes for PR...
- Found 2 commits
- Changed 3 files

📝 Creating GitHub PR...

gh pr create --title "fix(logging): fix log ingestion for latency metrics" --body "## Summary
- Fixes log ingestion failures for latency metrics
..."

✅ Pull Request created
PR URL: https://github.com/org/repo/pull/123
```

**With watch mode:**

```
/push --watch

[... standard push flow ...]

✅ Pull Request created
PR URL: https://github.com/org/repo/pull/123

🔧 Entering watch mode...
Invoking: /fix-pr 123 watch

[fix-pr takes over, monitors CI, fixes issues, iterates]
```

**If PR already exists:**

```
/push

🚀 Validating branch...
Current branch: feature/ABC-1234-fix-log-ingestion
✅ On feature branch (not main/master)

🔍 Checking for existing PR...
✅ PR already exists: https://github.com/org/repo/pull/123

🔧 Running pre-push hook (ci-full.sh)...
✅ All checks passed

🚀 Pushing to remote...
✅ Pushed to origin/feature/ABC-1234-fix-log-ingestion

Done! PR updated with new commits.
```

## Complete Workflow:

```
/work ABC-1234: Add user settings
  ↓ (Implementation)

/commit
  ↓ (PreToolUse hook: ⚡ 20-60s)
  ↓ (Commit created)

/push [--watch]
  ↓ (PreToolUse hook: 🧪 1-5 min)
  ↓ (Push to remote)
  ↓ (If new: LLM generates title/body → gh pr create)
  ↓ (If --watch: invoke /fix-pr <PR> watch)
  ↓
✅ Ready for team review
```

## Safety Features:

1. **Deterministic hooks** - PreToolUse hooks cannot be bypassed by Claude
   - ⚡ Pre-commit was fast (20-60s) - just linting/type checking
   - 🧪 Pre-push is thorough (1-5 min) - includes full test suite
   - Catches issues before they reach CI
2. **Requires feature branch** - Blocks pushes to main/master
3. **No force push** - Safe by default
4. **Comprehensive PR descriptions** - LLM-generated context for reviewers
5. **Watch mode** - Optionally auto-fixes CI failures and review comments
6. **Migration safety checks** - For PRs with SQL migrations (see below)

---

## Migration Safety (for PRs with SQL changes)

**Before pushing**, check if PR contains SQL migrations:

```bash
git diff --name-only origin/main..HEAD | grep -E '\.sql$'
```

### If migrations detected:

1. **Check for breaking changes:**
   - `DROP TABLE/COLUMN/SCHEMA`
   - `RENAME TABLE/COLUMN/SCHEMA`
   - `ALTER COLUMN` type changes
   - Constraints that may fail on existing data

2. **Breaking changes require an expand-contract pattern:**

   - Phase 1 (expand): Create a compatibility layer (views, aliases, nullable columns)
   - Phase 2: Deploy app changes (both old and new code work)
   - Phase 3 (contract): Complete cutover once nothing reads the old shape

3. **Generate Go/No-Go checklist:**

```markdown
## Migration Safety Checklist

### Pre-Deploy
- [ ] Migration tested in staging
- [ ] Rollback procedure documented
- [ ] Backup taken before migration
- [ ] Estimated runtime calculated

### During Deploy
- [ ] Application pods can handle mixed state
- [ ] No long-running transactions blocked
- [ ] Monitoring in place for errors

### Post-Deploy
- [ ] Verify data integrity queries
- [ ] Application logs show no errors
- [ ] Performance metrics stable
- [ ] Rollback window defined (24h recommended)

### Breaking Change Verification (if applicable)
- [ ] Phase 1 (expand) migration created
- [ ] Phase 3 `.sql.future` file created
- [ ] Comments explain when to run Phase 3
```

4. **Require user confirmation for breaking changes:**

   Ask user: "This PR contains breaking database changes. Have you followed the expand-contract pattern?"

### Add to PR description:

```markdown
## Database Migration

**Risk Level:** [LOW | MEDIUM | HIGH | CRITICAL]

**Breaking Changes:** [Yes/No]
- [List any breaking changes]

**Expand-Contract Pattern:** [Required/Not Required]
- Phase 1: [migration file or N/A]
- Phase 3: [.sql.future file or N/A]

**Rollback Procedure:**
[Steps to rollback if needed]
```

## Troubleshooting:

**No commits to push:**
```bash
Make sure you've committed your changes:
/commit
```

**Pre-push checks failed:**
```bash
# Fix the failing tests/linting
# Then commit and push again:
git add <specific-files>
git commit -m "fix: address test failures"
/push
```

**Push rejected (by remote):**
```bash
# Pull latest changes first
git pull origin feature/your-branch

# Then push again
/push
```

**Pre-push checks too slow?**
```bash
# Hooks are enforced by Claude Code and cannot be skipped
# If checks are failing, fix the issues rather than trying to bypass
```

**PR creation fails:**
```bash
# Create PR manually at GitHub
# Or check gh CLI is installed: brew install gh
```

**Watch mode didn't fix issues:**
If watch mode exits after 3 iterations without resolving all issues:

1. Review the failure logs from the last iteration
2. Run `/fix-pr <PR>` manually to attempt additional fixes
3. Or fix issues manually and push again

## Related Commands:

- `/work` - Implement feature
- `/commit` - Review and commit changes
- `/fix-pr [PR] [watch]` - Fix CI failures and review comments
