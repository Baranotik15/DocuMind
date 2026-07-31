# Design Principles

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Visual Hierarchy](#visual-hierarchy)
3. [Color & Theming](#color--theming)
4. [Typography](#typography)
5. [Spacing & Layout](#spacing--layout)
6. [Component Guidelines](#component-guidelines)
7. [Accessibility](#accessibility)
8. [Responsive Design](#responsive-design)
9. [Motion & Interaction](#motion--interaction)
10. [Naming Conventions](#naming-conventions)
11. [Checklist](#checklist)

---

## Design Philosophy

DocuMind is a working tool for admin operators curating a RAG knowledge base -
uploading documents, manually reviewing/editing machine-generated chunks
before they're embedded, testing the chat pipeline, and monitoring system
activity. It should read as a **precise editorial/systems tool**, not a
marketing dashboard.

### Core Tenets

- **Clarity over decoration** - every element serves a purpose; remove
  anything that doesn't communicate
- **Restraint as a feature** - the one expressive device in this system (the
  amber "signature mark", see below) is deliberately used in very few places.
  Its rarity is what makes it meaningful - resist the urge to reach for it
  decoratively
- **Consistency over novelty** - reuse the same structural devices (the mark,
  the mono/sans split) everywhere they apply, rather than inventing new ones
  per page
- **Data density without clutter** - tables and editing surfaces stay
  scannable through whitespace and a clear mono/sans typographic split
  between "data being inspected" and "UI chrome"

### The Signature Element: the Amber Mark

A **3px solid left border** in `mark-amber` (`#E2A93B`) is DocuMind's one
signature visual device. It appears **only** on elements that are currently
active, edited, or contextually relevant:

- the active nav item (`AppLayout.tsx`)
- a chunk with unsaved edits, i.e. `chunk.isDirty === true` (`ChunksPage.tsx`)
- the chat `context-indicator` badge, because the context indicator is
  inherently about relevance/highlighting (`ChatPage.tsx`) - this is the one
  place amber appears outside an "edited" state, and it's intentional

**Rules for the mark:**

- It is **always** a left border, **never** a background fill, tint, or other
  decoration.
- It is applied conditionally (transparent border reserving the same 3px of
  space when inactive, so nothing shifts layout when state toggles) - see the
  `chunk.isDirty` treatment in `ChunksPage.tsx` for the reference
  implementation.
- Dashboard and Upload pages do **not** use amber anywhere - they have no
  "edited/active" concept the mark would meaningfully apply to. Do not force
  it in just for visual consistency; the absence is intentional.
- Before adding a new amber usage anywhere in the app, ask: "is this thing
  currently active, being edited, or the currently-relevant context?" If not,
  it doesn't get the mark.

### Distinctiveness

- Avoid generic AI-generated SaaS aesthetics (purple/indigo gradients, heavy
  shadows, pill-everything). DocuMind's palette is warm, muted, and
  paper/ink-toned rather than glossy.
- Prefer light mode only (no dark-mode support currently).
- Rely on borders and warm neutral contrast over harsh black/white or heavy
  shadows.

---

## Visual Hierarchy

### Information Ordering

1. **Primary** - page titles, primary actions. `Title`/`fw={600}` in `ink`.
2. **Secondary** - body text, descriptions, supporting data - `ink` at
   regular weight.
3. **Tertiary** - labels, timestamps, metadata - `ink-muted`
   (`c="dimmed"` resolves to `ink-muted` globally, see Color & Theming).
4. **Structural/contextual emphasis** - the amber mark (see above), used
   instead of color-coded text weight for "this needs your attention."

### Depth

- Rely on **borders and warm background contrast** rather than heavy shadows.
- Page background is `paper` (`#F5F3EE`); content surfaces that need to stand
  apart from it (chat message bubbles, cards) use `white` or a light tint of
  `signal-blue`, with a hairline border - not shadows.
- Borders throughout the app (`Table`, `Paper[withBorder]`, `AppShell`
  dividers, input borders) resolve through Mantine's `gray.3` slot, which is
  globally remapped to the `hairline` token (`#DEDACD`) in `theme.ts` - so
  "just use Mantine's default border" already gets DocuMind's warm hairline
  color for free. Don't hardcode a separate border color unless you have a
  specific reason to deviate.

---

## Color & Theming

All colors are defined once in `frontend/src/theme.ts`. **Never hardcode
these hex values in component files** - reference them via the mechanisms
below.

### Tokens

| Token | Hex | Role | How to use it |
|-------|-----|------|----------------|
| `paper` | `#F5F3EE` | Page/content background | Applied globally via `--mantine-color-body`; also `var(--doc-paper)` |
| `ink` | `#1B1F2B` | Primary text; AppShell header background | Applied globally via `--mantine-color-text`; also `var(--doc-ink)` |
| `ink-muted` | `#5B6472` | Secondary text/labels | `c="dimmed"` (remapped globally); also `var(--doc-ink-muted)` |
| `signal-blue` | `#2C5F73` | Default interactive color (buttons, links, focus rings) | `theme.primaryColor` - use Mantine's default `color`/`variant` props, or explicit `color="signalBlue"` / `var(--mantine-color-signalBlue-6)` |
| `mark-amber` | `#E2A93B` | The signature mark **only** - see Design Philosophy | `var(--mantine-color-markAmber-6)`, always as a `border-left`, never a fill |
| `alert-red` | `#B84C3E` | Errors, the dislike-active state, destructive actions | `color="alertRed"` on `Button`/`ActionIcon`/`Badge`, or `var(--mantine-color-alertRed-6)` |
| `hairline` | `#DEDACD` | Borders/dividers | Default via the global `gray.3` remap (see Visual Hierarchy); `var(--doc-hairline)` when you need the raw value outside a bordered component |

`signal-blue`, `mark-amber`, and `alert-red` are registered as full 10-shade
Mantine color ramps (`buildShades()` in `theme.ts` derives the ramp from the
single approved hex, placing it at shade index 6) so they work with Mantine's
normal `variant`/hover/active color system. `paper`, `ink`, `ink-muted`, and
`hairline` are flat tokens exposed via `theme.other` and wired into Mantine's
own CSS variables through a `cssVariablesResolver` (see `theme.ts`), rather
than being registered as ramps - they're used as-is, not through variants.

### Rules

- Do not add new hardcoded hex colors in page/component files - extend
  `theme.ts` instead if a new token is genuinely needed, and update this
  document.
- `mark-amber` is never a background/fill color anywhere in the app (see
  Design Philosophy) - if you catch yourself writing
  `bg="markAmber.something"`, stop and reconsider.
- Mantine's built-in color names (`gray`, `blue`, `red`, etc.) are still
  available and fine to use for anything that isn't one of the roles above
  (e.g. the header's decorative status dot uses Mantine's stock `teal`, since
  it's not a branded token, just a generic "ok" indicator).
- Maintain WCAG AA contrast (4.5:1 normal text, 3:1 large text). `ink` on
  `paper` and `paper` on `ink` both comfortably clear this; check new
  combinations, especially anything placed on the dark header.

---

## Typography

### Font Families

Two self-hosted (offline-safe, no CDN) type families, imported in
`frontend/src/main.tsx` via `@fontsource/ibm-plex-sans` and
`@fontsource/ibm-plex-mono` (weights 400/500/600 for Sans, 400/500 for Mono
only - don't pull in more weights without a reason, it costs bundle size):

- **IBM Plex Sans** (`theme.fontFamily` / `theme.headings.fontFamily`) - all
  UI chrome: navigation, headings, buttons, labels, non-data body text. This
  is the default; you don't need to set it explicitly.
- **IBM Plex Mono** (`theme.fontFamilyMonospace`) - anything that is
  **content/data being curated or inspected**, not UI chrome:
  - chunk `originalContent`/`editedContent` text in `ChunksPage.tsx`
    (`Textarea` `styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}`)
  - data table cells in `DashboardPage.tsx` and `UploadPage.tsx` - filenames,
    statuses, event types, timestamps, ids (`ff="monospace"` on the relevant
    `Table.Td`s only, not the whole row/table)
  - chat message content in `ChatPage.tsx` (`Text ff="monospace"`)

  Free-text/human-authored fields (e.g. a dashboard event's `detail`
  sentence) stay in Plex Sans - the mono treatment is for structured/data
  fields, not prose.

### Weight Rules

- **400 (Regular)** - body text, descriptions, default
- **500 (Medium)** - emphasis where 600 is too heavy
- **600 (Semibold)** - page titles, active nav item, section headings
- **700 (Bold)** - avoid; not loaded (not in the imported weight set)

---

## Spacing & Layout

### Base Grid

Mantine's default spacing tokens (`xs`/`sm`/`md`/`lg`/`xl`), used via the
`gap`/`p`/`m` props - no custom spacing scale is defined in `theme.ts`
currently, Mantine's defaults are used as-is.

### Layout Structure

- **Header**: 60px fixed height, `ink` background, `paper`-toned text (see
  `AppLayout.tsx` - the header locally overrides the `--mantine-color-text`
  CSS variable for its own subtree rather than setting color per-child).
  Includes the brand wordmark and a static decorative "system ok" status
  indicator (no real health-check wiring yet).
- **Navbar**: 240px fixed width, `paper` background (inherits the page
  background), hidden below the `sm` breakpoint. Nav items get the amber mark
  when active (`AppLayout.module.css` + inline style in `AppLayout.tsx`).
- **Content max-width**: Chunks and Chat are editing/reading surfaces and
  use `maw={900}` on their outer `Stack` for a comfortable line length.
  Dashboard and Upload are tables that benefit from the extra width and stay
  full-bleed (no `maw`).

---

## Component Guidelines

### Use Mantine, Not Raw HTML

```tsx
// Correct
<Stack gap="md">
  <Text size="xl" fw={600}>Title</Text>
  <Group justify="space-between">
    <Button variant="filled">Primary</Button>
    <Button variant="outline">Secondary</Button>
  </Group>
</Stack>

// Wrong - no raw divs with inline styles for things Mantine already models
```

Reach for a plain `Box`/inline `style` only for the small number of things
Mantine's props don't cover - the amber mark's conditional `border-left` and
CSS-variable scoping are the two examples currently in the codebase
(`ChunksPage.tsx`, `AppLayout.tsx`).

### Buttons

- **Primary** (`variant="filled"`): resolves to `signal-blue` (the default
  `primaryColor`) - don't pass an explicit `color` unless you specifically
  need a different one.
- **Destructive** (dislike button, future delete actions): `color="alertRed"`.
- Never `color="markAmber"` on a button/fill - see the mark's "never a fill"
  rule.

### Cards / Surfaces

- `Paper withBorder` picks up the `hairline` border color automatically (see
  Visual Hierarchy) - no need to set a border color explicitly.
- Content surfaces sitting on the `paper` page background use `white` or a
  light tint of `signal-blue` (e.g. `bg="signalBlue.0"` for the user's own
  chat messages) to differentiate from the page, not shadows.

### The Amber Mark, Concretely

Reference implementation (from `ChunksPage.tsx`):

```tsx
<Box
  p="sm"
  bdrs="sm"
  style={{
    borderLeft: `3px solid ${chunk.isDirty ? 'var(--mantine-color-markAmber-6)' : 'transparent'}`,
  }}
>
  <Textarea ... />
</Box>
```

Always reserve the 3px of space with a `transparent` border when inactive, so
toggling the state doesn't shift layout.

### Icons

- No icon library is currently installed (Mantine components and text labels
  only as of this pass). If one is added later, prefer `@tabler/icons-react`
  and update this section.

---

## Accessibility

### WCAG 2.1 AA Compliance

- **Color contrast**: 4.5:1 for normal text, 3:1 for large text - verify any
  new color combination, especially text placed on the dark (`ink`) header.
- **Keyboard navigation**: all interactive elements must be focusable and
  operable. Focus rings use `signal-blue` automatically (Mantine's
  `--mantine-primary-color-filled`, driven by `theme.primaryColor`) - don't
  override focus-ring color to amber or red.
- **Semantic HTML**: use `<nav>` (`AppShell.Navbar aria-label="Main
  navigation"`), `<main>`, `<button>` vs generic `<div>`.
- **ARIA labels**: required on icon-only buttons (e.g. the dislike
  `ActionIcon` in `ChatPage.tsx` toggles its `aria-label`/`aria-pressed`
  between "Dislike message" and "Message disliked").
- **Decorative content**: the header's status dot + "system ok" text is
  marked `aria-hidden="true"` on its wrapping `Group` since it conveys no
  real (non-fake) information yet.

---

## Responsive Design

### Breakpoints

Mantine's default breakpoints; the only one in active use today is `sm`
(`AppShell navbar={{ breakpoint: 'sm' }}`), which collapses the sidebar on
narrow viewports.

### Mobile Adaptations

- Sidebar collapses via `AppShell`'s built-in `breakpoint="sm"` behavior - no
  custom CSS needed.
- Chunks/Chat's `maw={900}` naturally becomes full-width on narrow viewports
  since `max-width` only constrains, never forces, width.

---

## Motion & Interaction

- **Duration**: ~150ms for hover/focus transitions (see
  `AppLayout.module.css`'s `.navLink` hover).
- **Properties**: `background-color`, `color` - avoid animating layout
  properties (`width`/`height`/`border-width`) since the mark's border
  toggles are meant to read as instantaneous state, not an animated reveal.
- No decorative motion (no bouncing, pulsing, skeleton shimmer, etc.) as of
  this pass.

---

## Naming Conventions

### Files

- Components: `PascalCase.tsx` (`ChunksPage.tsx`, `AppLayout.tsx`)
- CSS Modules: `ComponentName.module.css` (`AppLayout.module.css`)
- Theme: single source of truth at `frontend/src/theme.ts`

### Theme Tokens

```tsx
// Ramp colors (signal-blue / mark-amber / alert-red): Mantine token syntax
color="alertRed"  bg="signalBlue.0"  var(--mantine-color-markAmber-6)

// Flat tokens (paper / ink / ink-muted / hairline): CSS custom properties,
// or rely on the global remap (--mantine-color-body/text/dimmed/gray-3)
var(--doc-ink)  var(--doc-paper)
```

---

## Checklist

Use this before finalizing any UI implementation:

### Visual Quality
- [ ] Uses Mantine components (not raw HTML/divs with inline styles), except
      where the amber mark or CSS-variable scoping genuinely requires it
- [ ] Uses theme tokens (`theme.ts`), never a new hardcoded hex value
- [ ] The amber mark, if used, is a left border only, applied only to an
      active/edited/contextually-relevant element, and reserves its 3px of
      space even when inactive
- [ ] Mono font applied to data/content being inspected, not to UI chrome
- [ ] Font weights: 400/500/600 only (700 isn't loaded)

### Functionality
- [ ] Loading/empty/error states considered
- [ ] Existing tests (`npm test`) still pass unchanged - don't restructure
      DOM in ways that break `getByRole`/`getByText`/`data-testid` queries

### Responsiveness
- [ ] Works with the sidebar collapsed (`sm` breakpoint and below)
- [ ] Chunks/Chat `maw={900}` respected for new editing/reading surfaces

### Accessibility
- [ ] Keyboard navigable (Tab, Enter, Escape)
- [ ] Focus indicators visible (`signal-blue`, Mantine's default - don't
      override)
- [ ] Color contrast >= 4.5:1 for text, including anything on the `ink`
      header background
- [ ] Icon-only buttons have `aria-label`
- [ ] Purely decorative elements are `aria-hidden`

### Polish
- [ ] Hover states on interactive elements (~150ms transitions)
- [ ] No console errors
- [ ] `npm run lint` (oxlint) and `npm run build` (`tsc -b && vite build`)
      both pass
