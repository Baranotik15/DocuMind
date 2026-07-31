# /finalize - Session End Review and Simplification

Runs a full review suite on all branch changes (vs main), critically evaluates findings, auto-applies safe fixes, and provides a production-ready PR.

## What it does:

1. **Detects Changes** - Identifies all files changed in branch vs main
2. **Parallel Review** - Launches 4 specialized review agents simultaneously
3. **Critical Evaluation** - AI evaluates each suggestion with reasoning
4. **Auto-fixes** - Applies safe, single-file simplifications
5. **Final Report** - Summarizes what was fixed, deferred, and rejected

## Usage:

```
/finalize
```

## IMPORTANT - How This Command Works:

When the user types `/finalize`, you (the AI agent) MUST:

### Phase 1: Detect Changes

1. **Get all changes in branch vs main:**
   ```bash
   git diff --name-only origin/main...HEAD
   ```

2. **Also check for uncommitted changes:**
   ```bash
   git diff --name-only
   git diff --cached --name-only
   ```

3. **If no changes in branch**, report "No changes to review" and exit.

4. **Categorize files by type:**
   - Group changed files by language / area (e.g. backend source, frontend source, config, docs) so review agents and validation steps can be scoped appropriately (adapt to your stack).

### Phase 2: Launch Review Agents (Parallel)

Launch these 4 agents **simultaneously** using the Task tool in a single message:

1. **simplicity-reviewer**:
   ```
   Analyze the changed files for complexity reduction opportunities and over-engineering.
   Focus on: [list changed files]
   Return specific refactoring suggestions with before/after code.
   Look for: unnecessary nesting, redundant code, unclear logic, overly compact code, premature abstraction.
   Use the Simplicity Gate checklist from your agent definition.
   ```

2. **architecture-reviewer**:
   ```
   Review [list changed files] for design, pattern consistency, and structural issues.
   Flag violations of established conventions and abstractions that add unnecessary coupling.
   ```

3. **completeness-reviewer**:
   ```
   Review [list changed files] for bugs, project convention compliance, code quality, and missing tests or edge cases.
   Score each finding 0-100 for confidence.
   Focus on: obvious bugs, style violations, rule violations, uncovered branches.
   ```

4. **security-sentinel**:
   ```
   Scan [list changed files] for silent failures, inadequate error handling, and security issues.
   Focus on: empty catch blocks, swallowed errors, missing logging, inappropriate fallbacks, data exposure.
   ```

### Phase 3: Synthesize and Evaluate

**Wait for ALL agents to complete.** Then for EACH finding:

1. **Assess validity (0-100 confidence):**
   - Is this a real issue or false positive?
   - Does the context justify the current implementation?
   - Would the fix introduce other problems?

2. **Categorize each finding:**

| Category | Criteria | Action |
|----------|----------|--------|
| ✅ **ACCEPT & FIX** | Confidence ≥80, safe, single-file | Apply fix |
| ⚠️ **DEFER** | Confidence 50-79, risky, or cross-file | Note for review |
| ❌ **REJECT** | Confidence <50, false positive | Ignore with reason |

3. **Document reasoning** for each decision (brief, 1 sentence)

### Phase 4: Apply Accepted Fixes

For each ✅ ACCEPTED fix:

1. Apply the change using Edit tool
2. Run quick validation scoped to the changed area (adapt to your stack):
   ```bash
   # Run the linter / formatter check
   # Run the type checker
   # Run the build (if applicable)
   ```
3. If validation fails, **revert** and mark as DEFER
4. Track what was changed

### Phase 5: Final Report

Output this structured report:

```markdown
## Session Finalize Report

### Files Reviewed
- [list files with line counts changed]

### Fixes Applied ✅
| File | Issue | Fix Applied |
|------|-------|-------------|
| path/file.py:45 | [Issue description] | [What was fixed] |

### Deferred for Review ⚠️
| File | Issue | Reason Deferred |
|------|-------|-----------------|
| path/file.py:102 | [Issue description] | [Why deferred] |

### Rejected (False Positives) ❌
| File | Suggestion | Reason Rejected |
|------|------------|-----------------|
| path/file.py:15 | [Suggestion] | [Why rejected] |

### Summary
- **Reviewed**: X files
- **Fixed**: Y issues
- **Deferred**: Z issues
- **Rejected**: W suggestions

All fixes verified with the linter and type checker.
```

## Evaluation Criteria:

### ✅ ACCEPT if:
- Simplification is purely mechanical (flatten nesting, extract duplication)
- Fix is within single file (no cross-file refactors)
- Pattern matches existing codebase conventions
- No business logic changes
- Confidence ≥80

### ⚠️ DEFER if:
- Requires cross-file changes
- Touches auth/security/payment code
- Affects public API signatures
- Needs domain knowledge to validate
- Confidence 50-79

### ❌ REJECT if:
- False positive (context justifies current code)
- Over-optimization (current code is clear enough)
- Would break existing patterns
- Confidence <50
- Already intentional (comment explains why)

## Example Flow:

```
/finalize

🔍 Detecting changes...
Found 3 files with uncommitted changes:
  - src/services/auth.py (42 lines)
  - src/api/users.py (18 lines)
  - src/components/UserCard.tsx (25 lines)

🚀 Launching 4 review agents in parallel...
  ⏳ simplicity-reviewer
  ⏳ architecture-reviewer
  ⏳ completeness-reviewer
  ⏳ security-sentinel

✅ All agents completed. Found 8 suggestions.

🤔 Evaluating suggestions...

✅ ACCEPT [95]: auth.py:45 - Flatten nested conditionals
   → Clear mechanical improvement, easy to verify

✅ ACCEPT [88]: users.py:23 - Add logging to except block
   → Silent failure, obvious fix

⚠️ DEFER [65]: auth.py:102 - Extract to decorator pattern
   → Cross-file change, needs architectural review

❌ REJECT [40]: UserCard.tsx:15 - Extract to separate file
   → False positive: component is context-specific, separation not warranted

📝 Applying 2 fixes...
  ✅ Flattened conditionals in auth.py:45
  ✅ Added logging to except block in users.py:23

🔍 Running validation...
  ✅ linter: passed
  ✅ formatter: passed

## Session Finalize Report

### Files Reviewed
- src/services/auth.py (42 lines)
- src/api/users.py (18 lines)
- src/components/UserCard.tsx (25 lines)

### Fixes Applied ✅
| File | Issue | Fix Applied |
|------|-------|-------------|
| auth.py:45 | Nested conditionals (3 levels) | Flattened with early returns |
| users.py:23 | Empty except block | Added logging and re-raise |

### Deferred for Review ⚠️
| File | Issue | Reason Deferred |
|------|-------|-----------------|
| auth.py:102 | Consider decorator pattern | Cross-file change, needs review |

### Rejected (False Positives) ❌
| File | Suggestion | Reason Rejected |
|------|------------|-----------------|
| UserCard.tsx:15 | Extract to separate file | Single use, context-specific |

### Summary
- **Reviewed**: 3 files
- **Fixed**: 2 issues
- **Deferred**: 1 issue
- **Rejected**: 1 suggestion

All fixes verified with the linter and formatter.
```

## When This Runs:

- **Manually**: User types `/finalize`
- **Automatically**: Stop hook triggers when session ends (if configured)

## Related Commands:

- `/review` - Full 6-phase review (more comprehensive, for PRs)
- `/commit` - Review and commit changes
- `/push` - Push and create PR

## Troubleshooting:

**No changes detected:**
```bash
# Check for uncommitted changes
git status
git diff --name-only
```

**Agent timeout:**
- Agents have 5-minute timeout
- For large changes, consider running `/review` instead

**Validation fails after fix:**
- Fix is automatically reverted
- Marked as DEFER for manual review
- Check the error message for details

---

**Tip:** Run `/finalize` before ending your session to ensure code quality is maintained.
