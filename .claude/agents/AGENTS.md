# Agents

Specialized subagents for different phases of development. Each agent is a flat
`.md` file with YAML frontmatter. This is a reusable skeleton — add
stack-specific implementer/reviewer agents (e.g. for your language or framework)
as needed.

## Directory Structure

```text
.claude/agents/
├── {agent-name}.md      # Agent with YAML frontmatter (name, description, optional tools/model)
├── AGENTS.md            # This index file
```

## Usage

Agents are invoked via the Task tool:

```text
Task(
  subagent_type="general-purpose",
  prompt="[Read .claude/agents/<agent>.md] [Your specific task]"
)
```

For exploration tasks, use the Explore subagent type:

```text
Task(
  subagent_type="Explore",
  prompt="[Instructions] [Your search query]"
)
```

---

## Research Agents

Use during the planning phase to gather context.

| Agent | File | Purpose |
|-------|------|---------|
| Codebase Explorer | `codebase-explorer.md` | Find existing patterns, similar implementations |
| Best Practices Researcher | `best-practices-researcher.md` | External practitioner insights |
| Framework Docs Researcher | `framework-docs-researcher.md` | Library/framework documentation |

---

## Review Agents

Use during plan review or after implementation.

| Agent | File | Purpose |
|-------|------|---------|
| Simplicity Reviewer | `simplicity-reviewer.md` | Detect over-engineering, verify the Simplicity Gate |
| Architecture Reviewer | `architecture-reviewer.md` | Patterns, abstractions, runtime boundaries |
| Completeness Reviewer | `completeness-reviewer.md` | Error handling, tests, edge cases |
| Performance Oracle | `performance-oracle.md` | N+1 queries, indexes, scalability |
| Security Sentinel | `security-sentinel.md` | Auth, injection, data exposure |
| Spec Flow Analyzer | `spec-flow-analyzer.md` | User flows, gaps, missing specifications |

---

## Implementation Agents

Use during the implementation phase for complex tasks.

| Agent | File | Purpose |
|-------|------|---------|
| TDD Test Writer | `tdd-test-writer.md` | Write failing tests (RED phase), context-isolated from implementation |
| Backend API | `backend-api.md` | REST/GraphQL APIs, microservices, server architecture |
| Database Architect | `database-architect.md` | Schema modeling, query optimization, migrations |
| DevOps Infrastructure | `devops-infrastructure.md` | CI/CD, Docker, Kubernetes, cloud infrastructure |
| Mobile Developer | `mobile-developer.md` | iOS, Android, React Native, Flutter |
| Web Frontend | `web-frontend.md` | React, Vue, Angular, CSS, accessibility |

> Add your own stack-specific implementer agents here following the format at
> the bottom of this file.

---

## Parallel Execution

Launch multiple agents simultaneously by including multiple Task calls in a single message:

```text
# Research phase - all in parallel
Task(...codebase-explorer...)
Task(...best-practices-researcher...)
Task(...framework-docs-researcher...)

# Review phase - all in parallel
Task(...simplicity-reviewer...)
Task(...architecture-reviewer...)
Task(...completeness-reviewer...)
Task(...performance-oracle...)
Task(...security-sentinel...)
```

---

## When to Use Agents vs Direct Work

**Use agents when:**
- Task is complex or risky
- Multiple areas of expertise needed
- Parallel execution would save time
- Need comprehensive review before shipping

**Work directly when:**
- Task is straightforward
- Following existing patterns
- Quick bug fix or small change
- Tests + linting sufficient

---

## Agent Categories by Workflow Phase

| Phase | Agents Used |
|-------|-------------|
| Plan | research agents (parallel) |
| Review | review agents (parallel) |
| Implement | implementation agents (as needed) |
| Commit | (linting and formatting only) |

---

## Adding New Agents

To add a new agent:

1. Create a flat `.md` file in `.claude/agents/`
2. Include YAML frontmatter with `name`, `description`, and optional `model`/`tools`
3. Include these sections: Purpose, Instructions with context, Output format template
4. Add it to this index
5. Reference it from relevant slash commands

### Agent Format

```markdown
---
name: agent-name
description: Brief description of when to use this agent
model: sonnet  # optional, defaults to parent model
---

# Agent Title

You are a [role description]...

## Purpose
...

## Instructions
...

## Output Format
...
```
