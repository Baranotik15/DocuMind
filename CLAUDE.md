# Development Workflow & Discipline

> This is a reusable `.claude/` skeleton. Fill in the stack-specific placeholders
> (CI commands in `hooks/ci-full.sh`, project facts below) for your project.

## Workflow

**ALWAYS** follow this workflow for feature development:

```text
/write-spec -> /write-plan -> /review-spec -> /work -> hooks -> /commit -> /push [--watch]
```

| Phase | Command | Output |
|-------|---------|--------|
| Spec | `/write-spec` | `.claude/specs/<feature>.md` |
| Plan | `/write-plan` | `.claude/plans/<feature>.md` |
| Implement | `/work` | Code changes |
| Commit | `/commit` | Git commit (hooks validate) |
| Push | `/push [--watch]` | Pull request |
| Worktree | `claude --worktree <name>` | Isolated workspace |

Full workflow diagram: `.claude/WORKFLOW.md`.

### Before Writing Code

1. Read the spec in `.claude/specs/` (or create one with `/write-spec`).
2. Read relevant skills in `.claude/skills/` (see `SKILLS.md` index).
3. Create a plan with `/write-plan`.
4. Review the plan / spec with `/review-spec`.

## Development Discipline Skills

### When Planning Implementation
**`/write-plan`** — Break work into bite-sized tasks (2-5 min each), include exact
file paths and commands, follow the Red-Green-Refactor cycle.

### When Writing Code
**`/test-driven-development`** — RED: write a failing test. Verify RED. GREEN:
minimal code to pass. Verify GREEN. REFACTOR. **No production code without a
failing test first.**

- **Typing / contracts:** prefer explicit interface conformance checked by your
  type checker over dynamic escapes or unchecked casts. Prefer runtime invariant
  checks and explicit contracts.

### When Encountering Bugs
**`/systematic-debugging`** — Phase 1: root-cause investigation (NO fixes yet).
Phase 2: pattern analysis. Phase 3: hypothesis testing (one change at a time).
Phase 4: implementation with a failing test.

## Agent Routing by Domain

When a task is scoped to a specific domain, use the matching implementation
agent from `.claude/agents/` instead of working directly:

| Domain | Agent |
|--------|-------|
| Frontend / UI | `web-frontend` |
| Backend / API | `backend-api` (**primary stack: Python** — prefer FastAPI/Django/Flask) |
| Database / schema / migrations | `database-architect` |
| CI/CD / Docker / deployment | `devops-infrastructure` |
| Mobile (iOS/Android) | `mobile-developer` |

## Rules Are Directives

Files in `.claude/skills/` contain **DO NOT** and **ALWAYS** rules. These are not
suggestions.

**Development Discipline:**
- `skills/test-driven-development/SKILL.md`
- `skills/systematic-debugging/SKILL.md`
- `skills/write-plan/SKILL.md`
- `skills/code-simplifier/SKILL.md`

Full index: `.claude/skills/SKILLS.md`.

## Backpressure (Deterministic Gates)

Hooks run BEFORE git commands and cannot be bypassed by the agent. Configure the
exact commands for your stack in `.claude/hooks/ci-full.sh`.

**On Commit (`ci-full.sh`):** run your fast checks on staged files — formatter,
linter, type checker, and unit tests.

**On Push / in CI:** run the fuller suite — integration tests, build, and any
coverage gates. Keep the slow checks in CI; keep the commit hook fast.

The commit hook is wired in `.claude/settings.json` as a `PreToolUse` hook on
`Bash(git commit*)`.

## Key Resources

| Resource | Purpose |
|----------|---------|
| `.claude/docs/` | Reference docs (commands, testing, git, codestyle, web setup) |
| `.claude/skills/SKILLS.md` | Categorized skill index |
| `.claude/specs/` | Feature specs |
| `.claude/plans/` | Implementation plans |
| `.claude/agents/AGENTS.md` | Specialized agent index |
| `.claude/WORKFLOW.md` | Full workflow diagram |
