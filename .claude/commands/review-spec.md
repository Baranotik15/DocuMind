# /review-spec - Multi-Agent Specification Review

Review a feature specification for over-engineering, gaps, extensibility issues, and alignment with the project's conventions.

---

## Usage

```bash
/review-spec [spec-file] [focus-areas]
```

**Examples:**
```bash
/review-spec .claude/specs/user-management.md
/review-spec .claude/specs/notifications.md "extensibility, data-model complexity"
```

If no spec file provided, look for the most recent spec in `.claude/specs/`.

---

## When to Use

Use `/review-spec` before creating an implementation plan (`/write-plan`) to catch issues early:

- New feature specifications
- Major feature extensions
- Specs that will be implemented in multiple phases
- Complex data model changes
- Features with AI/async processing components

---

## Process

### Step 1: Read the Specification

Read the spec file to understand what's being proposed. Identify:
- Data models and schema changes
- User flows and interactions
- Integration points
- Phased delivery approach

### Step 2: Launch Review Agents in Parallel

**Use Task tool to launch ALL review agents simultaneously:**

| Agent | Focus Area |
|-------|------------|
| Simplicity Reviewer | Over-engineering, unnecessary complexity, simpler alternatives |
| Architecture Reviewer | Extensibility, patterns, runtime and migration boundaries |
| Performance Oracle | Schema design, data-access patterns, multi-tenancy, indexes, scalability |
| Spec Flow Analyzer | User flow gaps, edge cases, missing error handling |
| Best Practices Researcher | Industry patterns, how leading products solve similar problems |
| Codebase Explorer | Existing patterns to reuse, code that can be extended |

**Parallel Invocation:**

```text
# Launch ALL review agents in a single message with multiple Task calls
Task(subagent_type="Simplicity Reviewer", prompt="Review spec for over-engineering...")
Task(subagent_type="Architecture Reviewer", prompt="Review spec for extensibility...")
Task(subagent_type="Performance Oracle", prompt="Review schema and data-access design...")
Task(subagent_type="spec-flow-analyzer", prompt="Analyze user flows for gaps...")
Task(subagent_type="Best Practices Researcher", prompt="Research industry patterns...")
Task(subagent_type="Codebase Explorer", prompt="Find reusable patterns...")
```

### Step 3: Collect and Synthesize Findings

Wait for all agents to complete, then synthesize into unified report.

---

## Output Format

```markdown
## Spec Review: <spec-name>

### Summary

[1-2 sentence summary of the spec's purpose and overall assessment]

### Verdict: [APPROVED | NEEDS REVISION | BLOCKED]

---

### 🔴 Blockers (must fix before implementation)

| Issue | Source | Recommendation |
|-------|--------|----------------|
| [Issue description] | [Agent name] | [How to fix] |

### 🟡 Concerns (should fix)

| Issue | Source | Recommendation |
|-------|--------|----------------|
| [Issue description] | [Agent name] | [How to fix] |

### 🟢 Suggestions (nice to have)

| Issue | Source | Recommendation |
|-------|--------|----------------|
| [Issue description] | [Agent name] | [How to fix] |

### ✅ Approved Aspects

| Aspect | Source | Notes |
|--------|--------|-------|
| [What looks good] | [Agent name] | [Why it's correct] |

---

### Key Questions Answered

[Address any specific questions raised by the user or identified in the spec's "Open Questions" section]

### Extensibility Assessment

| Too Rigid | Flexible |
|-----------|----------|
| [Hardcoded values, tight coupling] | [JSONB metadata, optional FKs] |

**Recommendations for extensibility:**
1. [Specific recommendation]
2. [Specific recommendation]

### Industry Patterns (from Best Practices Research)

| Pattern | Products Using It | Applicability |
|---------|-------------------|---------------|
| [Pattern name] | [Linear, Asana, etc.] | [How it applies] |

### Reusable Code (from Codebase Explorer)

| Existing Pattern | Location | How to Reuse |
|------------------|----------|--------------|
| [Pattern name] | [File path] | [Specific guidance] |

---

### Recommended Spec Changes

[Bulleted list of specific changes to make to the spec before proceeding to /write-plan]

1. **[Section]:** [Change description]
2. **[Section]:** [Change description]
```

---

## Agent Prompts

### Simplicity Reviewer Prompt

```
Review this specification for over-engineering and unnecessary complexity.

Key questions:
1. Are there simpler alternatives to proposed solutions?
2. Are there features that should be deferred to later phases?
3. Is the data model more complex than necessary for MVP?
4. Are there status values, columns, or tables that could be eliminated?

Spec content:
[SPEC CONTENT]

User's specific concerns (if any):
[USER CONCERNS]
```

### Architecture Reviewer Prompt

```
Review this specification for architecture patterns and extensibility.

Key questions:
1. Is the spec too specific for future extension?
2. Does the data model allow for future requirements mentioned in "Nice to Have"?
3. Are there hardcoded enums/categories that should be more flexible?
4. Does the design follow the project's current runtime and migration patterns?
5. Are there abstractions that should be generalized for reuse?

Spec content:
[SPEC CONTENT]
```

### Performance Oracle Prompt (data / schema review)

```
Review the database schema and data-access design in this specification.

Key questions:
1. Is the schema properly normalized?
2. Are indexes appropriate for query patterns?
3. Is multi-tenancy correctly enforced?
4. Are migrations safe for production (non-blocking index creation, expand-contract)?
5. Are there missing constraints or validations?
6. Does the schema remain compatible with every runtime/ORM that reads it?

Spec content:
[SPEC CONTENT]
```

### Spec Flow Analyzer Prompt

```
Analyze the user flows in this specification for gaps and missing elements.

Key questions:
1. Are there gaps in any of the defined flows?
2. Are there missing error/edge case flows?
3. Are there missing user flows for common scenarios?
4. Are there conflicts between flows?
5. What happens when things go wrong (network errors, validation failures)?

Spec content:
[SPEC CONTENT]
```

### Best Practices Researcher Prompt

```
Research industry best practices relevant to this specification.

Key questions:
1. How do leading products (Linear, Asana, GitHub, etc.) solve similar problems?
2. Are there established patterns we should follow?
3. Are there anti-patterns in the spec we should avoid?
4. What do practitioners recommend for [specific concern]?

Spec content:
[SPEC CONTENT]
```

### Codebase Explorer Prompt

```
Explore the project codebase to find existing patterns that can be reused or extended.

Key questions:
1. What existing tables/models can be extended?
2. What patterns from similar features should be followed?
3. What code can be reused vs. needs new implementation?
4. Are there existing background tasks, services, or components to leverage?

Spec content:
[SPEC CONTENT]
```

---

## When to Skip Agents

Not all agents are needed for every spec:

| Spec Type | Required Agents | Optional Agents |
|-----------|-----------------|-----------------|
| New feature (full stack) | All | - |
| API-only feature | Architecture, Performance Oracle, Simplicity | Flow Analyzer |
| Frontend-only feature | Simplicity, Flow Analyzer, Codebase Explorer | Performance Oracle |
| Database migration | Performance Oracle, Architecture | Simplicity |
| AI/async processing | All (especially Best Practices) | - |

---

## Common Issues to Watch For

### Over-Engineering Red Flags

- More than 5-6 status values for MVP
- Persisting ephemeral/transient state to database
- Building features for hypothetical future requirements
- Complex state machines when simple transitions work
- Separate tables for what could be a status field

### Extensibility Red Flags

- Hardcoded enum values that vary by client/vertical
- 1:1 relationships that should be many-to-many
- CHECK constraints with exhaustive value lists
- Tightly coupled integrations without abstraction

### Database Red Flags

- Missing tenant-scoping column (e.g. `tenant_id`/`org_id`) on multi-tenant tables
- Non-concurrent / blocking index creation on existing tables
- Soft delete patterns (`is_deleted`, `is_active`)
- Missing `ON DELETE` behavior on foreign keys
- JSON columns storing relational data

### Flow Red Flags

- No error handling for external service failures
- Missing mobile/responsive considerations
- Concurrent edit conflicts not addressed
- Abandoned flow cleanup not specified

---

## After Review

1. **If blockers found:**
   - Update the spec to address blockers
   - Re-run `/review-spec` to verify fixes
   - Repeat until approved

2. **If only concerns/suggestions:**
   - Discuss with team if unclear
   - Update spec to address or document why not
   - Proceed to `/write-plan`

3. **When approved:**
   - Run `/write-plan` to create implementation plan
   - Reference review findings during planning

---

## Related Commands

- `/write-spec` - Create a new specification
- `/write-plan` - Create implementation plan from approved spec
- `/review-spec` - Review an implementation plan
- `/work` - Execute an approved plan
