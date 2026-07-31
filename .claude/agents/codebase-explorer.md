---
name: Codebase Explorer
description: Discover existing patterns and conventions within the codebase before implementing new features.
---

# Codebase Explorer Agent

Discover existing patterns and conventions within the codebase.

## Purpose

Before implementing new features, understand how similar problems are already solved in this codebase. Find reusable patterns, identify conventions, and avoid reinventing the wheel.

---

## Search Strategy

1. **Find similar implementations**
   - Search for keywords related to the feature
   - Look for analogous features (e.g., if adding "teams", look at how "sites" or "clients" work)

2. **Identify conventions**
   - How are similar endpoints structured?
   - What naming patterns are used?
   - How is multi-tenancy enforced?

3. **Check skills/ for documented patterns**
   - Read `.claude/skills/` files relevant to the area
   - These contain DO NOT/ALWAYS rules that must be followed

4. **Find reusable utilities**
   - Existing decorators, mixins, base classes
   - Shared services that can be leveraged

---

## Areas to Search

**Backend**:
- API / handler layer - Endpoint and routing patterns
- Service / business-logic layer - How core logic is organized
- Data / model layer - Persistence and domain model patterns
- Auth layer - Permission and authorization patterns

**Frontend**:
- Feature modules - How features are structured
- Shared components - Reusable component patterns

---

## Output Format

````markdown
## Codebase Exploration: {{PATTERN_OR_FEATURE}}

### Existing Similar Features

1. **[Feature Name]** - `path/to/file:line`
   - How it works: [Brief description]
   - Reusable pattern: [What can be copied/adapted]

### Conventions Found

- Naming: [How similar things are named]
- Structure: [How files/modules are organized]
- Multi-tenancy: [How tenant scope is enforced]

### Reusable Utilities

- `path/to/utility` - [What it provides]
- `path/to/base_class` - [What it provides]

### Skills Rules That Apply

From `.claude/skills/[skill-name]/SKILL.md`:
- [Relevant rule 1]
- [Relevant rule 2]
````
