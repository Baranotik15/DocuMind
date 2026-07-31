# Codestyle Guidelines

## General Rules

- Always import at the top of files. No inline imports.
- Avoid inline functions where applicable.
- Prefer code to be backwards compatible.
- Prefer to raise/throw vs returning a null value.
- Prefer short, concise methods.
- Prefer a null value over placeholder strings like `""` or `"unknown"` for absent values. If a value doesn't exist, represent it with the language's proper "no value" type (e.g. `None`, `null`, `Option`/`Optional`) — never use empty strings or sentinel values as substitutes for null.
- Prefer raising exceptions over silently returning empty data structures (`[]`, `{}`, `""`) when a precondition is violated or required data is missing. Empty returns hide failures and make debugging harder — the caller can't distinguish "no results" from "something went wrong." Raise a specific, descriptive exception so callers can react appropriately. Reserve empty returns for cases where "nothing found" is a legitimate, expected outcome.

## Type-Checking Conventions

- Concrete first-party classes that intentionally implement an interface/protocol should explicitly declare that relationship so the type checker verifies conformance at the implementation site.
- Use structural-only typing for incidental duck typing where no explicit implementation relationship is intended.
- Fall back to assignment- or cast-based conformance checks only when explicit declaration is impractical, such as for third-party classes, modules, or runtime resolution conflicts.

## Logging

- Logs that must be searchable or alertable in your log aggregation system should include the exception type and message in structured fields (e.g. `error="RuntimeError: ..."`), not only in a free-text message or attached stack trace.
- Do not rely on a language's "log the current exception" helper alone for production observability if your ingest path may drop or fail to index attached exception objects. Duplicate the actionable exception detail into structured fields.
- It is fine to include a full stack trace for local traceback context, but alerting logs must also carry the actionable exception detail in structured fields.

## Terminology Consistency

Keep role/permission and domain terminology consistent across the codebase.
Document the canonical term for each concept (and any legacy aliases) so
everyone uses the same vocabulary in code, endpoints, and property checks.
Prefer the current term; remove legacy aliases once migration is complete.

> Fill in this project's canonical terms here (e.g. the term for elevated /
> cross-tenant access and how it is identified).

## Visual Development & Testing

### Design System

All UI development must adhere to the project's design system:
- **Design Principles**: `.claude/context/design-principles.md`
- **Style Guide**: `.claude/skills/ui-design/STYLE_GUIDE.md`
- **Component Library**: (adapt to your stack) the project's UI component library and theme

### Quick Visual Check

**IMMEDIATELY after implementing any front-end change:**

1. **Identify what changed** - Review the modified components/pages
2. **Navigate to affected pages** - Use browser automation (e.g. `mcp__playwright__browser_navigate`) to visit each changed view
3. **Verify design compliance** - Compare against design principles and style guide
4. **Capture evidence** - Take a full-page screenshot at desktop viewport (1440px)
5. **Check for errors** - Inspect the browser console (e.g. `mcp__playwright__browser_console_messages`)

### When to Use Visual Testing

**Use Quick Visual Check for:** Every front-end change, no matter how small.

**Use `/design-review` for:** Major feature implementations, before creating PRs with UI changes.

**Skip Visual Testing for:** Backend-only changes, configuration updates, documentation, test files.
