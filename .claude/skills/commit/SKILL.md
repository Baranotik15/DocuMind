---
name: commit
description: Review and commit changes with automated validation
tools: Bash, Read, Grep, TodoWrite

---

# /commit - Review and Commit Changes

Reviews code changes and commits all changes with automated validation via hooks.

## What it does:

1. **Reviews Changes** - Analyzes all staged/unstaged changes
2. **Commits** - Creates commit with proper message format
3. **Hook Validation** - Runs the checks configured in `ci-full.sh` automatically
   - Linting, formatting, type checking
   - Runs BEFORE commit via PreToolUse hook
   - Deterministic - Claude cannot skip these checks

## Usage:

```
/commit
```

## IMPORTANT - How This Command Works:

When the user types `/commit`, you (the AI agent) MUST:

1. **Check for changes:**
   ```bash
   git status
   git diff --name-only
   ```

2. **Review the changes** and identify any obvious issues

3. **Stage modified files explicitly:**
   ```bash
   # Stage each modified file individually (DO NOT use git add -A)
   git add <modified-file-path>
   git add <another-modified-file-path>

   # Review staged changes before committing
   git diff --staged
   ```

4. **Commit with descriptive message:**
   - Generate conventional commit message
   - Create the commit
   - **PreToolUse hook runs BEFORE git commit executes**
   - Hook validates staged changes (linting, formatting, type-checking)
   - If hook passes, commit proceeds

## What happens:

### Step 1: Review Changes
- Check for obvious issues in the diff
- Identify any remaining problems
- No manual linting/formatting needed (hooks handle this)

### Step 2: Stage Files
- Stage specific modified files (NOT `git add -A`)
- Review staged changes with `git diff --staged`

### Step 3: Commit with Hook Validation
- Generates descriptive commit message in format: `type(scope): description`
- **PreToolUse hook runs automatically BEFORE commit:**
  - Runs `.claude/hooks/ci-full.sh` on staged changes
  - Validates linting, formatting, type-checking
  - Fast feedback (⚡ 20-60s)
  - Blocks commit if validation fails
  - **Deterministic** - Claude cannot skip these checks
- If hook passes, creates commit

### Hook Architecture

This skill uses **Claude Code PreToolUse hooks** for deterministic validation:

- Runs `.claude/hooks/ci-full.sh` BEFORE `git commit` executes
- Provides immediate feedback in the conversation
- Shows validation output to user
- Blocks commit on failure
- **Cannot be bypassed** - hooks are enforced by Claude Code

## Example Flow:

```bash
/commit

🔍 Checking for changes...
Found 3 modified files:
  - src/services/user_service.*
  - src/api/users.*
  - web/components/UserCard.*

📦 Staging modified files...
git add src/services/user_service.*
git add src/api/users.*
git add web/components/UserCard.*

🔎 Reviewing staged changes...
git diff --staged

📝 Generated commit message:
feat(users): add user profile settings endpoint

- Add new endpoint for user settings
- Update UserCard component with settings button

🔧 Running validation hook (ci-full.sh)...
✅ Format check: passed
✅ Lint: passed
✅ Type check: passed

✅ Commit created
```

**If hook fails:**

```bash
🔧 Running validation hook (ci-full.sh)...
❌ Lint: 2 errors found
  - src/services/user_service.*:42: Unused import
  - src/api/users.*:15: Line too long

❌ Commit blocked by validation hook

Fix the issues above and try again.
```

## Commit Message Format:

**Format:** `[TICKET] type(scope): description`

**Ticket prefix (optional):** When a ticket number is available, prefix the commit message. Check these sources in order:
1. **Branch name** — if it starts with an issue-tracker key (e.g. `ABC-123`, case-insensitive), use that. Example: branch `ABC-1917-some-feature` → prefix `ABC-1917`.
2. **Conversation context** — if the user mentioned a ticket (e.g., "working on ABC-1234", plan references ABC-1234, spec filename contains ABC-1234), use that.
3. **No ticket found** — omit the prefix and use just `type(scope): description`.

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `style` - Formatting
- `refactor` - Code restructuring
- `test` - Tests
- `chore` - Maintenance

**Examples:**
```
ABC-1234 feat(api): add user profile settings endpoint
ABC-5678 fix(security): address SQL injection vulnerability
ABC-9012 refactor(core): extract validation helpers
```

## Next Steps:

After `/commit`, run:
```
/push
```

This will:
- Run comprehensive checks via pre-push hook (🧪 tests + builds, ~1-5 min)
- Push to remote
- Create GitHub PR

**Or use watch mode:**
```
/push --watch
```

This will additionally:
- Automatically fix CI failures and review comments
- Iterate up to 3 times until issues resolved

**Why separate commit and push?**
- Commit is FAST (⚡ 20-60s) - just linting/type checking
- Push is COMPREHENSIVE (🧪 1-5 min) - includes full test suite
- Fail fast on obvious issues, catch deep issues before push

## Workflow:

```
/work ABC-1234: Add feature
  ↓ (Implementation)

/commit
  ↓ (PreToolUse hook: ⚡ fast validation 20-60s)
  ↓ (Commit created)
  ↓ (Git pre-commit hook: backup validation)

/push [--watch]
  ↓ (Pre-push hook: 🧪 comprehensive tests 1-5 min)
  ↓ (Push to remote)
  ↓ (Create PR)
  ↓ (Optional: watch mode fixes issues automatically)
  ↓
✅ Ready for team review
```

## Troubleshooting:

**No changes to commit:**
```
Make sure you have uncommitted changes:
git status
```

**Commit message rejected:**
```
Use format: type(scope): description
Example: feat(api): add user settings
```

**Hook validation fails:**
```
1. Review the hook output for specific errors
2. Fix the issues in your code
3. Re-stage the fixed files: git add <file>
4. Try /commit again
```

**Hook seems stuck:**
```
Check if hook script exists and is executable:
ls -la .claude/hooks/ci-full.sh
chmod +x .claude/hooks/ci-full.sh
```

## Safety Features:

1. **Deterministic hooks** - PreToolUse hooks cannot be bypassed by Claude
2. **Fast validation** - Comprehensive checks in 20-60s
3. **Clear feedback** - Shows validation results in conversation
4. **Blocks on failure** - Won't commit if validation fails
5. **Proper format** - Enforces commit message conventions

---

**Related Commands:**
- `/work` - Implement feature
- `/push` - Validate, push, and create PR (use `--watch` for auto-fix)
