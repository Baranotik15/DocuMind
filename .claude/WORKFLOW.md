# Development Workflow

```text
┌─────────────────────────────────────────────────────────────────┐
│                    SPECIFICATION PHASE                           │
├─────────────────────────────────────────────────────────────────┤
│  0. /write-spec (if new feature)                                 │
│     └── Create .claude/specs/<feature>.md                        │
│     └── Define: Goal, Requirements, Acceptance Criteria          │
│     └── Define: Non-Goals (what we're NOT doing)                 │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                    PLANNING PHASE                                │
├─────────────────────────────────────────────────────────────────┤
│  1. /write-plan <feature>                                        │
│     └── Launches RESEARCH AGENTS in parallel:                    │
│         - codebase-explorer (find existing patterns)             │
│         - best-practices-researcher (external insights)          │
│         - framework-docs-researcher (library docs)               │
│         - spec-flow-analyzer (gap detection)                     │
│     └── Applies a Simplicity Gate                                │
│     └── Generates a plan with "Considered Alternatives"          │
│                                                                  │
│  2. /review-spec — review the spec/plan before building                │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                  IMPLEMENTATION PHASE                            │
├─────────────────────────────────────────────────────────────────┤
│  3. /work <plan.md>                                              │
│     └── Follows skills/ patterns and the approved plan           │
│                                                                  │
│  4. Claude Code Hooks (DETERMINISTIC BACKPRESSURE)               │
│     └── PreToolUse hook ci-full.sh runs BEFORE `git commit`      │
│         - Validates staged changes                               │
│         - Cannot be bypassed by the agent                        │
│                                                                  │
│  5. /commit                                                      │
│     └── Reviews changes, generates a commit message             │
│     └── Hooks validate automatically                            │
│                                                                  │
│  6. /push [--watch]                                             │
│     └── Creates a PR with a summary                             │
│     └── Optional: --watch auto-fixes CI failures                │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                    LEARNING PHASE                                │
├─────────────────────────────────────────────────────────────────┤
│  After a PR merges or an issue is discovered:                    │
│  - Got it right after a correction? → create/update a skill      │
│  - Review caught over-engineering?  → note it in a skill         │
│  - Pattern proved successful?       → document it in skills/     │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Reference

| Phase | Command | Input | Output |
|-------|---------|-------|--------|
| Spec | `/write-spec` | Feature description | `.claude/specs/<feature>.md` |
| Plan | `/write-plan` | Feature or ticket | `.claude/plans/<feature>.md` |
| Implement | `/work` | Plan file | Code changes |
| Commit | `/commit` | Staged changes | Git commit (with hooks) |
| Push | `/push [--watch]` | Branch | Pull request (optional auto-fix) |
| **Worktree** | `claude --worktree <name>` | Branch/dir name | Isolated workspace in `.worktrees/` |

## Parallel Development with Worktrees

```text
Terminal 1: Feature A (urgent)
  1. claude --worktree feature/1234
     Hook creates .worktrees/feature/1234/ and starts a session there
  2. /commit
  3. /push --watch

Terminal 2: Feature B (parallel)
  1. claude --worktree feature/5678
  2. Start work immediately

After Feature A merges:
  Terminal 1: exit session, choose "Remove worktree" when prompted
  Terminal 2: git fetch origin && git rebase origin/main
```

**When to use worktrees:** parallel feature development, running `/push --watch`
while starting new work, urgent hotfixes during review, or experiments that
shouldn't touch the main workspace.

## Key Files

```text
.claude/
├── WORKFLOW.md              ← You are here
├── CLAUDE.md                ← Workflow & discipline rules (loaded each session)
├── settings.json            ← Hooks (commit gate, session end, worktrees)
├── specs/                   ← What to build (requirements)
├── plans/                   ← How to build (implementation plans)
├── skills/                  ← Reusable patterns and techniques
│   └── SKILLS.md            ← Skill index
├── agents/                  ← Specialized subagents
│   └── AGENTS.md            ← Agent index
├── commands/                ← Slash-command orchestration
├── hooks/                   ← Deterministic gate scripts (fill in ci-full.sh)
├── context/                 ← Design principles & constraints
└── docs/                    ← Reference documentation
```

## Backpressure (Deterministic Gates)

Validation runs via **Claude Code PreToolUse hooks** — deterministic and not
bypassable by the agent.

- **`ci-full.sh`** runs before `git commit`. Fill it in with your stack's
  formatter, linter, type checker, and fast tests.
- Keep the commit hook **fast**; leave slow integration tests, the full build,
  and coverage gates to CI.

If hooks fail, fix and retry — the agent cannot skip these checks.
