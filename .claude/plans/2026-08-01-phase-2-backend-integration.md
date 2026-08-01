# Phase 2: Backend Integration — Implementation Plan

> **For Claude:** This project does not use `superpowers:executing-plans`.
> Execute via `/work`, one task at a time, on branch
> `feature/phase-2-backend-integration` (branched from `development`, per
> `.claude/docs/git-workflow.md`). Per standing project convention:
> implement exactly one task, commit it, report, and **stop** — wait for
> explicit user go-ahead before starting the next task. Tasks are mixed
> domain: route each one through the agent named in that task's **Agent**
> line, per `CLAUDE.md`'s Agent Routing table (`database-architect` for
> schema/migrations, `backend-api` for FastAPI/Celery, `web-frontend` for
> React/Mantine) — not a generic subagent. Push after each task so it's
> reviewable; per default project convention this phase gets a PR reviewed
> and merged per task (unless told otherwise). The user merges PRs, not
> Claude — verify a branch is actually merged via `git fetch` before
> starting work that depends on it, don't take it on trust.

**Goal:** Implement the real FastAPI + Celery + Postgres/pgvector backend
specified in `.claude/specs/phase-2-backend-integration.md`, and swap
`frontend/src/api/client.ts`'s `apiClient` binding from `mockApiClient` to
it, so Upload, Chunks, Chat, and Dashboard are backed by real data.

**Architecture:** Four new tables (`documents`, `chunks` with a pgvector
`embedding` column, `chat_messages`, `dashboard_events`), raw SQL via
SQLAlchemy `text()` throughout (no ORM models — matches the existing
`smoke_jobs` precedent). A single Celery task (`run_document_pipeline`)
handles both initial parse-and-chunk and Save-triggered full re-chunk,
delegating to a shared, directly-unit-testable `app/pipeline.py` function.
Endpoints live in three new `APIRouter` modules (`documents`, `chat`,
`dashboard`) mounted under the existing `/internal/` prefix. Vector
similarity uses plain `<=>` SQL with manually-formatted `vector` literals
(no driver-level pgvector codec registration — see Task 5's note on why).
Frontend changes are additive: a new `httpClient.ts` implementing the
existing `ApiClient` interface, plus small UI updates for the two
interactions Phase 1 never modeled (duplicate-filename overwrite,
busy-state messaging) and one necessary fix to `ChatPage.tsx`'s send flow.

**Tech Stack:** FastAPI, Celery, SQLAlchemy (`text()`, no ORM), Alembic,
`pgvector` (Postgres extension + the `pgvector` PyPI package for the
Alembic column type only), OpenAI Python SDK, `pypdf`, `python-docx`,
pytest. React, Mantine, `fetch` (no new HTTP library).

---

## Task 1: Schema migration — documents, chunks, chat_messages, dashboard_events

**Agent:** `database-architect`

**Files:**
- Create: `backend/alembic/versions/0003_documents_chunks_chat_dashboard.py`
- Modify: `backend/requirements.txt` (add `pgvector`)
- Test: `backend/tests/test_schema.py`
- Reference: `backend/alembic/versions/0002_smoke_jobs.py` (revision
  header/downgrade pattern), `backend/tests/test_db.py` (DB-check pattern)

**Contracts:**

```python
# backend/alembic/versions/0003_documents_chunks_chat_dashboard.py
# revision = "0003", down_revision = "0002"
#
# documents:
#   id UUID PK default gen_random_uuid()
#   filename TEXT NOT NULL UNIQUE
#   storage_key TEXT NOT NULL
#   status TEXT NOT NULL DEFAULT 'uploaded'
#   uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
#
# chunks:
#   id UUID PK default gen_random_uuid()
#   document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE
#   position INTEGER NOT NULL
#   original_content TEXT NOT NULL
#   edited_content TEXT NOT NULL
#   embedding VECTOR(1536) NOT NULL   -- pgvector.sqlalchemy.Vector(1536);
#                                     -- 1536 = text-embedding-3-small's
#                                     -- output dimension (Task 2's default
#                                     -- model) - if that model config
#                                     -- default ever changes, this column
#                                     -- width must change with it.
#   UNIQUE(document_id, position)
#
# chat_messages:
#   id UUID PK default gen_random_uuid()
#   role TEXT NOT NULL
#   content TEXT NOT NULL
#   disliked BOOLEAN NOT NULL DEFAULT false
#   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
#
# dashboard_events:
#   id UUID PK default gen_random_uuid()
#   type TEXT NOT NULL
#   detail TEXT NOT NULL
#   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
#
# No ANN index (ivfflat/hnsw) on chunks.embedding for this phase - a plain
# sequential scan is fine at MVP corpus size; add one later if it's ever
# needed, per the spec's Non-Goal on premature optimization.
```

**Integration:**
- `filename UNIQUE` is the enforcement mechanism behind the spec's
  duplicate-filename requirement (Task 6 branches on whether an INSERT
  would violate it).
- `downgrade()` drops all four tables in reverse dependency order
  (`chunks` before `documents`, per the FK).

**Step 1: Write the failing test**

`test_schema.py`: after running migrations, query
`information_schema.columns` (or attempt a trivial `INSERT`/`SELECT`) to
assert all four tables exist with their expected columns, and that
inserting a second `documents` row with a filename that already exists
raises an integrity error.

Run: `pytest backend/tests/test_schema.py -v`
Expected: FAIL (tables don't exist yet)

**Step 2: Implement**

Add `pgvector` to `requirements.txt`. Write the migration per the contract
above, following `0002_smoke_jobs.py`'s revision-header style.

Run: `alembic upgrade head` (against the docker-compose Postgres)
Expected: succeeds, no errors

**Step 3: Verify**

Run: `pytest backend/tests/test_schema.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/alembic/versions/0003_documents_chunks_chat_dashboard.py backend/requirements.txt backend/tests/test_schema.py
git commit -m "feat: add documents, chunks, chat_messages, dashboard_events tables"
```

---

## Task 2: OpenAI client wrapper

**Agent:** `backend-api`

**Files:**
- Modify: `backend/requirements.txt` (add `openai`)
- Modify: `backend/app/config.py`
- Create: `backend/app/llm.py`
- Create: `backend/app/vectors.py`
- Test: `backend/tests/test_llm.py`
- Test: `backend/tests/test_vectors.py`

**Contracts:**

```python
# backend/app/config.py — new fields on Settings
openai_api_key: str = ""
openai_embedding_model: str = "text-embedding-3-small"
openai_chat_model: str = "gpt-4o-mini"
chat_retrieval_top_k: int = 5
```

```python
# backend/app/vectors.py
def format_vector(values: list[float]) -> str:
    """Formats an embedding as a pgvector text literal, e.g. "[0.1,0.2]",
    for use in a raw SQL `:param::vector` cast. Uses repr() per float so
    formatting is deterministic (no locale/rounding surprises)."""
```

```python
# backend/app/llm.py
class LLMError(Exception):
    """Wraps any OpenAI SDK failure from embed_texts/generate_reply so
    callers never need to catch the SDK's own exception types."""

@lru_cache
def get_client() -> AsyncOpenAI: ...
# Constructs AsyncOpenAI(api_key=get_settings().openai_api_key), cached.

async def embed_texts(
    texts: list[str], client: AsyncOpenAI | None = None
) -> list[list[float]]:
    """Embeds `texts` via get_settings().openai_embedding_model, in one
    batched API call, returning vectors in the same order as `texts`.
    Raises LLMError on any SDK failure. `client` defaults to get_client()
    - tests inject a fake."""

async def generate_reply(
    user_message: str, context_chunks: list[str], client: AsyncOpenAI | None = None
) -> str:
    """Calls get_settings().openai_chat_model with `context_chunks`
    included as context (e.g. a system message listing them) plus
    `user_message`, returns the completion text. Raises LLMError on any
    SDK failure. Empty `context_chunks` is valid (empty-corpus case) - the
    call proceeds without retrieved context."""
```

**Integration:**
- Task 5's pipeline calls `embed_texts` (via `asyncio.run`, since Celery
  tasks are sync). Task 8's chat endpoint calls both `embed_texts` (to
  embed the incoming message) and `generate_reply` directly (FastAPI is
  already async).
- `format_vector` is used by both Task 5 (INSERT) and Task 8 (similarity
  SELECT) so embeddings are formatted identically everywhere.

**Step 1: Write the failing test**

`test_vectors.py`: `format_vector([0.1, -0.2, 3.0])` returns a string
matching the `[n,n,n]` pattern parseable back to the same floats.

`test_llm.py`: inject a fake `client` whose `.embeddings.create` /
`.chat.completions.create` are `AsyncMock`s. Assert `embed_texts` returns
vectors in input order and calls the client with all input texts in one
call. Assert `generate_reply` returns the mocked completion's text content
and that the request included the context chunks. Assert both raise
`LLMError` when the mocked client raises.

Run: `pytest backend/tests/test_llm.py backend/tests/test_vectors.py -v`
Expected: FAIL (modules don't exist)

**Step 2: Implement**

Add `openai` to `requirements.txt`. Implement per the contracts above.

**Step 3: Verify**

Run: `pytest backend/tests/test_llm.py backend/tests/test_vectors.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/llm.py backend/app/vectors.py backend/app/config.py backend/requirements.txt backend/tests/test_llm.py backend/tests/test_vectors.py
git commit -m "feat: add OpenAI client wrapper for embeddings and chat completion"
```

---

## Task 3: Document text extraction + chunking

**Agent:** `backend-api`

**Files:**
- Modify: `backend/requirements.txt` (add `pypdf`, `python-docx`)
- Create: `backend/app/documents.py`
- Test: `backend/tests/test_documents.py`
- Test fixture: `backend/tests/fixtures/sample.pdf` (small checked-in PDF
  with known text content, for the `.pdf` extraction test — `.docx`/`.md`/
  `.txt` fixtures can be generated in-test instead, e.g. via
  `python-docx`'s own `Document()` writer for `.docx`)

**Contracts:**

```python
# backend/app/documents.py
class UnsupportedFileTypeError(Exception):
    """Raised by extract_text for any extension other than .pdf, .docx,
    .md, .txt (case-insensitive)."""

def extract_text(filename: str, data: bytes) -> str:
    """Extracts plain text from `data` based on filename's extension.
    .pdf via pypdf, .docx via python-docx, .md/.txt via UTF-8 decode."""

def split_into_chunks(text: str, max_chars: int = 1500) -> list[str]:
    """Splits `text` into an ordered list of chunk strings such that
    "".join(chunks) == text EXACTLY - boundary-insertion only, no
    trimming/normalization (this is a hard contract: the spec's
    acceptance criteria depend on exact reconstruction). Prefers
    paragraph (blank-line) boundaries; a paragraph longer than max_chars
    is hard-split further (e.g. at sentence boundaries, falling back to a
    raw character cut) without dropping any characters."""
```

**Integration:**
- Task 5's pipeline calls `extract_text` (initial-processing path only)
  then `split_into_chunks` (both paths).

**Step 1: Write the failing test**

`test_documents.py`:
- `extract_text` returns exact content for `.txt`/`.md` inputs; returns
  the known text for the `.pdf` fixture; returns the known text for an
  in-test-generated `.docx`; raises `UnsupportedFileTypeError` for e.g.
  `.exe`.
- `split_into_chunks`: for several inputs (short text under the limit,
  multi-paragraph text over the limit, one huge paragraph with no blank
  lines, empty string), assert `"".join(result) == input` exactly, and
  that no individual chunk except possibly the last exceeds `max_chars` by
  more than one paragraph's worth (document the actual guarantee you
  implement here rather than an exact bound, since paragraph-preservation
  and the hard max_chars cap can be in tension for large single
  paragraphs).

Run: `pytest backend/tests/test_documents.py -v`
Expected: FAIL (module doesn't exist)

**Step 2: Implement**

Add `pypdf`, `python-docx` to `requirements.txt`. Implement per contract.

**Step 3: Verify**

Run: `pytest backend/tests/test_documents.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/documents.py backend/tests/test_documents.py backend/tests/fixtures/sample.pdf backend/requirements.txt
git commit -m "feat: add document text extraction and chunking"
```

---

## Task 4: Storage + settings wiring

**Agent:** `backend-api`

**Files:**
- Modify: `backend/app/config.py`
- Create: `backend/app/deps.py`
- Test: `backend/tests/test_deps.py`

**Contracts:**

```python
# backend/app/config.py — new field on Settings
storage_base_dir: str = "./data/documents"
```

```python
# backend/app/deps.py
def get_storage() -> StorageAdapter:
    """Returns a LocalDiskStorage rooted at get_settings().storage_base_dir,
    creating the directory if needed. FastAPI dependency for endpoints;
    Celery tasks (Task 5) call this directly (not via Depends)."""
```

**Step 1: Write the failing test**

`test_deps.py`: `get_storage()` returns an object conforming to
`StorageAdapter` (`save`/`read`/`delete` round-trip works against a
`tmp_path`-overridden `storage_base_dir`, via monkeypatching settings).

Run: `pytest backend/tests/test_deps.py -v`
Expected: FAIL (module doesn't exist)

**Step 2: Implement**

Implement per contract, reusing `app.storage.LocalDiskStorage`.

**Step 3: Verify**

Run: `pytest backend/tests/test_deps.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/deps.py backend/app/config.py backend/tests/test_deps.py
git commit -m "feat: add storage dependency wiring"
```

---

## Task 5: Document processing pipeline (Celery task)

**Agent:** `backend-api`

**Files:**
- Create: `backend/app/events.py`
- Create: `backend/app/pipeline.py`
- Modify: `backend/app/tasks.py`
- Test: `backend/tests/test_pipeline.py`
- Test: `backend/tests/test_events.py`
- Reference: `backend/app/tasks.py`'s existing `run_smoke_job` (sync
  session, direct UPDATE, no broker status query), `backend/tests/test_smoke_job.py`
  (Celery-eager test pattern)

**Contracts:**

```python
# backend/app/events.py
def record_event_sync(session: Session, event_type: str, detail: str) -> None:
    """INSERTs one row into dashboard_events. Does not commit - caller
    controls the transaction boundary."""

async def record_event_async(session: AsyncSession, event_type: str, detail: str) -> None:
    """Async counterpart, same contract, for FastAPI endpoints."""
```

```python
# backend/app/pipeline.py
class DocumentProcessingError(Exception): ...

def run_pipeline(document_id: str, source_text: str, session: Session) -> None:
    """Core parse-independent pipeline, shared by initial processing and
    Save-triggered re-chunk:
    1. UPDATE documents SET status='chunking' WHERE id=:id; record_event_sync
       (document.chunking_started); commit. (Caller is responsible for
       having already confirmed no other pipeline is running for this
       document - Task 4/7's CAS guard for re-chunk, trivially true for a
       brand-new upload.)
    2. chunks = split_into_chunks(source_text); embeddings =
       asyncio.run(embed_texts(chunks)) (isolates the one async call in
       this otherwise-sync function).
    3. In one transaction: DELETE FROM chunks WHERE document_id=:id;
       INSERT each chunk (original_content = edited_content = the chunk
       text, position = its index, embedding via vectors.format_vector
       cast with `::vector`); UPDATE documents SET status='ready';
       record_event_sync(document.chunking_succeeded); commit. This is
       the atomic full-replace the spec requires - old rows are never
       visible-but-stale and never removed before the new set is ready to
       insert.
    4. On any exception in steps 2-3: session.rollback(); in a fresh
       statement, UPDATE documents SET status='failed';
       record_event_sync(document.chunking_failed, detail=str(exc));
       commit; re-raise as DocumentProcessingError (chains the original
       exception) so Celery logs it."""
```

```python
# backend/app/tasks.py — new task
@celery_app.task(name="run_document_pipeline")
def run_document_pipeline(document_id: str, source_text: str | None = None) -> None:
    """If source_text is None (initial-processing path): opens a
    SyncSessionLocal, reads the document's filename/storage_key, reads the
    file via deps.get_storage(), calls documents.extract_text, then calls
    run_pipeline with the result. If source_text is given (re-chunk path,
    Task 7): calls run_pipeline directly with it, no storage access."""
```

**Integration:**
- Task 6 enqueues this task with `source_text=None` right after a fresh
  upload's INSERT.
- Task 7 enqueues it with the reconstructed edited text, after its own CAS
  status-guard UPDATE (see Task 7 - `run_pipeline`'s own
  `status='chunking'` UPDATE in step 1 is then a harmless no-op re-write).
- `vectors.format_vector` (Task 2) formats each embedding for the INSERT.

**Step 1: Write the failing test**

`test_events.py`: `record_event_sync`/`record_event_async` insert a row
readable back via a plain `SELECT`.

`test_pipeline.py` (using the `_celery_eager` fixture pattern from
`test_smoke_job.py`, plus a real Postgres test DB — insert a `documents`
row first via raw SQL): `run_pipeline` on simple multi-paragraph
`source_text` leaves the document `ready`, with chunks in `chunks` whose
`edited_content` concatenates back to `source_text`, each with a non-null
`embedding` (mock `embed_texts` at the `app.pipeline` import site so no
real OpenAI call happens - external boundary, per `.claude/docs/testing.md`).
A second test forces `embed_texts` to raise - assert the document ends
`failed` with a non-empty error captured in a `chunking_failed` dashboard
event, and no partial/old-mixed-with-new chunk rows exist afterward.

Run: `pytest backend/tests/test_pipeline.py backend/tests/test_events.py -v`
Expected: FAIL (modules don't exist)

**Step 2: Implement**

Implement per contracts above.

**Step 3: Verify**

Run: `pytest backend/tests/test_pipeline.py backend/tests/test_events.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/events.py backend/app/pipeline.py backend/app/tasks.py backend/tests/test_pipeline.py backend/tests/test_events.py
git commit -m "feat: add document processing pipeline (parse, chunk, embed, atomic replace)"
```

---

## Task 6: Documents router — upload (with overwrite confirmation) + list

**Agent:** `backend-api`

**Files:**
- Create: `backend/app/routers/__init__.py`
- Create: `backend/app/routers/documents.py`
- Modify: `backend/app/main.py` (CORS middleware, mount router)
- Test: `backend/tests/test_documents_router.py`

**Contracts:**

```python
# backend/app/main.py — additions to create_app()
# app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"],
#                     allow_methods=["*"], allow_headers=["*"])
# app.include_router(documents.router, prefix="/internal")
```

```python
# backend/app/routers/documents.py
router = APIRouter()

@router.post("/documents")
async def upload_document(
    file: UploadFile,
    overwrite: bool = Form(False),
    session: AsyncSession = Depends(get_session),
    storage: StorageAdapter = Depends(get_storage),
) -> dict:
    """Validates extension (.pdf/.docx/.md/.txt via documents.extract_text's
    supported set - reject unsupported with 400 before touching storage/DB).
    SELECTs any existing document by filename:
    - none found: INSERT (status='uploaded'), storage.save, record_event_async
      (document.uploaded), commit, enqueue run_document_pipeline.delay(id),
      return the DocumentSummary dict (id, filename, status, uploadedAt).
    - found, status == 'chunking': raise HTTPException(409,
      {"detail": "document_processing"}) regardless of `overwrite`.
    - found, not overwrite: raise HTTPException(409,
      {"detail": "duplicate_filename"}).
    - found, overwrite and not chunking: storage.save (same key), UPDATE
      the existing row (status='uploaded'), record_event_async
      (document.uploaded), commit, enqueue the pipeline task, return the
      DocumentSummary (same id as before)."""

@router.get("/documents")
async def list_documents(session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns every document as a DocumentSummary dict, ordered by
    uploaded_at."""
```

**Integration:**
- Response dicts are hand-built with the exact camelCase keys the
  frontend's `DocumentSummary` expects (`id`, `filename`, `status`,
  `uploadedAt`) — matching the existing no-Pydantic-response-model
  convention in `main.py`, not introducing one here.
- `run_document_pipeline.delay(document_id)` (positional-only `source_text`
  omitted -> `None` default) is Task 5's task.

**Step 1: Write the failing test**

`test_documents_router.py` (Celery-eager fixture, real test file bytes):
- Uploading a `.txt` file returns 200 with `status` starting at `uploaded`
  or already `ready` (eager Celery completes inline) and appears in
  `GET /internal/documents`.
- Uploading an unsupported extension returns 400 and does not appear in
  the list.
- Uploading a second file with the same filename without `overwrite`
  returns 409 `{"detail": "duplicate_filename"}` and the original is
  unchanged.
- Uploading again with `overwrite=true` succeeds and reuses the same `id`.
- Uploading with `overwrite=true` while the existing document's status is
  forced to `chunking` (seed it directly via SQL in the test) returns 409
  `{"detail": "document_processing"}`.

Run: `pytest backend/tests/test_documents_router.py -v`
Expected: FAIL (router doesn't exist)

**Step 2: Implement**

Implement per contracts; wire CORS + router into `main.py`.

**Step 3: Verify**

Run: `pytest backend/tests/test_documents_router.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/routers backend/app/main.py backend/tests/test_documents_router.py
git commit -m "feat: add document upload (with overwrite confirmation) and list endpoints"
```

---

## Task 7: Chunk retrieval + save (full re-chunk with busy guard)

**Agent:** `backend-api`

**Files:**
- Modify: `backend/app/routers/documents.py`
- Test: `backend/tests/test_chunks_router.py`

**Contracts:**

```python
# backend/app/routers/documents.py — additions

class ChunkIn(BaseModel):
    editedContent: str
    # id/originalContent/isDirty are accepted but ignored - re-chunk
    # discards prior chunk identity/boundaries per the spec.

class SaveChunksRequest(BaseModel):
    chunks: list[ChunkIn]

@router.get("/documents/{document_id}/chunks")
async def get_chunks(document_id: str, session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns chunks for document_id ordered by position, as
    {id, documentId, originalContent, editedContent, isDirty: False}."""

@router.post("/documents/{document_id}/chunks", status_code=202)
async def save_chunks(
    document_id: str, body: SaveChunksRequest, session: AsyncSession = Depends(get_session)
) -> None:
    """Atomic compare-and-swap: UPDATE documents SET status='chunking'
    WHERE id=:id AND status IN ('ready','failed') RETURNING id. If no row
    returned, raise HTTPException(409, {"detail": "document_processing"})
    - covers both 'not ready yet' and 'already chunking' in one guarded
    statement, closing the race the spec calls out. On success: commit,
    reconstruct source_text = "".join(c.editedContent for c in body.chunks)
    (request order == document order, as sent by the frontend), enqueue
    run_document_pipeline.delay(document_id, source_text), return (202,
    empty body)."""
```

**Integration:**
- Reuses Task 5's `run_document_pipeline`/`run_pipeline` — this task's job
  is entirely the HTTP-layer guard + reconstruction + enqueue.

**Step 1: Write the failing test**

`test_chunks_router.py` (Celery-eager, seed a `ready` document with chunks
via the pipeline or direct SQL):
- `GET .../chunks` returns them in position order with `isDirty: false`.
- `POST .../chunks` with edited content re-chunks: document ends back at
  `ready` (eager Celery), and the new chunk set's concatenated
  `editedContent` matches what was sent, not the pre-edit original.
- `POST .../chunks` for a document currently `uploaded` (seed directly,
  don't let the pipeline finish) returns 409
  `{"detail": "document_processing"}` and does not touch existing chunks.
- Simulating a second concurrent `POST .../chunks` while status is
  `chunking` (seed status directly) also returns 409 with the same
  `detail`, proving the guard, not just the not-ready case.

Run: `pytest backend/tests/test_chunks_router.py -v`
Expected: FAIL (endpoints don't exist)

**Step 2: Implement**

Implement per contract.

**Step 3: Verify**

Run: `pytest backend/tests/test_chunks_router.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/routers/documents.py backend/tests/test_chunks_router.py
git commit -m "feat: add chunk retrieval and full-re-chunk save endpoints"
```

---

## Task 8: Chat router (retrieval-augmented)

**Agent:** `backend-api`

**Files:**
- Create: `backend/app/routers/chat.py`
- Modify: `backend/app/main.py` (mount router)
- Test: `backend/tests/test_chat_router.py`

**Contracts:**

```python
# backend/app/routers/chat.py
router = APIRouter()

class SendMessageRequest(BaseModel):
    content: str

@router.post("/chat/messages")
async def send_message(
    body: SendMessageRequest, session: AsyncSession = Depends(get_session)
) -> dict:
    """1. INSERT the user message (role='user'), commit immediately (so
    it's persisted even if the rest fails, per spec).
    2. [query_embedding] = await embed_texts([body.content]).
    3. SELECT id, edited_content FROM chunks JOIN documents ON ... WHERE
       documents.status='ready' ORDER BY embedding <=> :query_embedding::vector
       LIMIT get_settings().chat_retrieval_top_k (vectors.format_vector
       for the param). Empty result is valid (no ready documents yet).
    4. try: reply = await generate_reply(body.content, [chunk text, ...])
       except LLMError: raise HTTPException(502,
       {"detail": "chat_completion_failed"}) - user message stays
       persisted, no assistant row is written.
    5. INSERT the assistant message (role='assistant'), commit,
       record_event_async(chat.message_sent, ...), commit.
    6. Return the assistant message dict (id, role, content, disliked) -
       NOT the user message (contract change from the mock, per spec)."""

@router.get("/chat/messages")
async def list_messages(session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns all chat_messages ordered by created_at ascending."""

@router.post("/chat/messages/{message_id}/dislike", status_code=204)
async def dislike_message(message_id: str, session: AsyncSession = Depends(get_session)) -> None:
    """UPDATE chat_messages SET disliked=true WHERE id=:id (no-op, still
    204, if already true or if id doesn't exist - idempotent per spec)."""
```

**Step 1: Write the failing test**

`test_chat_router.py` (mock `embed_texts`/`generate_reply` at the
`app.routers.chat` import site — external boundary):
- Sending a message with a seeded `ready` document containing relevant
  chunks returns the mocked assistant reply; `GET .../messages` afterward
  shows both the user and assistant messages in order.
- Sending a message with zero `ready` documents still succeeds (empty
  context passed to `generate_reply` — assert it was called with `[]`).
- Mocking `generate_reply` to raise `LLMError` returns 502, and the
  subsequent `GET .../messages` shows the user message with no matching
  assistant reply after it.
- Disliking a message id sets `disliked: true` in a subsequent list call;
  disliking it again is still 204 (idempotent).

Run: `pytest backend/tests/test_chat_router.py -v`
Expected: FAIL (router doesn't exist)

**Step 2: Implement**

Implement per contract; mount in `main.py`.

**Step 3: Verify**

Run: `pytest backend/tests/test_chat_router.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/routers/chat.py backend/app/main.py backend/tests/test_chat_router.py
git commit -m "feat: add retrieval-augmented chat endpoints"
```

---

## Task 9: Dashboard router

**Agent:** `backend-api`

**Files:**
- Create: `backend/app/routers/dashboard.py`
- Modify: `backend/app/main.py` (mount router)
- Test: `backend/tests/test_dashboard_router.py`

**Contracts:**

```python
# backend/app/routers/dashboard.py
router = APIRouter()

@router.get("/dashboard/events")
async def get_dashboard_events(session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns all dashboard_events as {id, type, timestamp, detail},
    ordered by created_at descending (newest first)."""
```

**Step 1: Write the failing test**

`test_dashboard_router.py`: seed a couple of events directly via
`record_event_async`/SQL, assert the endpoint returns them newest-first
with the right shape.

Run: `pytest backend/tests/test_dashboard_router.py -v`
Expected: FAIL (router doesn't exist)

**Step 2: Implement**

Implement per contract; mount in `main.py`.

**Step 3: Verify**

Run: `pytest backend/tests/test_dashboard_router.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/routers/dashboard.py backend/app/main.py backend/tests/test_dashboard_router.py
git commit -m "feat: add dashboard events endpoint"
```

---

## Task 10: Real HTTP ApiClient + binding swap

**Agent:** `web-frontend`

**Files:**
- Modify: `frontend/src/api/types.ts` (add `'failed'` to
  `DocumentSummary['status']`)
- Modify: `frontend/src/api/client.ts` (`uploadDocument` gains an optional
  second arg; swap the `apiClient` binding)
- Create: `frontend/src/api/httpClient.ts`
- Test: `frontend/src/api/httpClient.test.ts`

**Contracts:**

```typescript
// frontend/src/api/client.ts — signature change
export interface ApiClient {
  listDocuments(): Promise<DocumentSummary[]>
  uploadDocument(file: File, overwrite?: boolean): Promise<DocumentSummary>
  // ...unchanged otherwise
}
export const apiClient: ApiClient = httpApiClient // was mockApiClient
```

```typescript
// frontend/src/api/httpClient.ts
const BASE_URL = 'http://localhost:8000' // matches docker-compose's
// backend port mapping; no env var needed at this phase's single-host
// local-dev scale (see Task 10's plan notes if this ever needs to move).

export class ApiConflictError extends Error {
  constructor(public readonly reason: 'duplicate_filename' | 'document_processing') { super(reason) }
}
export class ChatCompletionError extends Error {}

export const httpApiClient: ApiClient = {
  // Each method fetches `${BASE_URL}/internal/...`. uploadDocument posts
  // multipart/form-data (file + overwrite); on a 409 response, throws
  // ApiConflictError with the parsed `detail` as `reason` so callers
  // (Task 11) can branch on it. sendChatMessage throws ChatCompletionError
  // on a 502. Every other method does a plain fetch + json() matching its
  // Promise<T>, throwing a generic Error on any non-2xx status.
}
```

**Integration:**
- `frontend/src/pages/*.tsx` don't change here — they already import
  `apiClient` from `client.ts` and know nothing about which implementation
  backs it.

**Step 1: Write the failing test**

`httpClient.test.ts`: mock global `fetch` (vitest `vi.stubGlobal`).
Assert each method calls the right URL/method/body and parses the
response into the right shape. Assert `uploadDocument` sends `overwrite`
as a form field only when the second arg is `true`. Assert a 409 response
with `{"detail":"duplicate_filename"}` rejects with `ApiConflictError`
whose `reason` is `'duplicate_filename'`. Assert a 502 from
`sendChatMessage` rejects with `ChatCompletionError`.

Run: `npm test`
Expected: FAIL (`httpClient` doesn't exist)

**Step 2: Implement**

Implement per contract; update `types.ts` and `client.ts`'s binding.

**Step 3: Verify**

Run: `npm test`
Expected: PASS (note: `mockClient.test.ts` still passes unchanged — it
tests `mockApiClient` directly, not the `apiClient` binding)

**Step 4: Commit**

```bash
git add frontend/src/api/httpClient.ts frontend/src/api/httpClient.test.ts frontend/src/api/client.ts frontend/src/api/types.ts
git commit -m "feat: add real HTTP api client and bind apiClient to it"
```

---

## Task 10b: Dashboard page test — stub fetch for the real HTTP client

*(Gap found while executing Task 10: binding `apiClient` to `httpApiClient`
broke `DashboardPage.test.tsx`, which asserted on `mockClient.ts`'s seeded
data with no fetch stub of its own. `DashboardPage.tsx` itself needs no
behavior change — Dashboard has no new interaction in this phase, unlike
Upload/Chunks/Chat — so this is test-only.)*

**Agent:** `web-frontend`

**Files:**
- Modify: `frontend/src/pages/DashboardPage.test.tsx`
- Reference: `frontend/src/api/httpClient.test.ts` (Task 10 — same
  `vi.stubGlobal('fetch', ...)` approach) for how a `GET
  /internal/dashboard/events` response should be shaped/mocked

**Step 1: Write the failing test**

Update `DashboardPage.test.tsx` to stub `fetch` so a
`GET http://localhost:8000/internal/dashboard/events` call resolves with a
small fixed array of `DashboardEvent`s, and assert those (not the old mock
rows) render.

Run: `npm test`
Expected: FAIL (still calling the real, unstubbed fetch)

**Step 2: Implement**

Add the fetch stub; no production code changes expected.

**Step 3: Verify**

Run: `npm test`
Expected: PASS, full suite green again

**Step 4: Commit**

```bash
git add frontend/src/pages/DashboardPage.test.tsx
git commit -m "fix: stub fetch in DashboardPage test for the real http client"
```

---

## Task 11: Upload page — duplicate-filename overwrite confirmation

**Agent:** `web-frontend`

**Files:**
- Modify: `frontend/src/pages/UploadPage.tsx`
- Modify: `frontend/src/pages/UploadPage.test.tsx`
- Reference: `frontend/src/pages/UploadPage.tsx`'s existing delete-confirm
  `Modal` (lines ~159-171) — follow the same Modal pattern for the new
  overwrite-confirm dialog, same button/color conventions.

**Contracts:**

```tsx
// UploadPage.tsx — behavior addition, no new exported signature
// handleFilesDrop calls apiClient.uploadDocument(file) (no overwrite).
// On ApiConflictError with reason 'duplicate_filename': store the pending
// file + show a confirmation Modal ("A document named <filename> already
// exists - overwrite it?"). Confirm re-calls
// apiClient.uploadDocument(file, true) and replaces/updates the row in
// local state by id; Cancel just closes the dialog, nothing uploaded.
// On ApiConflictError with reason 'document_processing': show a
// dismissable inline message ("<filename> is still processing - please
// wait for it to finish before overwriting it.") instead of the
// confirm dialog - there's nothing to confirm, it's just blocked.
```

**Step 1: Write the failing test**

Extend `UploadPage.test.tsx`: mock `apiClient.uploadDocument` to reject
with `ApiConflictError('duplicate_filename')` on the first call and
resolve on a second call — assert the confirm dialog appears, and
confirming triggers a second `uploadDocument` call with `overwrite=true`.
Separately, mock it rejecting with `ApiConflictError('document_processing')`
— assert the "please wait" message appears and no confirm dialog does.

Run: `npm test`
Expected: FAIL (behavior not implemented)

**Step 2: Implement**

Implement per contract, reusing the existing Modal styling pattern.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/pages/UploadPage.tsx frontend/src/pages/UploadPage.test.tsx
git commit -m "feat: add duplicate-filename overwrite confirmation to Upload"
```

---

## Task 12: Chunk preview page — busy-state guard

**Agent:** `web-frontend`

**Files:**
- Modify: `frontend/src/pages/ChunkPreviewPage.tsx`
- Create: `frontend/src/pages/ChunkPreviewPage.test.tsx` (none exists yet
  per the current file listing — add one)

**Contracts:**

```tsx
// ChunkPreviewPage.tsx — behavior addition
// Track the document's status (from the existing listDocuments() call in
// the mount effect - it already finds the matching document for
// `filename`, extend that to also keep `status`). Save button is disabled
// whenever status is 'uploaded' or 'chunking', with a visible message
// ("This document is still processing - please wait for it to finish
// before editing.") shown in that state instead of relying on the button
// merely being disabled. handleSave's catch branch: on
// ApiConflictError('document_processing') (a race where status flipped
// after the page loaded), show the same message rather than letting the
// rejection go unhandled.
```

**Step 1: Write the failing test**

New `ChunkPreviewPage.test.tsx`: with a mocked document whose status is
`chunking`, assert the Save button is disabled and the "still processing"
message is visible. With `ready`, assert Save is enabled and the message
is absent. Mock `apiClient.saveChunks` rejecting with
`ApiConflictError('document_processing')` on click (status was `ready` at
load, race simulated) — assert the message appears without a crash.

Run: `npm test`
Expected: FAIL (new test file, behavior not implemented)

**Step 2: Implement**

Implement per contract.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/pages/ChunkPreviewPage.tsx frontend/src/pages/ChunkPreviewPage.test.tsx
git commit -m "feat: guard chunk Save against in-progress/busy documents"
```

---

## Task 13: Chat page — fix send flow for the new reply-only response

**Agent:** `web-frontend`

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`
- Modify: `frontend/src/pages/ChatPage.test.tsx`

**Contracts:**

```tsx
// ChatPage.tsx — handleSend rewrite
// Task 8 changed sendChatMessage's resolved value to the ASSISTANT reply
// only (the mock's echo-the-user-message behavior no longer matches the
// real backend). handleSend must now:
// 1. Optimistically append a locally-constructed user ChatMessage
//    (crypto.randomUUID() or similar for a temporary id, role:'user',
//    content, disliked:false) immediately, so the operator's own message
//    shows without waiting on the network.
// 2. Await apiClient.sendChatMessage(content); on success, append the
//    returned assistant message.
// 3. On rejection (ChatCompletionError from Task 10): leave the optimistic
//    user message in place (it IS persisted server-side per spec) and
//    show a visible inline error ("The assistant couldn't respond - try
//    again.") rather than an unhandled rejection.
```

**Integration:**
- This is a necessary consequence of Task 8's already-agreed contract
  change (`.claude/specs/phase-2-backend-integration.md`'s Chat
  requirements), not a new scope decision — flagged here so it isn't
  missed as "just a rebind."

**Step 1: Write the failing test**

Update `ChatPage.test.tsx`: mock `apiClient.sendChatMessage` to resolve
with only an assistant message — assert BOTH a user bubble (matching the
typed content) and the assistant bubble appear after sending. Mock it
rejecting with `ChatCompletionError` — assert the user bubble still
appears and an error message is shown, with no unhandled rejection
(vitest fails the test on one by default, so this doubles as verification).

Run: `npm test`
Expected: FAIL (current handleSend appends only the resolved message)

**Step 2: Implement**

Implement per contract.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/pages/ChatPage.tsx frontend/src/pages/ChatPage.test.tsx
git commit -m "fix: show optimistic user message and handle send failure in Chat"
```

---

## Task 14: Full acceptance check

*(Verification against `.claude/specs/phase-2-backend-integration.md`'s
Acceptance Criteria — no new code expected unless a check fails.)*

**Agent:** `backend-api` for backend steps, `web-frontend` for the
frontend/manual steps — or run directly, this task is verification-only.

**Step 1**

Run: `cd backend && pytest -v` and `cd frontend && npm run build && npm test`
Expected: all pass, build succeeds

**Step 2**

Run: `docker compose up -d --build`
Expected: postgres, redis, backend, worker, frontend all healthy/running

**Step 3**

Manually (or via a small script): upload a real `.md` file through the
running frontend at http://localhost:5173/upload, watch it move
`uploaded` → `chunking` → `ready`, open it via the edit icon and confirm
chunks render and reconstruct the source text. Edit a chunk, Save, confirm
it cycles back through `chunking` to `ready` with the edit reflected. Send
a chat message referencing content from that document and confirm the
reply reflects it. Check the Dashboard page shows real events from this
session, not the Phase 1 mock rows.

**Step 4**

Run: `grep -rn "mockApiClient" frontend/src --include=*.tsx --include=*.ts | grep -v mockClient`
Expected: no matches outside `mockClient.ts`/`mockClient.test.ts` — confirms
no page still depends on the mock now that `apiClient` is bound to
`httpApiClient`.

**Step 5: Commit**

Only if Steps 1-4 required fixes; otherwise this task is verification-only.
