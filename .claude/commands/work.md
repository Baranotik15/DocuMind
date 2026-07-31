# /work - Implement an Approved Plan

Execute an implementation plan task-by-task, following the project's development
discipline. Use this after `/write-plan` has produced a plan and it has been
reviewed.

## Usage

```bash
/work <plan-file>        # e.g. /work .claude/plans/2026-07-06-user-settings.md
/work <task description>  # for small changes that don't warrant a full plan
```

## What it does

1. Reads the plan (`.claude/plans/<feature>.md`) and the relevant spec
   (`.claude/specs/<feature>.md`), plus any skills the plan references.
2. Works one bite-sized task at a time, following **Test-Driven Development**:
   - RED: write a failing test that captures the task's acceptance criterion.
   - GREEN: write the minimum code to pass.
   - REFACTOR: clean up with tests green.
   - See `skills/test-driven-development/SKILL.md`.
3. Keeps changes scoped to the task — no unrelated edits, no speculative
   abstractions (`skills/code-simplifier/SKILL.md`).
4. Runs the project's checks locally as it goes; the commit hook
   (`.claude/hooks/ci-full.sh`) is the deterministic gate.

## Rules

- **No production code without a failing test first.**
- Follow the approved plan. If reality diverges from the plan, stop and report —
  don't silently redesign.
- When debugging, follow `skills/systematic-debugging/SKILL.md`: root-cause
  first, one hypothesis at a time.
- Match the surrounding code's conventions (`.claude/docs/codestyle.md`).

## Next steps

```bash
/commit          # review + commit (hooks validate)
/push [--watch]  # push, open PR, optionally auto-fix CI
```
