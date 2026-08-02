# Manual Chunk Boundaries

## Goal
Let an operator manually resize where one chunk ends and the next begins on
the Chunk Preview page, and have that manual boundary placement survive
Save — instead of Save always discarding boundaries via a full algorithmic
re-chunk, per the existing default behavior.

## Requirements

**Revision history:**
- First pass: a small draggable handle between fixed, independently-boxed
  chunks (colors/marker only visible in read mode).
- Second pass (same day): replaced with one page-spanning free-text
  surface entered via a click, with the boundary marker typed inline as
  literal text, re-parsed on blur. Superseded — live use showed the
  colored per-chunk boxes disappearing entirely on click, and the marker
  being invisible until already inside that mode, was worse than the
  problem it solved.
- **Current (2026-08-02, final for this pass):** every chunk is an
  ALWAYS-mounted, always-editable, always-colored text box — there is no
  "read mode" vs "edit mode" distinction left at all, and therefore
  nothing about a chunk's appearance ever changes on click/focus. The
  boundary marker is a permanently-visible label (not text a user types)
  attached to a persistent, always-present drag handle between each pair
  of adjacent chunks. This is the design actually built - see
  `.claude/context/design-principles.md`'s "Chunk Preview: Manual Boundary
  Resizing" subsection for full implementation detail.
- Across all three passes, the backend contract has been stable and
  unchanged: a `manualBoundaries: boolean` flag on the existing save
  endpoint (see next section) — never a literal token/marker traveling
  over the wire or persisted anywhere.

**Current design:**
- Every chunk renders as its own colored box (unchanged from the
  project's original chunk-preview visual language) containing an
  always-mounted, always-editable text field bound directly to that
  chunk's content — typing anywhere just types, immediately, like an
  ordinary text file, with no click-to-enter-edit-mode step and no
  separate "commit" step.
- Between every pair of adjacent chunks, a persistent boundary handle is
  always rendered (never hidden, never tied to any mode) showing the
  boundary-marker word as a static label, plus a grip affordance.
  Dragging it (mouse) or operating it via keyboard (Arrow keys, for
  accessibility) moves whole lines of text across that specific boundary
  — from the end of the chunk above into the start of the chunk below, or
  the reverse — always clamped to what's actually available, so it can
  never produce a negative-length chunk. This only ever resizes the two
  immediate neighbor chunks; it does not merge or split chunks (chunk
  count is stable), and does not reach a third chunk in one gesture.
- A boundary resize that actually moves at least one line marks both
  affected chunks dirty and sets a session-level "boundaries manually
  adjusted" flag — sticky for the rest of the editing session, never
  reset back to false once set.
- Once that flag is set, Save sends the operator's exact chunk array with
  `manualBoundaries: true` and skips the automatic chunking algorithm
  entirely for this Save — every chunk in the array is embedded as-is. If
  no boundary was ever resized this session (only in-place chunk text was
  edited, if anything), Save behaves exactly as before: full text
  reconstruction + full algorithmic re-chunk.

## Acceptance Criteria
- [x] Every chunk's colored box and its text are visible and directly
      editable at all times — nothing about the page's appearance changes
      between "just looking at it" and "actively typing in it."
- [x] A boundary handle with a visible marker label sits between every
      pair of adjacent chunks at all times, draggable (mouse) and
      operable (keyboard) to resize the two chunks on either side of it.
- [x] Saving after at least one boundary resize sends the exact chunk
      array to the backend with `manualBoundaries: true`; the backend
      embeds exactly those chunks without re-running the automatic
      chunker (built and passing on the backend side).
- [x] Saving with no boundary ever resized behaves identically to before
      this feature existed — full text reconstruction, full algorithmic
      re-chunk.

## Non-Goals
- Merging or splitting chunks (changing chunk COUNT) — this pass is
  resize-only, between two existing immediate neighbors. A literal
  merge/split mechanic (what the first two superseded passes attempted in
  different ways) is a possible future extension, not built here.
- Cross-page-boundary dragging (resizing across a pagination page break,
  for a document split into multiple preview pages) — out of scope.
- Undo/redo beyond the browser's native behavior, or a way to reset all
  manually-adjusted boundaries back to the algorithm's original split
  without discarding other unrelated text edits in the same session.
- Any change to how the *initial* automatic chunking algorithm splits a
  freshly uploaded or fully-Cancel-and-reopened document — this feature
  only affects boundaries an operator has explicitly resized in the
  current editing session.
- A literal separator token traveling over the wire or being persisted
  anywhere in the database — the marker is a frontend-only visual label
  on the drag handle, never chunk content, across every revision of this
  feature.

## Open Questions
- None blocking.
