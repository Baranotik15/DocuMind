---
name: write-plan
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write implementation plans that guide an engineer through what to build, where, and how to verify it — without writing the code for them. The plan specifies contracts (signatures, types, integration points, test requirements) and the implementer writes the function bodies.

Assume the implementer is a skilled developer with access to the codebase but limited context on our toolset and problem domain. They can write code — they need to know *what* to build, *where* to put it, and *how to verify it works*.

**Announce at start:** "I'm using the write-plan skill to create the implementation plan."

**Context:** This should be run in a dedicated worktree (created by brainstorm skill).

**Save plans to:** `.claude/plans/YYYY-MM-DD-<feature-name>.md`

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## What Goes in a Plan vs. What Doesn't

### INCLUDE (contracts and structure):
- Exact file paths (create, modify, test)
- Function/method signatures with type annotations
- Class definitions with key attributes and relationships
- Integration points (what calls what, what imports what)
- Test cases: what to test, expected behavior, key assertions
- Relevant existing patterns to follow (with file references)
- Commands to run and expected outcomes
- GraphQL schema additions (type/field/mutation names)
- Database model fields and constraints

### DO NOT INCLUDE (implementation details):
- Full function bodies — the implementer writes these
- Line-by-line implementation code
- Complete test implementations (describe what to test, not how)
- Boilerplate that the implementer can derive from signatures + existing patterns

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py`
- Test: `tests/exact/path/to/test.py`
- Reference: `path/to/similar_pattern.py` (follow this pattern)

**Contracts:**

```python
# New function in exact/path/to/file.py
async def process_widget(
    session: AsyncSession,
    widget_id: int,
    config: WidgetConfig,
) -> WidgetResult:
    """Validate widget exists, apply config, return result.
    Raises WidgetNotFoundError if widget_id is invalid.
    Must check caller access via require_access()."""
    ...
```

**Integration:**
- Called from `exact/path/to/caller.py:CallerClass.handle_request()`
- Imports `WidgetConfig` from `app/models/widget.py`
- Uses `require_access(ctx, widget)` pattern from `app/auth/access.py`

**Step 1: Write the failing test**

Test that `process_widget` returns a `WidgetResult` for a valid widget.
Test that `process_widget` raises `WidgetNotFoundError` for an invalid widget_id.
Test that unauthorized access raises `AccessDenied`.

Run: `pytest tests/path/test.py -v`
Expected: FAIL (function not defined)

**Step 2: Implement**

Implement `process_widget` following the contract above.
Follow the pattern in `path/to/similar_pattern.py`.

**Step 3: Verify**

Run: `pytest tests/path/test.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add widget processing"
```
````

## Remember
- Exact file paths always
- Signatures and types, not function bodies
- Describe test requirements (what to assert), not full test code
- Point to existing patterns the implementer should follow
- Exact commands with expected output
- Reference relevant skills with @ syntax
- DRY, YAGNI, TDD, frequent commits

## Execution

After saving the plan, spawn a subagent for EACH task:

**"Plan complete and saved to `.claude/plans/<filename>.md`. Executing tasks with fresh subagent per task..."**

**For each task in the plan:**

1. **Spawn fresh subagent** using Task tool:
   ```
   Use Task tool with:
   - subagent_type: "general-purpose"
   - description: "Execute Task N: [Component Name]"
   - prompt: "Execute Task N from .claude/plans/<filename>.md:
     - Read the task section from the plan file
     - Follow all steps in sequence
     - Write the implementation code based on contracts and patterns referenced
     - Run all verification commands
     - Commit the completed task
     - Report completion with verification results"
   ```

2. **Wait for subagent to complete** the task

3. **Move to next task** and spawn new subagent

**Benefits:**
- Fresh context per task (no context pollution)
- Preserves main agent context for orchestration
- Each task runs to completion independently
- Automatic checkpoints via commits after each task
- Implementer adapts to actual codebase state instead of debugging stale plan code
