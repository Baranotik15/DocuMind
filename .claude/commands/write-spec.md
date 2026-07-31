# /write-spec - Write a Feature Specification

Create a concise, reviewable spec for a feature before any planning or code. The
spec is the source of truth for *what* to build and *why* — not *how*.

## Usage

```bash
/write-spec <feature description>
```

## What it does

1. Clarifies the request — asks 2-3 targeted questions only if the goal, scope,
   or acceptance criteria are genuinely ambiguous. Otherwise proceeds.
2. Writes the spec to `.claude/specs/<feature>.md`.
3. Hands off to `/write-plan` for the implementation plan.

## Spec template

Write the file with these sections:

```markdown
# <Feature Name>

## Goal
One or two sentences: the problem and the desired outcome.

## Requirements
- Concrete, testable statements of what the feature must do.

## Acceptance Criteria
- [ ] Observable conditions that mean "done" (each should map to a test).

## Non-Goals
- What we are explicitly NOT doing, to bound scope.

## Open Questions
- Anything unresolved that needs a decision before/while building.
```

## Rules

- Keep it short and unambiguous — a spec is a contract, not a design doc.
- Do **not** include implementation details (schemas, function names, libraries);
  those belong in the plan (`/write-plan`).
- If the feature touches security, data isolation, or migrations, call it out
  explicitly under Requirements.

## Next step

```bash
/write-plan <feature>
```
