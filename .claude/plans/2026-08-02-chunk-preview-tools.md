# Plan: Chunk Preview page - resize/split/delete tools

Status as of 2026-08-02 (end of session): **done, committed, nothing
outstanding.** This file exists mainly as a pointer for a fresh session -
full narrative detail lives in project memory (see
`project_documind_status.md`, `project_documind_manual_chunk_reorder_deferred.md`,
`feedback_scope_creep_risk.md` under this project's memory index).

## What's built (branch `feature/phase-2-backend-integration`)

- `0f7b3b9` - manual chunk boundary resizing: every chunk is a
  plain `<textarea>` (always mounted, always editable), a persistent
  drag handle between adjacent chunks moves whole lines across the
  boundary (mouse, with live preview while dragging, or keyboard
  Arrow-operable), plus ArrowUp/Down/Left/Right crossing chunk
  boundaries seamlessly. Spec: `.claude/specs/manual-chunk-boundaries.md`.
- `4922a77` - two tool buttons (scissors/Split, trash/Delete). Click to
  arm a tool, hover a chunk for a live preview (line indicator for
  Split, red highlight for Delete), click to commit. Split cuts a
  chunk in two at the hovered line. Delete merges the chunk's text
  into the next chunk on the page (not a literal delete - text
  survives), refusing with a toast when there's no next chunk to
  merge into. Both set `boundariesManuallyAdjusted`, so Save sends
  `manualBoundaries: true` afterward - same existing backend contract,
  no backend changes needed for this feature.

Both features are entirely on the frontend, plain-text-only, no rich
formatting. 94/94 frontend tests passing, build/lint clean as of `4922a77`.

## What was tried and reverted (do not re-attempt without discussing first)

A Word-like rich-text editing rewrite (Tiptap, formatting toolbar,
merge/split on that architecture) was built on a separate branch
(`feature/chunk-rich-text-editing`), found several real bugs via live
testing, and was fully deleted at the user's call ("неудачный
эксперимент"). See `feedback_scope_creep_risk.md` in memory before
proposing anything rich-text-related on this page again - the lesson
there is about pacing/checking in during multi-bug-fix sequences, not
that rich text is off the table forever.

## Open items / possible next steps (none requested yet - do not start
   without the user asking)

- Branch is not pushed, no PR opened. Ask before pushing/opening a PR -
  the user hasn't asked for that yet this session.
- Split/Delete tools are scoped to the current pagination page only
  (matching the existing boundary-drag handle's own scope) - crossing a
  page break isn't handled, same Non-Goal as the resize feature.
- No visual/UX polish pass has been requested for the tool buttons'
  placement or the floating cursor icon beyond what's already built -
  if the user reports something looks off, treat as a bug report, not
  a cue to redesign further.
- Backend/worker containers were last rebuilt during the rich-text
  revert cleanup, before this session's `4922a77` - that commit is
  frontend-only, so this is NOT stale, just noting for future
  reference that backend/worker don't hot-reload (no bind mount) and
  need an explicit `docker compose up -d --build backend worker` after
  any actual backend change.

## Follow-up work (same branch, later session): `d692bbb`

- Fixed Delete: deleting the last chunk on a page now merges its text
  into the previous chunk instead of refusing outright - it only
  refuses when a single chunk remains on the page.
- Added Undo/Redo: a shared history stack covers every kind of chunk
  edit (typing, Split, Delete/merge, boundary drag/keyboard-nudge).
  Two toolbar buttons plus Ctrl+Z/Ctrl+Shift+Z. Consecutive keystrokes
  in the same chunk coalesce into one undo step (ends on blur or
  switching chunks).
- Restyled the toolbar: wrapped in a surfaced `Paper` panel (the app's
  existing Cards/Surfaces pattern), Undo/Redo grouped separately from
  Split/Delete behind a hairline divider, hover transitions on all
  four buttons. Undo/Redo were then quieted further (muted at rest,
  signalBlue only on hover) after live testing showed them rendering
  as loud filled circles - see the commit for the root-cause writeup
  (Mantine's disabled-state CSS overriding `variant` on the only two
  buttons in the toolbar that ever pass `disabled`).

104/104 frontend tests passing, lint and build clean. Branch is still
not pushed - user is about to open a PR next.
