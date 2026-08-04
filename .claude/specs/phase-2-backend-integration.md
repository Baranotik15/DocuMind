# Phase 2: Backend Integration

## Goal
Replace Phase 1's mock data with a real FastAPI + Celery + Postgres/pgvector
backend for every page the frontend already renders — Upload, Chunks, Chat,
Dashboard — so `frontend/src/api/client.ts`'s `apiClient` binding can move
from `mockApiClient` to a real HTTP client without any page component
changing.

## Requirements

### Upload & storage
- Uploading a file of type PDF, DOCX, Markdown, or plain text stores the raw
  file via the existing `StorageAdapter` (local disk today) and creates a
  document record with status `uploaded`.
- Uploading a file of any other type is rejected with a clear error and no
  document record or stored file is created.
- A successful upload immediately enqueues a background parse-and-chunk job
  on the worker; the API response does not wait for that job to finish.
- Uploading a file whose filename matches an existing document's filename
  does not silently create a duplicate or silently overwrite: the operator
  is shown a confirmation prompt ("a document with this name already
  exists — overwrite it?") before anything changes. Declining leaves the
  existing document untouched and nothing is uploaded. Confirming replaces
  the existing document in place (same document id, stored file replaced)
  and re-runs the full parse-and-chunk-and-embed pipeline on it, using the
  same atomic full-replace behavior specified below for Save. If the
  existing document with that filename is currently `chunking`, the
  overwrite is rejected with the same "still processing" reason as a
  Save/edit attempt below, rather than racing it.
- Listing documents returns every document with its current status and
  upload timestamp, matching the existing `DocumentSummary` shape
  (`id`, `filename`, `status`, `uploadedAt`).
- Document status reflects real pipeline state: `uploaded` (stored, job not
  yet started or running), `chunking` (parse/chunk/embed job in progress),
  `ready` (chunks and embeddings available), or `failed` (the job errored —
  a new status beyond Phase 1's mock three). The error detail for a `failed`
  document is surfaced via its corresponding `chunking failed` dashboard
  event, not a new field on `DocumentSummary`.

### Parsing & chunking (worker)
- The worker extracts plain text from the stored file according to its type
  (PDF, DOCX, Markdown, plain text) and splits it into an ordered sequence
  of chunks, each carrying its position within the document, such that
  concatenating all chunks in order reconstructs the full extracted text.
- The worker generates an embedding for every chunk via the OpenAI
  embeddings API and stores it so chunks are retrievable by similarity
  search (pgvector).
- Job progress and outcome are written directly to Postgres as they happen
  (document status transitions, error detail on failure) — the worker never
  requires querying the broker to know a job's status, consistent with the
  Phase 0 broker-is-transport-only decision.
- A parse or chunk failure — including an embedding-call failure, not just
  text-extraction/splitting errors — sets the document to `failed` with a
  stored error detail and does not leave it stuck in `chunking`
  indefinitely.
- A job that never completes without raising a handled exception (worker
  crash, hang, or timeout) is out of scope for this phase: recovering
  stuck jobs is deferred, and only handled failures are guaranteed to reach
  `failed`.

### Chunk retrieval & save
- Fetching chunks for a document returns them in document order, matching
  the existing `Chunk` shape (`id`, `documentId`, `originalContent`,
  `editedContent`, `isDirty`).
- Saving edited chunks for a document reconstructs the document's full text
  from the *edited* chunk contents (in order), then re-runs the same
  parse-and-chunk-and-embed pipeline over that reconstructed text as a new
  background job, replacing the document's entire chunk set with the fresh
  result. This is a full re-chunk, not a patch of individual chunks: manual
  edits to chunk *text* feed into the new run, but manually-adjusted chunk
  *boundaries* are not preserved across it, since boundaries are
  algorithmically redetermined by the chunker each time.
- Save is asynchronous: it enqueues the re-chunk job and returns without
  waiting for it, moving the document back to `chunking` until the job
  completes (or `failed` if it errors).
- Save is only reachable when the document is `ready` or `failed`;
  triggering it while `uploaded` or `chunking` is rejected, since there is
  no settled chunk set yet to reconstruct from.
- The chunk-set replace is atomic: the previous chunks (and their
  embeddings) are only removed once the new set has been fully written, so
  a concurrent chat or chunk-read request never observes a half-replaced
  set. A second Save for the same document while a re-chunk job is already
  in flight is rejected outright, not queued or allowed to race the first.
- Both rejection cases above (document not yet `ready`, or a re-chunk
  already in flight) are returned as a distinguishable "still processing"
  reason, not a generic error, so the UI can tell the operator to please
  wait for the current job to finish rather than leaving them guessing why
  their edit didn't take.

### Chat (OpenAI, retrieval-augmented)
- Sending a chat message embeds the message (synchronously, in the request
  handler — a deliberate, stated exception to Phase 0's
  background-jobs-only rule, since chat needs a synchronous reply and no
  polling UI exists for it), retrieves a bounded top-k set of the most
  relevant chunks across the document corpus via pgvector similarity
  search, and includes them as context in a call to the OpenAI chat
  completion API. If no document is `ready` yet, retrieval returns no
  context and the call proceeds without it rather than erroring.
- Both the user's message and the resulting assistant reply are persisted
  in the existing `ChatMessage` shape (`id`, `role`, `content`, `disliked`);
  listing chat messages returns the full conversation history in order.
  The endpoint's response is the assistant reply itself (not an echo of the
  user's own message, unlike today's mock).
- If the OpenAI chat completion call fails, the user's message remains
  persisted with no assistant reply added, and the request surfaces an
  error to the caller rather than fabricating a response.
- Disliking a message persists `disliked: true` for that message id and is
  idempotent (disliking an already-disliked message is not an error).
- There is a single ongoing conversation history for this phase, matching
  the current mock and the current `ApiClient` shape (no per-conversation
  id parameter anywhere in it).

### Dashboard & logs
- Every significant pipeline event — document uploaded, chunking started,
  chunking succeeded, chunking failed, chat message sent, message disliked —
  is recorded as a structured row in Postgres as it happens.
- Fetching dashboard events returns them matching the existing
  `DashboardEvent` shape (`id`, `type`, `timestamp`, `detail`), read
  directly from that table — no separate logging stack.

### Contract
- `frontend/src/api/types.ts` and the `ApiClient` interface in
  `frontend/src/api/client.ts` are the source of truth for shapes. Two
  contract changes are introduced by this phase: adding `'failed'` to
  `DocumentSummary['status']`, and `uploadDocument` gaining a way to signal
  "yes, overwrite" on a confirmed duplicate-filename upload (e.g. an
  optional second argument) — everything else keeps its existing signature.
- This phase also adds two small, additive UI touch points that Phase 1's
  mock never modeled: a confirmation prompt on Upload for a duplicate
  filename, and a "please wait, still processing" message when a Save/edit
  or overwrite attempt is rejected as busy. These are new response-handling
  paths, not a restructuring of any existing page — the "swap the binding,
  nothing else changes" premise holds for every other interaction.

## Acceptance Criteria
- [ ] Uploading a valid PDF/DOCX/MD/TXT file creates a document visible via
      list, starts at `uploaded`, moves to `chunking`, and reaches `ready`
      with retrievable chunks once the worker finishes — with no request
      blocking on that processing.
- [ ] Uploading an unsupported file type is rejected synchronously; no
      document record or stored file results.
- [ ] Uploading a file with a filename that matches an existing document
      shows an overwrite confirmation before anything changes; declining
      leaves the existing document and its chunks untouched, confirming
      replaces it in place and re-processes it from `uploaded` through to
      `ready`/`failed`.
- [ ] Attempting to overwrite a document that is currently `chunking` is
      rejected with the same "still processing" reason as a busy Save, not
      raced.
- [ ] A file that fails to parse (e.g. corrupt PDF) leaves its document in
      `failed` with a non-empty error detail, not stuck in `chunking`.
- [ ] Fetching chunks for a `ready` document returns them in order, and
      concatenating `originalContent` across all of them reconstructs the
      extracted document text.
- [ ] Editing chunk text and saving re-chunks the document: the document
      cycles back through `chunking` to `ready`, and the resulting chunk set
      is derived from the edited text (verified by editing text into one
      chunk and confirming it appears in the post-save chunk set).
- [ ] Triggering Save on a document that is `uploaded` or `chunking` (not
      yet `ready`) is rejected rather than reconstructing/re-chunking an
      empty document.
- [ ] Triggering Save a second time while a re-chunk job is already running
      for the same document is rejected; the chunk set is never left
      partially replaced, and a concurrent chunk fetch never sees a mixed
      old/new set.
- [ ] Both busy-Save rejection cases (not yet `ready`, or already
      `chunking`) carry a distinguishable "still processing, please wait"
      reason rather than a generic error.
- [ ] Sending a chat message that references content only present in an
      uploaded document produces a reply that reflects that content
      (retrieval actually influenced the answer, not a generic completion).
- [ ] A chat request whose OpenAI call fails leaves the user's message
      persisted with no assistant reply, and the caller sees an error
      rather than a fabricated response.
- [ ] Listing chat messages after several sends/replies returns the full
      history in order; disliking a message persists across a subsequent
      fetch.
- [ ] Dashboard events reflect real actions taken during a test session
      (an upload, a chunking completion, a chat message) — not the Phase 1
      mock rows.
- [ ] `frontend/src/api/client.ts`'s `apiClient` can be pointed at the real
      backend with no changes to any page component beyond the two additive
      touch points noted in Contract (overwrite confirmation, busy-state
      messaging).

## Non-Goals
- OCR / text extraction from scanned or image-only PDFs — confirmed live
  that such files parse without error but yield only whitespace; they now
  fail cleanly with a specific error (`"No extractable text found..."`)
  instead of silently succeeding with an empty chunk. Real OCR support
  (tesseract or similar, a real image-processing/text-recognition
  pipeline, not a small addition) is explicitly deferred to a future
  phase, not this one.
- Authentication/authorization on these endpoints — `auth.md` is a separate,
  not-yet-planned feature; these endpoints ship open for this phase and get
  gated once that lands.
- Real document deletion — the Upload page's delete-confirmation dialog
  remains a stub; there is no `deleteDocument` method on `ApiClient` today
  and this phase does not add one.
- The chat context-switch interaction (the placeholder slot from Phase 1) —
  still deferred; this phase only wires the message-send/list/dislike flow.
- Incremental/partial re-chunking or re-embedding — Save always does a full
  re-chunk of the document; optimizing to touch only changed regions is out
  of scope.
- Multiple/named chat conversations — a single ongoing history, matching
  today's `ApiClient` shape.
- Migrating the broker to RabbitMQ or deploying to real AWS infrastructure —
  still tracked separately per Phase 0.
- Roles or permission levels of any kind.
- Event-log retention/pruning — the events table grows unbounded for now;
  revisit once real volume makes that a problem.
- Recovering stuck background jobs (worker crash/hang/timeout without a
  raised exception) — only handled failures are guaranteed to reach
  `failed`.

## Open Questions
- None blocking. Scope decisions made explicitly for this spec, recorded
  above rather than left open: no auth gating yet; Save triggers a full
  re-chunk (not a per-chunk patch) and is rejected outright — not queued —
  if the document isn't `ready`/`failed` or a re-chunk is already running.
