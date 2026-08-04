# Git & PR Workflow

## Commit Guidelines

**CRITICAL: Only commit files directly related to your changes**

- Use `git add <specific-file-path>` to stage only the files you modified
- **NEVER** use `git add -A` or `git add .` which adds ALL untracked files
- Review `git status` before committing to verify only intended files are staged
- Use `git diff --staged` to review what will be committed

### Example - Correct Approach
```bash
git add path/to/changed_file
git add path/to/another_changed_file
git commit -m "Add JWT debugging endpoint"
```

### Example - WRONG Approach
```bash
git add -A  # NEVER DO THIS
git commit -m "Add JWT debugging endpoint"
```

## Branching Strategy

- For new conceptually distinct features, create a new branch from
  `development` (not `main`) — `main` stays reserved as the base/production
  branch.
- "Conceptually distinct" means separate components/concerns, not separate
  files: e.g. authentication is its own branch, the backend service scaffold
  is its own branch, the frontend service scaffold is its own branch. Don't
  mix unrelated concerns into one branch just because they're worked on
  around the same time.
- `claude --worktree <name>` (see below) branches from `development` the
  same way for parallel work.

## No PII in Commits or PRs

**NEVER include PII in commit messages or PR descriptions** (names, emails, phone numbers, addresses, SSNs, payment info). Describe issues generically, even if the original prompt contained PII.

## Pull Request Process

When creating a pull request:
- Branch from `development` for new features (see Branching Strategy above)
- Use an informative branch name
- Use `/commit` which runs automated validation via hooks (fast, seconds)
  - Hooks automatically handle linting, formatting, and type-checking
  - Deterministic validation - Claude cannot bypass these checks
- Use `/push` (optionally with `--watch`) to create PR
  - Runs comprehensive checks via hooks (slower, minutes)
  - Watch mode automatically fixes CI failures and review comments
- Never commit code that fails linting, type checking, or tests

## Pre-commit Checks

Run ALL of the relevant checks before committing (adapt to your stack):
```bash
<run formatter>        # Format code
<run linter>           # Lint and auto-fix
<run type checker>     # Type check
<run test suite>       # Run tests
```

## Parallel Development with Git Worktrees

Git worktrees enable working on multiple features simultaneously without branch-switching conflicts.

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `claude --worktree <name>` | Create worktree and start session | Starting parallel work |
| Exit + "Remove worktree" | Remove worktree when prompted | After PR merged to main |
| `git worktree list` | Show all worktrees | See active workspaces |
| `git fetch origin && git rebase origin/main` | Sync with main | After other PRs merge |

### Directory Structure
```text
project/
├── .worktrees/              # All worktrees (gitignored)
│   ├── feature-1234/
│   ├── feature-5678/
│   └── bugfix-9012/
├── .claude/
└── ...                      # The rest of the repository
```

### Rebasing Between Worktrees
When a feature merges while working on another branch:
```bash
git fetch origin
git rebase origin/main
```
