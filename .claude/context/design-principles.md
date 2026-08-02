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
activity. This pass is a full pivot away from the previous restrained
editorial look: DocuMind now reads as a **bold, dark, "neon" operator
console** - a saturated blue+orange pairing on a deep navy background,
rounded/glowing surfaces, and noticeably bigger type. Decorative, not
minimal - this replaces (not extends) the earlier paper/ink/amber system.

### Core Tenets

- **Energy over restraint** - this is a deliberate reversal of the previous
  pass's "restraint as a feature" tenet. Saturated color, glow, and rounded
  pill shapes are used throughout, not reserved for a single signature
  device.
- **Legibility at scale** - the base type scale is noticeably bigger than a
  typical admin tool (see Typography). Don't undo this by reaching for small
  text out of old habit.
- **Consistency in the signature device** - the mark (see below) keeps the
  exact same meaning and placement rules as before, just re-expressed for the
  new palette. Everything else about the visual language is new.
- **Data density without clutter** - tables and editing surfaces stay
  scannable through whitespace and a clear mono/sans typographic split
  between "data being inspected" and "UI chrome" - this rule is unchanged
  from the previous pass.

### The Signature Element: the sparkOrange Mark

A **3px solid left border in `sparkOrange` (`#FF7A29`), paired with a soft
outer glow** (`box-shadow: var(--doc-mark-glow)`, currently
`0 0 12px rgba(255, 122, 41, 0.55)`), is DocuMind's one signature visual
device - the direct successor to the previous pass's flat amber mark. A flat
line doesn't read as "neon"; the glow is what makes the same underlying idea
fit this palette. It appears **only** on elements that are currently active,
edited, or contextually relevant - identical placement rules to before:

- the active nav item (`AppLayout.tsx`)
- a chunk with unsaved edits, i.e. `chunk.isDirty === true` (`ChunksPage.tsx`)
- the chat `context-indicator` badge - the one place the mark appears outside
  an "edited" state, because the context indicator is inherently about
  relevance/highlighting (`ChatPage.tsx`)

**Rules for the mark:**

- Always a left border **plus** the glow - never a background fill, and never
  the border without the glow (a flat orange line alone reads as an accent
  color choice, not "the mark").
- Applied conditionally (transparent border + no shadow when inactive,
  reserving the same 3px of space so nothing shifts layout when state
  toggles) - see the `chunk.isDirty` treatment in `ChunksPage.tsx`.
- On elements with a large border-radius (e.g. a pill), a straight
  `border-left` clips awkwardly against the curve. Where the mark needs to
  appear on a rounded element (the chat context-indicator), keep that
  specific element at a small/medium radius rather than a full pill so the
  mark reads cleanly - this is why the context-indicator badge is
  `radius="sm"` while buttons elsewhere are pills.
- Dashboard and Upload pages do **not** use the mark anywhere - they have no
  "edited/active" concept it would meaningfully apply to. Don't force it in
  just for visual consistency.
- Before adding a new `sparkOrange` mark usage anywhere in the app, ask: "is
  this thing currently active, being edited, or the currently-relevant
  context?" If not, it doesn't get the mark - plain `sparkOrange` fills/text
  (buttons, bar-chart bars, the brand mark) are NOT the signature mark, they're
  just the secondary accent color used on its own terms.

### Network/Graph Texture

DocuMind is fundamentally a graph of connected documents and chunks feeding a
RAG pipeline - this pass leans into that visual metaphor in two small,
decorative places (never in working/data-dense surfaces, where it would be
clutter):

- **`AppLayout.tsx`'s navbar** has a very low-opacity dot-grid background
  (`radial-gradient` in `AppLayout.module.css`'s `.navbar` rule) - an ambient
  texture behind the nav links, not a focal element.
- **The brand wordmark** is preceded by a small inline SVG of three connected
  nodes in the two brand accents (`BrandMark` in `AppLayout.tsx`) - a literal,
  tiny illustration of "documents/chunks as a connected graph."

Resist adding this pattern to tables, forms, or any other data-bearing
surface - it's a header/nav-level flourish, not a global background texture.

### Distinctiveness

- Fully embraces a "generic AI SaaS neon" aesthetic on purpose this time -
  saturated blue+orange, glow, pill buttons, rounded panels. This is an
  explicit, deliberate choice for this pass (reversing the previous pass's
  "avoid glossy/pill-everything" guidance), not an accidental drift.
- Dark mode only (no light-mode support currently, same as before - just a
  different single mode).
- Rely on saturated fills, glow, and generous rounding rather than borders and
  neutral contrast for depth.

---

## Visual Hierarchy

### Information Ordering

1. **Primary** - page titles, primary actions, dashboard stat numbers. `Title`
   at `fw={700}` (theme default), or explicit large `fw={700}` `Text` for stat
   numbers.
2. **Secondary** - body text, descriptions, supporting data - `text` token at
   regular/medium weight.
3. **Tertiary** - labels, timestamps, metadata - `textMuted`
   (`c="dimmed"` resolves to `textMuted` globally, see Color & Theming).
4. **Structural/contextual emphasis** - the sparkOrange mark + glow (see
   above), used instead of color-coded text weight for "this needs your
   attention."

### Depth

- Rely on **saturated fills, translucent tints, and glow** rather than flat
  borders/warm-neutral contrast (the previous pass's approach).
- Page background is `void` (`#0A0E1A`); elevated surfaces (cards, panels,
  the header, chat message bubbles, the dropzone) use `surface` (`#131B2E`)
  or a translucent brand-color tint (e.g. `rgba(61, 107, 255, 0.16)` for the
  user's own chat messages), generally with a 1px hairline or brand-tinted
  border and a generous border-radius (`defaultRadius: 'lg'` app-wide).
- Borders throughout the app (`Table`, `Paper[withBorder]`, `AppShell`
  dividers, input borders) resolve through Mantine's `gray.3` slot, which is
  globally remapped to the `hairline` token
  (`rgba(232, 237, 250, 0.12)` - translucent light-on-dark, not a flat hex)
  in `theme.ts`. The app intentionally stays in Mantine's default "light"
  color-scheme data-attribute (no dark-mode toggle) - "light" here just means
  "the one scheme in use"; the resolver repoints its variables to the dark
  palette above. Don't hardcode a separate border color unless you have a
  specific reason to deviate.

---

## Color & Theming

All colors are defined once in `frontend/src/theme.ts`. **Never hardcode
these hex values in component files** - reference them via the mechanisms
below.

### Tokens

| Token | Hex | Role | How to use it |
|-------|-----|------|----------------|
| `void` | `#0A0E1A` | Page background | Applied globally via `--mantine-color-body`; also `var(--doc-void)` |
| `surface` | `#131B2E` | Elevated cards/panels/header/dropzone background | `var(--doc-surface)` |
| `text` | `#E8EDFA` | Primary text | Applied globally via `--mantine-color-text`; also `var(--doc-text)` |
| `textMuted` | `#7C8AAD` | Secondary text/labels | `c="dimmed"` (remapped globally); also `var(--doc-text-muted)` |
| `signalBlue` | `#3D6BFF` | Primary accent: structure/connections/trust, default interactive color | `theme.primaryColor` - use Mantine's default `color`/`variant` props, or explicit `color="signalBlue"` / `var(--mantine-color-signalBlue-6)` |
| `sparkOrange` | `#FF7A29` | Secondary accent: active/highlighted state, secondary CTAs, **and** the signature mark (border+glow) - see Design Philosophy | `color="sparkOrange"` for CTAs/fills; `var(--mantine-color-sparkOrange-6)` + `var(--doc-mark-glow)` for the mark specifically |
| `alertMagenta` | `#FF3D71` | Errors, the dislike-active state, destructive actions - distinct from both blue and orange | `color="alertMagenta"` on `Button`/`Badge`, or `var(--mantine-color-alertMagenta-6)` |
| `hairline` | `rgba(232, 237, 250, 0.12)` | Borders/dividers | Default via the global `gray.3` remap (see Visual Hierarchy); `var(--doc-hairline)` when you need the raw value outside a bordered component |

`signalBlue`, `sparkOrange`, and `alertMagenta` are registered as full
10-shade Mantine color ramps (`buildShades()` in `theme.ts` derives the ramp
from the single approved hex, placing it at shade index 6) so they work with
Mantine's normal `variant`/hover/active color system. `void`, `surface`,
`text`, `textMuted`, and `hairline` are flat tokens exposed via `theme.other`
and wired into Mantine's own CSS variables through a `cssVariablesResolver`
(see `theme.ts`), rather than being registered as ramps.

`theme.other.markGlow` (`var(--doc-mark-glow)`) holds the exact glow
`box-shadow` value used by the signature mark - defined once so the three
call sites (nav, chunks, chat) never drift apart.

### Contrast note: `autoContrast` + `black`

All three brand accents are bright/saturated enough that white text on a
filled button/badge falls short of WCAG AA (as low as ~2.6:1 for
`sparkOrange`). Rather than hand-picking a text color per call site, the
theme sets `autoContrast: true` and points `theme.black` at `void` (instead
of pure `#000`) - Mantine then automatically uses near-black (`void`) text on
any filled `signalBlue`/`sparkOrange`/`alertMagenta` surface, which clears
AA comfortably (4.75:1 / 8.07:1 / 6.16:1 respectively) and keeps "dark text on
a bright pill" in-palette instead of introducing pure black. **Don't override
a filled button/badge's text color manually** - `autoContrast` already
handles it correctly for every registered color.

### Rules

- Do not add new hardcoded hex colors in page/component files - extend
  `theme.ts` instead if a new token is genuinely needed, and update this
  document.
- The sparkOrange mark (border + glow together) is never a background/fill
  color anywhere in the app (see Design Philosophy) - plain `sparkOrange`
  fills (buttons, bar-chart bars, the brand mark icon) are fine, just don't
  call that usage "the mark."
- Mantine's built-in color names (`gray`, `blue`, `red`, `teal`, etc.) are
  still available and fine to use for anything that isn't one of the roles
  above (e.g. the header's decorative "system ok" status dot uses Mantine's
  stock `teal`, since it's not a branded token, just a generic "ok"
  indicator).
- Maintain WCAG AA contrast (4.5:1 normal text, 3:1 large text) for **text**
  usage of a color; `text`/`textMuted` on `void`/`surface` and the brand
  ramps' base shade used as *text* directly on `void`/`surface` all clear
  this (verified in `theme.ts`'s comments) - if you introduce a new
  text-on-dark combination, check it against the same background colors.

---

## Typography

### Font Families

Two self-hosted (offline-safe, no CDN) type families, imported in
`frontend/src/main.tsx` via `@fontsource/ibm-plex-sans` and
`@fontsource/ibm-plex-mono` (weights 400/500/600/700 for Sans - 700 added in
this pass for page titles and the dashboard's big stat numbers - 400/500 for
Mono only):

- **IBM Plex Sans** (`theme.fontFamily` / `theme.headings.fontFamily`) - all
  UI chrome: navigation, headings, buttons, labels, non-data body text. This
  is the default; you don't need to set it explicitly.
- **IBM Plex Mono** (`theme.fontFamilyMonospace`) - anything that is
  **content/data being curated or inspected**, not UI chrome:
  - chunk `originalContent`/`editedContent` text in `ChunksPage.tsx`
    (`Textarea` `styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}`)
  - data table cells in `DashboardPage.tsx` and `UploadPage.tsx` - filenames,
    event types, timestamps, ids (`ff="monospace"` on the relevant
    `Table.Td`s only, not the whole row/table), and the "events by type" bar
    labels in `DashboardPage.tsx` (also data, same treatment as a table cell).
    **Exception:** Upload's Status column renders a color-coded `Badge` (plus
    a `Loader` for the two unsettled statuses) instead of mono text - see
    "Upload: Status Badges" below - since combining status display with the
    "still processing" indicator needs a component, not a text cell.
  - chat message content in `ChatPage.tsx` (`Text ff="monospace"`)

  Free-text/human-authored fields (e.g. a dashboard event's `detail`
  sentence) stay in Plex Sans - the mono treatment is for structured/data
  fields, not prose.

### Scale

This pass raises the base type scale noticeably - the brief explicitly asked
for "clearly bigger," not a marginal bump:

| Mantine size | Previous | Now |
|---|---|---|
| `xs` | 12px | 14px |
| `sm` | 14px | 16px |
| `md` | 16px | 18px |
| `lg` | 18px | 22px |
| `xl` | 20px | 26px |

Headings (`theme.headings.sizes`) are similarly bumped (h1 44px, h2 36px, h3
30px, h4 24px, h5 20px, h6 18px) and default to `fontWeight: 700` (vs. the
previous pass's 600 - see the `autoContrast`/`black` note above for why 700
is now loaded). Dashboard stat-card numbers go further still, at an explicit
`3rem` (48px) `fw={700}` - the one place a large-number treatment beyond the
heading scale is explicitly wanted (see `StatCard` in `DashboardPage.tsx`).

### Weight Rules

- **400 (Regular)** - body text, descriptions, default
- **500 (Medium)** - emphasis where 600 is too heavy; default nav-link weight
- **600 (Semibold)** - section labels (e.g. stat-card uppercase labels)
- **700 (Bold)** - page titles/headings (theme default), active nav item,
  dashboard stat numbers, dropzone copy - loaded and used freely in this pass
  (unlike the previous pass, where it wasn't imported)

---

## Spacing & Layout

### Base Grid

Mantine's default spacing tokens (`xs`/`sm`/`md`/`lg`/`xl`), used via the
`gap`/`p`/`m` props - no custom spacing scale is defined in `theme.ts`.

### Layout Structure

- **Header**: 68px fixed height (bumped from 60px to comfortably fit the
  bigger brand wordmark), `surface` background with a `hairline` bottom
  border, `text`-toned content (see `AppLayout.tsx` - the header locally
  overrides the `--mantine-color-text` CSS variable for its own subtree).
  Includes the brand wordmark + the decorative connected-node `BrandMark` SVG,
  and a static decorative "system ok" status indicator (no real health-check
  wiring yet).
- **Navbar**: 240px fixed width, `void` background (blends with the page) with
  a low-opacity dot-grid texture and a `hairline` right border, hidden below
  the `sm` breakpoint. Nav items get the sparkOrange mark (border + glow)
  when active (`AppLayout.module.css` + inline style in `AppLayout.tsx`).
- **Content max-width**: Chunks and Chat are editing/reading surfaces and
  use `maw={900}` on their outer `Stack` for a comfortable line length.
  Dashboard and Upload are tables that benefit from the extra width and stay
  full-bleed (no `maw`).
- **`defaultRadius: 'lg'`** is set app-wide in `theme.ts`, so Paper/Card/
  inputs/etc. are rounded by default without per-component overrides. Buttons
  that need a full pill shape (Send, the dislike control) explicitly pass
  `radius="xl"`.

---

## Component Guidelines

### Use Mantine, Not Raw HTML

```tsx
// Correct
<Stack gap="md">
  <Text size="xl" fw={700}>Title</Text>
  <Group justify="space-between">
    <Button variant="filled" radius="xl">Primary</Button>
    <Button variant="outline" radius="xl">Secondary</Button>
  </Group>
</Stack>

// Wrong - no raw divs with inline styles for things Mantine already models
```

Reach for a plain `Box`/inline `style` only for the small number of things
Mantine's props don't cover - the mark's conditional `border-left` +
`box-shadow`, the dashboard's bar-chart bars, and CSS-variable scoping are
the examples currently in the codebase (`ChunksPage.tsx`, `AppLayout.tsx`,
`DashboardPage.tsx`).

### Buttons

- **Primary** (`variant="filled"`, default): resolves to `signalBlue` (the
  default `primaryColor`) - don't pass an explicit `color` unless you
  specifically need a different one (e.g. Chunks' Save button).
- **Bold pill CTAs** (Chat's Send/dislike): `radius="xl"` with an explicit
  brand color - `sparkOrange` for Send, `alertMagenta` for the dislike-active
  state (`variant="filled"` when active, `variant="outline"` when not, same
  toggle pattern as before).
- **Destructive**: `color="alertMagenta"`.
- **Cancel/dismiss vs. the confirming action, inside a confirm dialog
  itself**: the quiet dismiss option is `variant="subtle" color="signalBlue"`,
  reserving the bold `variant="filled" color="alertMagenta"` (or
  `sparkOrange` for a non-destructive confirm, e.g. Overwrite) treatment for
  the button that actually performs the confirmed/destructive action. See
  UploadPage.tsx's Delete/Overwrite confirm `Modal`s, and
  ChunkPreviewPage.tsx's own discard-changes confirm `Modal` ("Keep editing"
  is the quiet option, "Discard changes" is the bold one). **Exception**:
  ChunkPreviewPage.tsx's page-level Cancel button (the one that opens that
  Modal, not a button inside it) is itself `variant="filled"
  color="alertMagenta"` - a deliberate, explicit user override of the
  quieter treatment this bullet otherwise recommends for a plain top-level
  Cancel; see the Chunk Preview subsection below for the full history.
- The sparkOrange mark is never applied to a button via `color="sparkOrange"`
  variant="filled"` as if it were "the mark" - that's just the secondary
  accent color used as an ordinary button color, not the signature device
  (see Design Philosophy).

### Cards / Surfaces

- `Paper`/`Box` surfaces sitting on the `void` page background use `surface`
  (`var(--doc-surface)`, e.g. `bg="var(--doc-surface)"`) or a translucent
  brand tint (e.g. `rgba(61, 107, 255, 0.16)` for the user's own chat
  messages) to differentiate from the page, generally paired with a 1px
  `hairline` or brand-tinted border and the app's default `lg` radius.

### The sparkOrange Mark, Concretely

Reference implementation (from `ChunksPage.tsx`):

```tsx
<Box
  p="md"
  bg="var(--doc-surface)"
  bdrs="lg"
  style={{
    borderLeft: `3px solid ${chunk.isDirty ? 'var(--mantine-color-sparkOrange-6)' : 'transparent'}`,
    boxShadow: chunk.isDirty ? 'var(--doc-mark-glow)' : 'none',
  }}
>
  <Textarea ... />
</Box>
```

Always reserve the 3px of space with a `transparent` border (and no shadow)
when inactive, so toggling the state doesn't shift layout.

### Upload: the Dropzone

`UploadPage.tsx` uses `@mantine/dropzone`'s `Dropzone` (not a plain
`FileInput`) for a large, prominent drop target above the document table:
dashed `sparkOrange` border, `surface` background, `radius="lg"`, a small
hand-rolled cloud-upload SVG (no icon library dependency - see Icons below),
and "Drop a document here or click to browse" copy. Idle-state styling lives
in `UploadPage.module.css`, scoped to `:where([data-idle])` (zero-specificity,
matching Mantine's own convention) so the component's built-in `acceptColor`/
`rejectColor` drag-feedback (set to `sparkOrange`/`alertMagenta` via props)
keeps working - **never override `backgroundColor`/`borderColor` via the
`style`/`styles` prop on `Dropzone`**, since inline styles unconditionally
beat the component's internal accept/reject CSS and would silently break drag
feedback; use a CSS Module class via `classNames` instead.

### Upload: Fuzzy Filename Search

A `TextInput` sits above the document table in `UploadPage.tsx`, filtering
the already-fetched document list client-side - BEFORE the sort logic runs
(`filteredDocuments` feeds into `sortedDocuments`, never the reverse).
Matching is fuzzy/typo-tolerant, not plain substring: `fuzzyMatchesFilename`
(`frontend/src/utils/fuzzyMatch.ts`) is a small hand-rolled trigram
(3-character n-gram) matcher using the Sørensen-Dice coefficient - **no
fuzzy-search library dependency** (Fuse.js etc.), same "hand-roll a small
utility instead of adding a package" precedent as `formatDateTime.ts`. An
exact case-insensitive substring match always counts as a fast path;
otherwise the filename is split into word tokens and the query's trigram set
is compared against each token's trigram set separately (taking the best
score), since comparing against the whole multi-word filename directly
dilutes a short query's similarity - see the module's own comments for the
full rationale and `fuzzyMatch.test.ts` for the empirically tuned threshold.
An empty query shows every document; a search with no matches shows a "No
documents match your search." empty state in the table area, consistent with
the "No documents uploaded yet." empty state used when there's nothing to
show at all.

The field itself is a deliberately designed pill, not just a centered box:
`radius="xl"` at `size="lg"`, matching the visual weight/proportions of
Chat's message-composer `Paper` (surface background, hairline border, pill
shape - see `ChatPage.tsx`) as the closest established "input that should
read as inviting/polished" precedent, even though Chat's own input is a
`Paper`-wrapped `variant="unstyled"` field rather than a standalone
`TextInput` - the visual characteristics (pill radius, `--doc-surface`
background, `--doc-hairline` border) are what's being matched, not the exact
component structure. A leading hand-rolled magnifying-glass `leftSection`
glyph (`SearchIcon`, stroke pinned directly to `var(--doc-text-muted)` since
it's a fixed affordance rather than a state-dependent indicator like
`SortIcon`) gives immediate visual affordance that it's a filter field. A
`rightSection` clear (×) action (`ClearIcon` inside a plain `UnstyledButton`,
`currentColor`-styled via `var(--doc-text-muted)`) renders only once
`nameQuery` is non-empty and resets it to `''` on click, so clearing no
longer requires manually deleting every character. Centered (`mx="auto"`,
`maw={620}`) per an earlier explicit request that still stands. **The field
has no `label` and no visible copy containing the word "Search" anywhere**
(placeholder: "Filter by filename...") - the leading glyph plus placeholder
already communicate its purpose, so a separate text label was deemed
redundant chrome; `aria-label="Filter by filename"` on the `TextInput`
supplies the accessible name instead (and the clear button's own
`aria-label` is "Clear filter" for the same reason/consistency). The
dark-surface background/hairline border fix from the prior functional pass
(Mantine's light-scheme-white input background washing out text - same root
cause as the Dropzone's white-background bug) is preserved, just re-applied
at the new pill radius/size.

### Upload: Elevated Table Panel

The document table is wrapped in a `Paper[withBorder]` (`UploadPage.tsx`)
rather than rendering bare on the `void` page background - the standard
Cards/Surfaces pattern (`bg="var(--doc-surface)"`, hairline border via the
`gray.3` remap, the app's default `radius="lg"`, `p="md"` so the table
doesn't sit flush against the panel's rounded corners - see
`ChunkPreviewPage.tsx`'s chunk boxes / Chat's message bubbles for the same
base pattern elsewhere). On top of that, an inline `boxShadow: '0 24px 48px
-24px rgba(0, 0, 0, 0.55)'` gives the panel a soft, bottom-weighted neutral
elevation shadow so it reads as genuinely lifted off the page rather than
just outlined - a wide, soft, dark shadow biased downward, not a hard drop
shadow. This is a **neutral depth/elevation device, not the sparkOrange
signature mark** - Upload has no "edited/active/contextually-relevant"
concept for the mark to attach to (see Design Philosophy above), so the
panel uses a plain dark shadow rather than the mark's colored glow.

### Upload: Status Badges + Sortable Headers

The document table's Status column renders a `StatusBadge` (`UploadPage.tsx`)
rather than plain mono text: a color-coded `Badge` per status (`gray` for
`uploaded`, `signalBlue` for `chunking`, stock `teal` for `ready` - the same
generic "ok" tone as the header's decorative status dot - and `alertMagenta`
for `failed`), plus a small `Loader` alongside it for the two unsettled
statuses (`uploaded`/`chunking`) so "still processing" is visually
unmistakable rather than a static word. `UploadPage.tsx` also lightly polls
`listDocuments()` (every `POLL_INTERVAL_MS`) while anything is unsettled, so
the badge genuinely progresses to `ready`/`failed` on its own; polling stops
once nothing is unsettled, and is guarded against clobbering a more recent
local optimistic update (see the effect's comments).

The Filename/Status/Uploaded at column headers are clickable
(`SortableHeader`) rather than paired with separate filter inputs: clicking
sorts the already-fetched document list by that column client-side
(`aria-sort` is set on the `Table.Th` to match). Sorting is **multi-column**
(spreadsheet-style), not single-column: the `sort` state is an ORDERED array
of `{ column, direction }` entries, not a single nullable value. Each
column's OWN clicks cycle it through 3 states independent of every other
column - not sorted -> ascending (appended at the end = lowest priority) ->
descending (same array position/priority, direction flipped) -> removed
entirely (back to not sorted) -> ascending again, etc. Clicking a second
column while a first is still active **adds** it as a secondary key (breaking
ties within the first) rather than replacing it - array order is priority
order, first entry compared first, only falling through to the next entry on
a tie (see `sortedDocuments`'s multi-key comparator and `handleSort` in
`UploadPage.tsx`). No sort is applied until a header is first clicked. Status
sorts in pipeline-stage order (`uploaded` -> `chunking` -> `ready` ->
`failed`), not alphabetically, since that groups the two "still processing"
statuses together and reads more usefully for an operator scanning the
table.

Each header's `SortIcon` (hand-rolled SVG, no icon library) makes the
column's current sort state unambiguous via shape **and** color, mapped to
existing theme tokens rather than new hardcoded hex values: a single chevron
pointing up in `signalBlue` for ascending, pointing down in `alertMagenta`
for descending, and a neutral stacked double-chevron in the standard muted/
dimmed text token (`var(--doc-text-muted)`) on every non-active column. The
icon is colored via a wrapping `<span style={{ color }}>` around an SVG using
`stroke="currentColor"` - the same `currentColor`-inherits-from-parent
pattern `PencilIcon`/`TrashIcon` rely on via `ActionIcon`'s `color` prop,
just applied with a plain `span` here since there's no `ActionIcon` wrapper.

Delete (the same Actions-column `TrashIcon` `ActionIcon`) opens the existing
confirm `Modal`, whose Delete button calls `DELETE
/internal/documents/{id}` (`apiClient.deleteDocument`) - a 204 removes the
row from local state; a 409 `document_processing` (blocked while a pipeline
run is actively chunking that document) closes the dialog and surfaces the
same page-level `processingMessage` `Alert` pattern already used for
upload/overwrite conflicts, rather than a dialog-level error state.

### Chunk Preview: Cancel/Discard Confirmation + Bottom Action Bar

`ChunkPreviewPage.tsx`'s Cancel button is `variant="filled"
color="alertMagenta"` - the bold red/pink treatment, by explicit user
direction (an earlier pass had tried the quieter `variant="subtle"
color="signalBlue"` treatment the Buttons section otherwise recommends for a
plain top-level Cancel, matching UploadPage.tsx's confirm-dialog Cancel
buttons; the user looked at it live and asked for red/pink back). Clicking it
still only opens a confirmation when there's actually something to lose: with
no chunk dirty (`chunks.some((chunk) => chunk.isDirty)` is `false`) it
navigates straight to `/upload`; with at least one chunk dirty, it opens a
confirm `Modal` ("Discard changes?") instead, matching UploadPage.tsx's
Delete/Overwrite `Modal` structure (`Modal` > `Stack` > body `Text` +
`Group[justify="flex-end"]` of two `Button`s): a quiet "Keep editing"
(`variant="subtle" color="signalBlue"`, just closes the dialog - the edit is
untouched, still dirty, still in state) and a bold "Discard changes"
(`variant="filled" color="alertMagenta"` - the button that's actually
destructive/confirming, per the Buttons section) that navigates to
`/upload`. Cancel and "Discard changes" now share the same
`filled`/`alertMagenta` styling - that's fine, both represent "leave without
saving," so a single red/pink family reads as coherent, not conflicting. No
API call is made either way - per-chunk edits only ever live in local
`chunks` state until Save calls `apiClient.saveChunks`, so "discarding" is
just choosing not to persist them.

The Escape key is wired to the exact same dirty-check logic as the Cancel
button (a `keydown` listener on `document`, added/removed in a `useEffect`),
with one edge case: if a chunk's `Textarea` is actively focused
(`activeChunkId` set) when Escape is pressed, Escape exits just that chunk's
edit mode first (the same thing its `onBlur` already does) rather than
immediately evaluating the page-level Cancel/discard flow - an operator
mid-edit pressing Escape is far more likely reaching for "stop editing this
chunk" than "leave the page," and this also means Escape can't fire the
discard confirmation out from under an unsaved keystroke the operator hasn't
even finished typing. While the discard-confirm `Modal` is already open, the
listener is a deliberate no-op: Mantine's `Modal` already closes itself on
Escape, so acting on it too would fire two things from one keypress. The
listener's dirty-check is inlined directly in the effect (rather than calling
a shared `handleCancelClick` function) purely so its dependency array can
list the actual state it reads instead of a plain function that's recreated
on every render.

Pagination (Previous / "Page X of Y" / Next, shown only once `pages.length >
1`) lives in the same bottom-anchored row as Cancel/Save, not its own row
floating above it - and is horizontally **centered** in that row, not
left-aligned. Centering it is deliberately NOT the common `Group
justify="space-between"` two-flex-children trick (an empty/pagination
cluster on the left, Cancel/Save on the right) - that only looks centered
when both sides happen to end up similar widths, which isn't guaranteed
here (an empty left side vs. a two-button-wide right side are not
naturally equal). Instead, the row is a plain `Box[position: relative,
display: flex, justifyContent: flex-end]` wrapping the Cancel/Save `Group`
in normal flow, with the pagination `Group` pulled out of flow entirely and
centered via `position: absolute; left: 50%; top: 50%; transform:
translate(-50%, -50%)` - this centers relative to the row's own total
width, correctly, regardless of how wide the Cancel/Save cluster ends up
being (the one Mantine-idiomatic technique that's actually guaranteed
correct here, not just visually close). Previous/Next are `variant="filled"
color="sparkOrange"` - a bold yellow fill matching Save's boldness/family
(clearly distinct from Cancel's red/pink) - plus a felt hover reaction: a
`transform: scale(1.05)` over the standard ~150ms transition (see Motion &
Interaction), applied via a small `.paginationButton` class in
`ChunkPreviewPage.module.css` (`transform` is compositor-only, not a layout
property, so this doesn't conflict with that section's "avoid animating
layout properties for state toggles" guidance - that's about `width`/
`height`), wrapped in `@media (hover: hover)` so touch devices don't get a
"stuck" post-tap scale, the same convention `UploadPage.module.css`'s
Dropzone hover rule already uses. Previous/Next are **hidden, not
disabled**, at each boundary (`pageIndex > 0` / `pageIndex < pages.length -
1` conditionally render the button at all, rather than rendering it
`disabled`) - the "Page X of Y" label simply sits between whichever of the
two buttons happens to be present, rather than the row reserving fixed
space for a grayed-out button.

The whole page disables text selection by default - `userSelect: 'none'` set
inline on the outermost `Stack` returned by `ChunkPreviewPage.tsx` - rather
than patching individual elements one at a time. This started as a narrower
fix scoped only to the main chunk `Text` (a click-drag there was triggering
the browser's translate-selection popup), but the same popup turned out to
be reachable from other text on the page too (the pagination "Page X of Y"
label), which is why the fix is applied page-wide instead: nothing in this
page's non-editing chrome (chunk text when not being edited, filenames,
labels, buttons) is meant to be a text-selectable field, so none of it
should be able to trigger that popup. `userSelect: 'none'` is inherited by
every descendant unless a more specific rule overrides it for that element -
the one exception is the chunk `Textarea` itself in edit mode, which needs
normal text selection/editing to work: its own `styles={{ input: {
userSelect: 'text', ... } }}` sets an inline style directly on the rendered
`<textarea>`, which always wins over an inherited value regardless of the
ancestor's specificity (a directly-matching rule beats inheritance, not a
specificity contest). The minimap's own inline `userSelect: 'none'` (see
above) is now redundant with the page-wide rule but is harmless and was left
as-is rather than removed for its own sake.

Both the read-mode chunk `Text` and the minimap's own miniature copy set
`whiteSpace: 'pre-wrap'` - without it, normal HTML text-flow collapses a
chunk's original line breaks/blank-line paragraph spacing/markdown structure
(blank lines between paragraphs, "> " blockquote lines, "## Section" headers
each on their own line, ...) into one dense run-together block, while a
`<textarea>` (what the same content switches to in edit mode) preserves
whitespace natively regardless of CSS - so without this, clicking a chunk
into or out of edit mode caused a jarring reflow purely from this rendering
difference, not from any actual change to the text. `pre-wrap` (not plain
`pre`) still wraps long lines instead of overflowing horizontally. The
minimap's copy gets the same treatment too, for consistency (a VS Code-style
minimap is meant to mirror the real document's line structure, even at an
illegible size) even though the specific reflow-on-click bug doesn't apply
there - that Text never switches between two different renderings the way
the main column does.

### Chunk Preview: Manual Boundary Resizing (always-mounted editors + persistent marker)

**Revision (2026-08-02, second pass):** superseded a same-day first pass
that replaced per-chunk boxes with one page-spanning free-text `Textarea`
you'd enter via a click, with boundary markers as literal text typed
inline (`splitBySeparator`/`findMarkerOffsets`/`boundaryOffsetsChanged` in
`chunkBoundaryMarker.ts`, now removed - the file keeps only the
`CHUNK_BOUNDARY_MARKER` string constant). Live use showed that regressed
worse than it fixed: the colored per-chunk boxes disappeared entirely the
instant you clicked to edit, and the boundary marker was invisible until
you were already inside that edit mode. The explicit requirement going
forward: **nothing about a chunk's appearance changes between viewing and
editing it, ever** - colors and the boundary marker are visible AT ALL
TIMES, not conjured up by entering some other mode. See
`.claude/specs/manual-chunk-boundaries.md`'s Requirements for the full
history; the backend contract (`manualBoundaries` boolean flag on the save
endpoint) is unaffected by this revision either.

Every chunk is now an ALWAYS-mounted `Textarea` (`variant="unstyled"`, no
border/background of its own, transparent so the parent colored `Box`
shows straight through) sitting directly inside its colored `Box` -
there is no more separate read-mode `Text` vs. edit-mode `Textarea` swap,
and therefore no click-to-enter-edit-mode step at all. Typing anywhere
just types, immediately, the same as a normal text file - `onChange`
updates that chunk's `editedContent`/`isDirty` directly, with no separate
commit/blur step. The minimap now genuinely live-updates per keystroke as
a natural consequence (there's no "last-committed snapshot" to hold onto
anymore - `chunks` state IS the current state).

Between every pair of adjacent chunks, a `BoundaryHandle` is rendered
persistently (`role="separator"`, `aria-orientation="horizontal"`,
`tabIndex={0}` for keyboard operability per this project's accessibility
rule) showing `CHUNK_BOUNDARY_MARKER` as a static label plus a grip icon on
each side - always visible, never tied to any edit state. Dragging it (or
focusing it and pressing ArrowUp/ArrowDown) moves whole lines across the
boundary via `redistributeLines(upperText, lowerText, lineDelta)`
(`frontend/src/utils/redistributeLines.ts`, restored after briefly being
removed during the superseded pass - same pure-function/thorough-unit-test
precedent as `fuzzyMatch.ts`) - positive delta moves lines from the start
of the lower chunk into the end of the upper one (dragging down), negative
the reverse (dragging up), always clamped to whatever's actually available
on the giving side, so it can never produce a negative-length chunk or
invent lines that don't exist. Chunk COUNT never changes via this
mechanism (resize only, not merge/split) - ids are stable, so there's no
need to regenerate them the way the superseded marker-parsing design did.

**Drag mechanics**: `mousedown` on the handle just records where it
started; a `document`-wide `mouseup` listener (not scoped to the thin
handle itself, so the drag still completes if the cursor drifts off it)
computes the final line delta via a fixed `BOUNDARY_DRAG_LINE_HEIGHT_PX`
approximation (not read off real layout via `getBoundingClientRect`) and
commits in one step - a single well-defined state transition, not a
stream of updates on every `mousemove`, which is also what keeps it
reliably testable with plain simulated `clientY` values despite jsdom's
unreliable real layout geometry. The actual redistribution math
(`applyBoundaryDrag` in `ChunkPreviewPage.tsx`) is a module-level pure
function, not a component closure, specifically so the `mouseup` effect
doesn't need it listed as a dependency that's recreated every render.

**State**: a completed drag (mouse or keyboard) that actually moves at
least one line marks both affected chunks `isDirty: true` and sets
`boundariesManuallyAdjusted` to `true` - never reset for the rest of the
session. `handleSave` passes it straight through as
`ApiClient.saveChunks`'s optional third parameter - an ordinary Save where
no boundary was ever dragged sends byte-for-byte the same request it
always has (`manualBoundaries` omitted, not sent as `false`), unchanged
default backend behavior (full algorithmic re-chunk). A drag that resolves
to zero actual movement (e.g. dragged toward a neighbor that's already
empty on the giving side) is a no-op - neither chunk is marked dirty and
the flag stays untouched.

### Dashboard: Stat Cards + Bar Visualization

`DashboardPage.tsx` renders three `StatCard`s (Documents/Events/Event types,
counts derived from `apiClient.listDocuments()`/`getDashboardEvents()`) above
a simple "events by type" bar visualization - plain styled `Box`/`Group`
elements with `width` proportional to count, alternating `signalBlue`/
`sparkOrange` fills with a matching glow. **No charting library dependency**
(recharts/visx/chart.js/...) - this mirrors the original Task 6 rationale in
`.claude/plans/2026-07-31-phase-1-frontend-shell.md`: a small, fixed number
of categories doesn't justify the dependency. If dashboard visualization needs
grow materially (many categories, multiple chart types, tooltips/legends),
that's a deliberate future decision, not a default.

### Icons

- No icon library is currently installed - the two icons in the app (the
  dropzone's upload glyph, the header's `BrandMark`) are small hand-rolled
  inline SVGs rather than a new dependency, consistent with this project's
  YAGNI stance on adding libraries for a handful of static shapes. If broader
  icon needs come up later, prefer `@tabler/icons-react` and update this
  section.

---

## Accessibility

### WCAG 2.1 AA Compliance

- **Color contrast**: 4.5:1 for normal text, 3:1 for large text - see the
  `autoContrast`/`black` note under Color & Theming for how filled-button/
  badge text stays compliant automatically. Verify any new **text**-on-dark
  combination you introduce against `void`/`surface`.
- **Keyboard navigation**: all interactive elements must be focusable and
  operable. Focus rings use `signalBlue` automatically (Mantine's
  `--mantine-primary-color-filled`, driven by `theme.primaryColor`) - don't
  override focus-ring color to orange or magenta.
- **Semantic HTML**: use `<nav>` (`AppShell.Navbar aria-label="Main
  navigation"`), `<main>`, `<button>` vs generic `<div>`.
- **ARIA labels**: required on icon-only/emoji-only buttons (e.g. the
  dislike pill in `ChatPage.tsx` toggles its `aria-label`/`aria-pressed`
  between "Dislike message" and "Message disliked").
- **Decorative content**: the header's status dot + "system ok" text, the
  `BrandMark` SVG, the navbar's dot-grid texture, and the dropzone's upload
  icon are all `aria-hidden="true"` (or, for the SVGs, `aria-hidden` +
  `focusable="false"`) since they convey no real information.

---

## Responsive Design

### Breakpoints

Mantine's default breakpoints; the only one in active use today is `sm`
(`AppShell navbar={{ breakpoint: 'sm' }}`), which collapses the sidebar on
narrow viewports. The dashboard's stat-card row uses `SimpleGrid cols={{
base: 1, sm: 3 }}` so it stacks to a single column on narrow viewports rather
than squeezing three cards into an unreadable width.

### Mobile Adaptations

- Sidebar collapses via `AppShell`'s built-in `breakpoint="sm"` behavior - no
  custom CSS needed.
- Chunks/Chat's `maw={900}` naturally becomes full-width on narrow viewports
  since `max-width` only constrains, never forces, width.

---

## Motion & Interaction

- **Duration**: ~150ms for hover/focus transitions (nav-link hover, the mark's
  border/glow toggle, the dropzone's hover glow); dashboard bars transition
  `width` at 200ms since they represent a value change, not an instantaneous
  state toggle (contrast with the mark, which is intentionally instantaneous
  - see below).
- **Properties**: prefer `background-color`, `color`, `border-color`,
  `box-shadow` - avoid animating layout properties (`width`/`height`) for
  state toggles like the mark, which are meant to read as instantaneous, not
  an animated reveal. The dashboard bars are the one deliberate exception
  (animating `width` there communicates the data changing, which is the
  point).
- No decorative motion beyond the above (no bouncing, pulsing, skeleton
  shimmer, etc.) as of this pass. The one addition since is Upload's
  `StatusBadge` `Loader` spinner (Mantine's built-in spin animation) for
  `uploaded`/`chunking` rows - this is **functional** motion (it communicates
  a genuinely in-progress background process, not a static label) rather than
  decorative, so it doesn't violate this rule; it's the same category as the
  dashboard bars' `width` transition above, not a new exception to it.

---

## Naming Conventions

### Files

- Components: `PascalCase.tsx` (`ChunksPage.tsx`, `AppLayout.tsx`)
- CSS Modules: `ComponentName.module.css` (`AppLayout.module.css`,
  `UploadPage.module.css`)
- Theme: single source of truth at `frontend/src/theme.ts`

### Theme Tokens

```tsx
// Ramp colors (signalBlue / sparkOrange / alertMagenta): Mantine token syntax
color="alertMagenta"  bg="signalBlue.0"  var(--mantine-color-sparkOrange-6)

// Flat tokens (void / surface / text / textMuted / hairline): CSS custom
// properties, or rely on the global remap
// (--mantine-color-body/text/dimmed/gray-3)
var(--doc-void)  var(--doc-surface)  var(--doc-mark-glow)
```

---

## Checklist

Use this before finalizing any UI implementation:

### Visual Quality
- [ ] Uses Mantine components (not raw HTML/divs with inline styles), except
      where the mark, a CSS-variable scoping, or the dashboard bar
      visualization genuinely requires it
- [ ] Uses theme tokens (`theme.ts`), never a new hardcoded hex value
- [ ] The sparkOrange mark, if used, is a left border **plus** glow, applied
      only to an active/edited/contextually-relevant element, and reserves
      its 3px of space even when inactive
- [ ] Mono font applied to data/content being inspected, not to UI chrome
- [ ] Text is noticeably bigger than a typical admin-tool default - don't
      default back to small text out of old habit

### Functionality
- [ ] Loading/empty/error states considered
- [ ] Existing tests (`npm test`) still pass unchanged (or, where a
      structural change like the Dropzone swap genuinely requires it, the
      test is adjusted to keep testing the same behavior/assertion, scoped
      more precisely rather than weakened) - don't restructure DOM in ways
      that silently break `getByRole`/`getByText`/`data-testid` queries

### Responsiveness
- [ ] Works with the sidebar collapsed (`sm` breakpoint and below)
- [ ] Chunks/Chat `maw={900}` respected for new editing/reading surfaces
- [ ] Multi-card layouts (e.g. dashboard stat cards) collapse sensibly on
      narrow viewports (`SimpleGrid` `cols` responsive object)

### Accessibility
- [ ] Keyboard navigable (Tab, Enter, Escape)
- [ ] Focus indicators visible (`signalBlue`, Mantine's default - don't
      override)
- [ ] Color contrast >= 4.5:1 for text, including anything on `void`/`surface`
      backgrounds - filled buttons/badges get this for free via
      `autoContrast`, but check any new **text** usage yourself
- [ ] Icon-only/emoji-only buttons have `aria-label`
- [ ] Purely decorative elements (dot-grid texture, `BrandMark`, dropzone
      icon) are `aria-hidden`

### Polish
- [ ] Hover states on interactive elements (~150ms transitions)
- [ ] No console errors
- [ ] `npm run lint` (oxlint) and `npm run build` (`tsc -b && vite build`)
      both pass
