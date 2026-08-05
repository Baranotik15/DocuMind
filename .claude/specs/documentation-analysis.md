# Documentation Analysis Report

## Goal
Give an operator a way to trigger an AI-generated report, from the
Improvements page's "Analysis" sub-tab, that surfaces (1) documentation
topics worth adding based on where the chat assistant has been failing
users, and (2) factual contradictions between different uploaded
documents - so they know what to fix without manually cross-referencing
every file.

## Requirements
- The "Analyze with AI" button (currently inert) triggers a new analysis
  run.
- Each run produces one report with two sections:
  - Gap analysis: themes/topics worth documenting, derived from the
    Dislikes and No Answer questions (see the Improvements page's Lists
    sub-tab).
  - Conflict detection: pairs of chunks from different uploaded
    documents that state contradictory facts, with enough detail (which
    documents, which chunks, what the conflict is) for an operator to
    act on it, and a way to navigate to the source chunks.
- Analysis runs in the background (it involves multiple LLM calls and
  can take a while) - the UI must reflect that a run is in progress and
  must not block the rest of the app while it runs.
- Every completed report is persisted permanently as part of a history -
  nothing is overwritten or discarded. Each stored report records at
  least: when it ran, and which user ran it.
- The Analysis sub-tab shows the most recent report by default, plus a
  way to browse and view any past report from its history, not just the
  latest one.
- Every analysis run is recorded as an entry on the existing Logs &
  Stats page's Logs tab, including which user ran it and how many LLM
  tokens the run consumed.
- Conflict detection is scoped to pairs of chunks belonging to two
  different documents - never two chunks within the same document.
- Analysis only considers `ready` documents (the same corpus already
  used for chat retrieval and Relevance Preview) - documents still
  uploading/chunking/failed are excluded.
- Report visibility is unscoped/shared across all operators (consistent
  with this app's existing Chat/Dislikes/Logs behavior, which has no
  per-user data isolation) - "which user ran it" is attribution, not an
  access restriction.

## Acceptance Criteria
- [ ] Clicking "Analyze with AI" starts a new run and the button/UI
      clearly shows a run is in progress (and prevents starting a second
      run concurrently).
- [ ] Once a run finishes, its report appears in the Analysis sub-tab
      automatically (or via a clear "done" indicator) without requiring
      a full page reload.
- [ ] The report's gap-analysis section lists documentation
      topics/themes derived from the current Dislikes + No Answer data
      at the time the run started.
- [ ] The report's conflict section lists every detected cross-document
      contradiction found for that run, or clearly states none were
      found.
- [ ] A history of every past report is browsable from the Analysis
      sub-tab and each one can be reopened and read in full.
- [ ] Every report in the history shows when it ran and who ran it.
- [ ] The Logs tab shows one entry per analysis run, including the token
      count that run consumed and who ran it.
- [ ] Running analysis when there are zero ready documents, or zero
      Dislikes/No Answer entries, still completes and produces a report
      that plainly reflects that (not an error).

## Non-Goals
- Automatic/scheduled analysis runs - every run is manually triggered by
  clicking the button.
- Editing or deleting past reports from the history - the history is
  append-only.
- Acting on a report's findings automatically (e.g. auto-editing
  documents, auto-dismissing Dislikes/No Answer entries) - the report is
  informational only.
- Per-user restrictions on who can trigger a run or view report history
  - unscoped, matching the rest of this app.
- Any change to how conflicts/gaps are detected beyond the two-stage
  approach already agreed (pgvector similarity for candidate
  cross-document chunk pairs, LLM judgment only on those candidates) -
  not a full pairwise LLM sweep, not a different detection strategy.

## Open Questions
- None blocking - detection strategy, persistence, and logging
  requirements were already settled in discussion with the user before
  this spec was written.
