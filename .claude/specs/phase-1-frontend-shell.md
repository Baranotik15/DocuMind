# Phase 1: Frontend Shell (Mocked Backend)

## Goal
Build the navigable visual shell of the DocuMind admin panel — Upload,
Chunks, Chat, and Dashboard pages — backed entirely by mock/stub data, so
the UI/UX can be built and reviewed independently of the real backend
integration that follows in a later phase.

## Requirements
- The app has navigation between four pages: Upload, Chunks, Chat, and
  Dashboard, built on the existing React + Mantine shell from Phase 0.
- Upload page shows a file-upload control and a list of documents with
  their status, from mock data.
- Chunks page shows the chunks belonging to a selected document, each
  editable in place, with a Save action present in the UI (its effect can
  be a no-op against mock data for now — real re-chunk-on-save is a later
  phase).
- Chat page shows a mocked conversation (message list + input box), a
  dislike control on assistant messages, and a designated UI area for
  indicating a context change — the exact interaction is deferred; this
  phase only needs the placeholder slot to exist.
- Dashboard page shows mocked tabular/chart data in the style of a
  Grafana-like log/metrics view.
- All page data is sourced from a single, isolated mock-data module — no
  page calls the real FastAPI backend. This module is the seam a later
  phase swaps for real API calls, mirroring how Phase 0 isolated the
  storage and broker seams.
- Runs inside the existing Phase 0 `frontend` Docker service — no new
  services required.

## Acceptance Criteria
- [ ] Navigating between Upload, Chunks, Chat, and Dashboard shows each
      page's distinct layout.
- [ ] Upload page renders a mocked document list and an upload control.
- [ ] Chunks page renders mocked chunks for a document, allows in-place
      editing, and shows a Save control.
- [ ] Chat page renders a mocked conversation with a dislike control per
      assistant message and a visible placeholder for context-change
      indication.
- [ ] Dashboard page renders mocked table/chart data.
- [ ] No network request in any page reaches the FastAPI backend; every
      page's data traces back to one mock-data module.
- [ ] `docker compose up -d` continues to serve the frontend at
      http://localhost:5173 with no new services added.

## Non-Goals
- Real integration with the FastAPI backend (no real fetch calls to
  `/internal/...` or future real endpoints) — a later phase.
- Real authentication/login UI — covered separately by
  `.claude/specs/auth.md`, not built here; the shell renders as if already
  authenticated.
- Real document parsing, chunking, or chat/LLM logic — backend-side work,
  out of scope for this frontend-only phase.
- Final visual polish/branding — this phase establishes structure and
  navigation; refinement is a later pass.
- The chat context-switch interaction's actual behavior — only a
  placeholder slot is required here; the mechanic itself is designed later.

## Open Questions
- None blocking. The chat context-switch mechanic is intentionally
  unresolved until the phase that wires up real chat.
