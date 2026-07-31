---
name: gather-context
description: Gather relevant codebase context before beginning work by self-generating questions and launching parallel research agents
---

# /gather-context - Gather Context Before Work

Systematically gather the context needed to complete a task by formulating targeted questions and answering them in parallel with subagents.

## When to Use

Use **before** starting any non-trivial work:

- Implementing a feature from a spec or ticket
- Investigating an unfamiliar area of the codebase
- Making changes that touch multiple subsystems
- Picking up work you haven't touched before
- Any time you'd otherwise spend 10+ minutes reading code to orient yourself

## Process

### Step 1: Understand the Task

Read the user's request, any linked spec (`.claude/specs/`), plan (`.claude/plans/`), or ticket. Identify:

- **What** needs to happen (the goal)
- **Where** it likely lives (subsystem, layer)
- **What you don't know** (the gaps)

### Step 2: Formulate 3-5 Questions

Generate 3-5 specific questions whose answers would give you enough context to begin work confidently. Good questions target:

| Category | Example Question |
|----------|-----------------|
| **Existing patterns** | "How do existing services in this area handle X? What files/patterns should I follow?" |
| **Data model** | "What tables/models are involved and how do they relate?" |
| **Integration points** | "What calls this code? What does this code call? Where are the boundaries?" |
| **Constraints** | "Are there multi-tenancy, auth, or transaction patterns I need to follow here?" |
| **Prior work** | "Has anything similar been built? Are there recent commits or PRs that touch this area?" |

**Rules for good questions:**
- Each question should be answerable by reading code, git history, or docs
- Questions should be independent of each other (parallelizable)
- Questions should fill genuine knowledge gaps, not confirm things you already know
- Be specific: "How does the payment processing module handle multi-tenant accounts?" not "How does payment work?"

**Announce your questions to the user before launching agents:**

```
I need to gather context before starting. Here are my questions:

1. [Question 1]
2. [Question 2]
3. [Question 3]
...

Launching research agents now.
```

### Step 3: Launch Parallel Research Agents

Launch one `Explore` subagent per question, **all in a single message** so they run concurrently.

```
Agent(subagent_type="Explore", description="Context: [short label]", prompt="
  I'm about to work on [TASK SUMMARY].

  Question: [THE QUESTION]

  Search the codebase to answer this thoroughly. Look at:
  - Relevant source files, models, services, and tests
  - Related patterns in similar features
  - Recent git history if relevant

  Report your findings thoroughly: key files (with paths and line numbers),
  patterns to follow, and anything surprising or non-obvious.
  Be as detailed as needed — longer, more thorough answers are preferred.
")
```

**Important:**
- All agents launch in a single message (parallel, not sequential)
- Each agent gets the full task summary for context
- Each agent gets exactly one question to focus on
- Agents are told to be thorough — longer answers are preferred over brevity

### Step 4: Consolidate and Present

After all agents complete, synthesize their findings into a single context summary for the user:

```markdown
## Context Summary: [Task Name]

### Key Files
| File | Purpose | Relevance |
|------|---------|-----------|
| `path/to/file.py` | [What it does] | [Why it matters for this task] |

### Patterns to Follow
- [Pattern 1]: found in `path/to/example.py` -- [brief description]
- [Pattern 2]: found in `path/to/example2.py` -- [brief description]

### Constraints & Considerations
- [Constraint 1]
- [Constraint 2]

### Findings

**Q1: [Question]**
[Concise answer with file references]

**Q2: [Question]**
[Concise answer with file references]

...

### Ready to Begin
[1-2 sentences on recommended approach based on gathered context]
```

## What This Is NOT

- **Not a replacement for reading specs.** Read the spec first, then gather context about the codebase.
- **Not an architecture review.** Use `/review-spec` for that.
- **Not a plan.** Use `/write-plan` after gathering context.
- **Not exhaustive research.** 3-5 targeted questions, not 20. Enough to start, not to finish.

## Example

User says: "Implement the webhook retry system from the spec"

**Step 1:** Read `.claude/specs/webhook-retry.md`

**Step 2:** Formulate questions:
1. "How are webhooks currently dispatched? What service/task handles outgoing webhook delivery?"
2. "What existing retry/backoff patterns exist in the codebase (background job retries, custom retry logic)?"
3. "What is the current webhook data model? Are there tables for tracking delivery attempts?"
4. "How do similar async features (e.g., notification delivery) handle failure and dead-lettering?"
5. "Are there existing webhook-related tests? What test patterns do they use?"

**Step 3:** Launch 5 Explore agents in parallel

**Step 4:** Consolidate into context summary, present to user, ready to proceed
