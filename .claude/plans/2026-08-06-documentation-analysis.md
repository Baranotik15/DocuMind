# Documentation Analysis Report Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up the Improvements page's "Analyze with AI" button (currently
an inert placeholder) to a real, persisted, background-run analysis that
produces a documentation-gap report and a cross-document conflict report,
per `.claude/specs/documentation-analysis.md`.

**Architecture:** Backend: a new `app/analysis/` module. Conflict detection
is two-stage - stage 1 is a pure-SQL pgvector self-join over `chunks`
(reusing the same `<=>` cosine-distance operator `app/chunks/retrieval.py`
already uses) that finds cross-document chunk pairs similar enough to be
worth checking, with zero LLM calls; stage 2 sends only those candidate
pairs to a targeted LLM prompt asking whether they actually contradict each
other. Gap analysis reuses the already-shipped Dislikes/No Answer question
data as its LLM input. A run is a Celery task (same `asyncio.run()`-wraps-
async-work bridge `app/documents/pipeline.py` already uses for
`embed_texts`), writing its result to a new `analysis_reports` table
(one JSONB `conflicts` column rather than a separate table+FKs into
`chunks`, so a report stays a readable, immutable historical snapshot even
if the underlying chunks are later edited/deleted). Every completed or
failed run also gets one `dashboard_events` row (reusing
`record_event_sync`), which requires broadening `DashboardPage.tsx`'s
Logs-tab filter (currently a single `'document.'` prefix) to also match the
new event type. Frontend: `ImprovementsPage.tsx`'s `AnalysisPlaceholder` is
replaced with a real tab - a history sidebar (list of past reports) next to
the selected report's content, an "Analyze with AI" button that starts a
run and polls (same `POLL_INTERVAL_MS`/unsettled-status polling idiom
`UploadPage.tsx` already uses for document status) until it completes.

**Tech Stack:** FastAPI/SQLAlchemy Core + raw SQL (backend, existing
patterns throughout - this codebase does not use an ORM), pgvector,
Celery, React/Mantine/TypeScript (frontend, existing patterns throughout) -
no new dependencies.

---

## Key design decisions (read before starting)

- **`analysis_reports` is one table with a JSONB `conflicts` column, not a
  separate table with FKs into `chunks`.** Chunks can be edited/deleted
  later (`ChunkPreviewPage.tsx`'s Save/re-chunk, `UploadPage.tsx`'s
  delete) - a hard FK would either cascade-delete a permanent historical
  report out from under a user, or leave orphaned nulls. JSONB snapshots
  each conflict's chunk content/ids/filenames exactly as they were at
  analysis time, matching the spec's "history is append-only, nothing is
  discarded" requirement. Frontend links to `/upload/:documentId/chunks`
  using the snapshotted `documentId` may 404 if that document was since
  deleted - acceptable, not handled specially.
- **Stage 1 (candidate generation) is pure SQL, stage 2 (contradiction
  judgment) is the only stage that calls an LLM**, and only on whatever
  stage 1 returns (capped at `MAX_CONFLICT_CANDIDATES`). This is the
  bounded-cost design already agreed with the user - never an O(n²) sweep
  calling the LLM on every chunk pair.
- **A run's total token count is the sum of the gap-analysis call's tokens
  plus every conflict-check call's tokens**, read from each OpenAI
  response's own `usage.total_tokens` - this codebase doesn't read
  `response.usage` anywhere yet (`chat/completion.py`'s `generate_reply`
  doesn't either), so this is new, and scoped to `app/analysis/` only -
  `chat/completion.py` itself is not touched by this plan.
- **Every terminal run (`completed` OR `failed`) gets exactly one
  `dashboard_events` row**, per the spec's "every analysis run is
  recorded" requirement - a run that raises partway through still logs a
  `failed` event, mirroring `documents/pipeline.py`'s
  `mark_document_failed` guarantee that a pipeline run never silently
  disappears without a log trace.
- **The candidate-generation SQL's docstring must fully explain the
  search** (what "similar" means here, the distance threshold, why
  cross-document only) - this was an explicit, repeated requirement from
  the user, not optional polish. See Task 2's contract below for the
  exact content expected.

---

### Task 1: Migration - `analysis_reports` table

**Files:**
- Create: `backend/alembic/versions/0008_analysis_reports.py`
- Reference: `backend/alembic/versions/0007_chat_messages_improvements.py`
  (style/header to match - head is currently `0007`)

**Contracts:**

```python
def upgrade() -> None:
    op.create_table(
        "analysis_reports",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="running"),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_by_email", sa.Text(), nullable=False),
        # NULL until the run completes. Prose output of run_gap_analysis
        # (see Task 2).
        sa.Column("gap_analysis", sa.Text(), nullable=True),
        # NULL until the run completes. A JSON array of objects shaped like
        # AnalysisConflict (see Task 4's schemas) - one entry per detected
        # contradiction, empty array (not NULL) if the run completed and
        # found none.
        sa.Column("conflicts", postgresql.JSONB(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        # NULL unless status='failed'.
        sa.Column("error_detail", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("analysis_reports")
```

`status` is always one of `"running"`, `"completed"`, `"failed"` (enforced
application-side, same convention as `documents.status`/`chat_messages` -
this codebase does not use a Postgres CHECK constraint or enum type for
status columns elsewhere either).

**Step 1: Apply and verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_schema.py -v`

**Step 2: Commit**

```bash
git add backend/alembic/versions/0008_analysis_reports.py
git commit -m "feat(analysis): add analysis_reports table"
```

---

### Task 2: Conflict candidate detection + gap-analysis/conflict-check LLM calls

**Files:**
- Create: `backend/app/analysis/__init__.py` (empty)
- Create: `backend/app/analysis/candidates.py`
- Create: `backend/app/analysis/service.py`
- Create: `backend/app/analysis/prompts/gap_analysis_prompt.txt`
- Create: `backend/app/analysis/prompts/conflict_check_prompt.txt`
- Test: `backend/tests/test_analysis_service.py`
- Reference: `backend/app/chunks/retrieval.py` (the `<=>` pgvector pattern
  to reuse), `backend/app/chunks/embedding.py`/`chat/completion.py` (the
  `LLMError`/`get_client()`/try-except-wrap-SDK-failure pattern to reuse)

**Contracts:**

```python
# backend/app/analysis/candidates.py
from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

# How close two chunks' embeddings must be (pgvector cosine DISTANCE via
# the `<=>` operator - 0.0 = identical direction, 2.0 = opposite) to be
# considered "about the same topic" and worth an LLM contradiction check.
# A low distance is a NECESSARY but not SUFFICIENT condition for a
# contradiction - two chunks this close might simply agree, or one might
# be a superset of the other; this threshold only bounds what's worth
# asking the LLM about, it never itself claims a contradiction exists.
SIMILAR_CHUNK_DISTANCE_THRESHOLD: float = ...  # pick a reasonable starting value, e.g. 0.35

# Hard cap on how many candidate pairs ever reach the LLM check stage in
# one run, regardless of how many fall under the threshold above - bounds
# worst-case LLM cost/latency per run even against a large, highly
# self-similar corpus.
MAX_CONFLICT_CANDIDATES: int = 30


async def find_conflict_candidates(session: AsyncSession) -> list[Row]:
    """Stage 1 of conflict detection (see service.py's check_conflict for
    stage 2, the actual LLM judgment) - a pure-SQL, zero-LLM-calls pass
    that finds which pairs of chunks are even worth asking an LLM about.

    Self-joins `chunks` against itself via pgvector's `<=>` cosine-distance
    operator (the same operator app/chunks/retrieval.py already uses for
    text-query retrieval), comparing every chunk's embedding against every
    other chunk's embedding. A pair survives only if ALL of:
    - the two chunks belong to DIFFERENT documents (`c1.document_id !=
      c2.document_id`) - conflict detection is explicitly cross-document
      only (.claude/specs/documentation-analysis.md's Requirements): two
      passages disagreeing within the same document is a different
      problem this feature does not address.
    - both chunks' documents have status='ready' (the same corpus already
      used for chat retrieval/Relevance Preview).
    - their cosine distance is below SIMILAR_CHUNK_DISTANCE_THRESHOLD.

    `c1.id < c2.id` (a plain UUID comparison, carrying no semantic meaning
    - just a total order to de-duplicate against) drops symmetric
    duplicates: since cosine distance is symmetric, (chunk A, chunk B) and
    (chunk B, chunk A) would otherwise both appear as separate rows.

    Returns at most MAX_CONFLICT_CANDIDATES rows - id/document_id/filename
    /edited_content for both chunks in each pair, nearest (most similar)
    first - the caller (service.py) never re-fetches chunk content
    separately.
    """
    ...
```

```python
# backend/app/analysis/service.py
from dataclasses import dataclass

from openai import AsyncOpenAI

from app.chunks.embedding import LLMError, get_client  # reused, not duplicated


@dataclass(frozen=True)
class GapAnalysisResult:
    content: str
    tokens_used: int


@dataclass(frozen=True)
class ConflictCheckResult:
    is_conflict: bool
    description: str | None  # None when is_conflict is False
    tokens_used: int


async def run_gap_analysis(
    questions: list[str], client: AsyncOpenAI | None = None
) -> GapAnalysisResult:
    """Sends `questions` (every Dislikes + No Answer question's text, see
    service.py's run_full_analysis for the caller) to
    get_settings().openai_chat_model with the prompt in
    prompts/gap_analysis_prompt.txt, asking it to identify recurring
    themes/topics worth adding to the documentation. Reads
    response.usage.total_tokens for tokens_used. Raises LLMError on any
    SDK failure, same contract as chat/completion.py's generate_reply.
    Empty `questions` is valid - the prompt must handle "no data" and
    produce a plain report saying so (see the prompt file and
    .claude/specs/documentation-analysis.md's zero-entries acceptance
    criterion), not an error."""
    ...


async def check_conflict(
    chunk_a_content: str, chunk_b_content: str, client: AsyncOpenAI | None = None
) -> ConflictCheckResult:
    """Sends both chunks' text to get_settings().openai_chat_model with the
    prompt in prompts/conflict_check_prompt.txt, asking whether they state
    a factual contradiction. The prompt must instruct the model to answer
    in one fixed, reliably parseable shape (e.g. a first line that's
    exactly "CONFLICT" or "NO_CONFLICT", followed by a description only in
    the CONFLICT case) - parsed into is_conflict/description here. Reads
    response.usage.total_tokens for tokens_used. Raises LLMError on any SDK
    failure."""
    ...
```

`gap_analysis_prompt.txt`/`conflict_check_prompt.txt`: plain-text prompt
files, same convention as `chat/prompts/chat_system_prompt.txt` (read once
at import time via `Path.read_text()`). Write clear instructions covering:
gap-analysis prompt - input is a list of unanswered/disliked questions,
output should group them into themes and suggest documentation topics, and
explicitly handle an empty question list. Conflict-check prompt - input is
two text passages from different documents, output must follow the fixed
parseable format described above, and must only report a genuine factual
contradiction (a specific number/claim that disagrees), not a stylistic or
scope difference.

**Step 1: Write the failing tests**

`test_analysis_service.py` - follow `test_llm.py`'s existing
`generate_reply`/`_make_chat_response`-style mocking conventions closely:
- `find_conflict_candidates`: seed two documents (both `ready`) with one
  chunk each whose embeddings are set close together (below threshold) ->
  returned as a candidate pair with both chunks' content/ids/filenames. A
  third document's chunk with a far embedding -> not returned. Two chunks
  within the SAME document with close embeddings -> not returned (cross-
  document only). A close pair where one document is NOT `ready` -> not
  returned.
- `run_gap_analysis`: mocked completion response -> `GapAnalysisResult`
  with `content` from the response and `tokens_used` from
  `response.usage.total_tokens`. Empty `questions` list -> still calls the
  LLM (doesn't short-circuit locally) with a prompt reflecting "no
  questions" - assert on the constructed prompt/messages, matching
  `test_llm.py`'s existing pattern for asserting system-prompt content.
- `check_conflict`: mocked response starting with `"CONFLICT\n..."` ->
  `is_conflict=True`, `description` set from the rest. Mocked response
  `"NO_CONFLICT"` -> `is_conflict=False`, `description=None`.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_service.py -v`
Expected: FAIL

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_service.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/analysis/__init__.py backend/app/analysis/candidates.py backend/app/analysis/service.py backend/app/analysis/prompts/ backend/tests/test_analysis_service.py
git commit -m "feat(analysis): conflict candidate detection + gap-analysis/conflict-check LLM calls"
```

---

### Task 3: Orchestration + Celery task + dashboard_events logging

**Files:**
- Modify: `backend/app/analysis/service.py` (add `run_full_analysis`)
- Create: `backend/app/analysis/tasks.py`
- Modify: `backend/app/dashboard_events/constants.py`
- Test: `backend/tests/test_analysis_service.py` (extend)
- Reference: `backend/app/documents/pipeline.py` (the
  `mark_document_failed`-never-lets-an-exception-propagate pattern, and
  `run_pipeline`'s `asyncio.run(embed_texts(...))` bridge),
  `backend/app/documents/tasks.py` (the `@celery_app.task` shape)

**Contracts:**

```python
# backend/app/dashboard_events/constants.py - add
ANALYSIS_RUN_COMPLETED = "analysis.run_completed"
ANALYSIS_RUN_FAILED = "analysis.run_failed"
```

```python
# backend/app/analysis/service.py - add
async def run_full_analysis(report_id: str) -> None:
    """The complete async analysis pipeline for one analysis_reports row,
    invoked from tasks.py's Celery task via asyncio.run() (same
    sync-task-wraps-async-work bridge documents/pipeline.py's run_pipeline
    already uses for its own embed_texts call). Uses SyncSessionLocal (this
    runs inside a Celery worker, same as documents/tasks.py), not an async
    session.

    Steps:
    1. Read the report row's started_by_email (needed for the dashboard
       event at the end).
    2. Fetch every Dislikes + No Answer question's text (the same
       disliked=true / no_answer_found=true / question_id-joined query
       chat/router.py's list_disliked_messages/list_no_answer_messages
       already run, range=all equivalent - reuse or closely mirror that
       SQL, don't route through the HTTP layer) and pass the combined
       question text to run_gap_analysis.
    3. Fetch conflict candidates via find_conflict_candidates, then call
       check_conflict on every candidate CONCURRENTLY (asyncio.gather) -
       bounded by MAX_CONFLICT_CANDIDATES from candidates.py, so this is
       never more than that many concurrent requests. Keep only the pairs
       where is_conflict is True.
    4. Sum every call's tokens_used (the gap-analysis call plus every
       conflict-check call, whether or not that pair turned out to
       conflict) into one total.
    5. UPDATE the analysis_reports row: status='completed',
       gap_analysis=<step 2's content>, conflicts=<step 3's kept pairs, as
       the JSON shape Task 4's AnalysisConflict schema defines>,
       total_tokens=<step 4's sum>, completed_at=now(). Commit.
    6. record_event_sync(session, DashboardEventType.ANALYSIS_RUN_COMPLETED,
       <detail text including the token count - see dashboard_events'
       existing detail-string conventions, e.g.
       build_document_event_detail-style helpers>, user_email=<step 1's
       email>). Commit.

    Any exception raised during steps 2-4 is caught here: UPDATE the row
    to status='failed', error_detail=str(exception), completed_at=now(),
    commit, THEN still record one
    DashboardEventType.ANALYSIS_RUN_FAILED dashboard_event (same "every
    run gets exactly one log entry" guarantee as
    documents/pipeline.py:mark_document_failed) before returning - this
    function must never let an exception escape to the Celery task.
    """
    ...
```

```python
# backend/app/analysis/tasks.py
import asyncio

from app.analysis.service import run_full_analysis
from app.worker.celery_app import celery_app


@celery_app.task(name="run_documentation_analysis")
def run_documentation_analysis(report_id: str) -> None:
    """Sync Celery entrypoint - see run_full_analysis's own docstring for
    the actual pipeline; this is just the asyncio.run() bridge."""
    asyncio.run(run_full_analysis(report_id))
```

**Step 1: Write the failing tests**

Extend `test_analysis_service.py`:
- `run_full_analysis`, everything mocked (LLM calls via the same
  `AsyncMock` idiom `test_llm.py`/`test_chat_router.py` already use, no
  real OpenAI call): seed a `running` analysis_reports row, a couple of
  disliked/no-answer chat_messages, and two close-embedding cross-document
  chunks -> after running, the row is `completed` with non-null
  `gap_analysis`/`conflicts`/`total_tokens`/`completed_at`, and exactly one
  `dashboard_events` row of type `analysis.run_completed` exists with the
  right `user_email`.
- A mocked LLM failure partway through -> the row ends up `failed` with a
  non-null `error_detail`, and exactly one `dashboard_events` row of type
  `analysis.run_failed` exists.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_service.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_service.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/analysis/service.py backend/app/analysis/tasks.py backend/app/dashboard_events/constants.py backend/tests/test_analysis_service.py
git commit -m "feat(analysis): run_full_analysis orchestration, Celery task, dashboard_events logging"
```

---

### Task 4: Router - start/list/get endpoints

**Files:**
- Create: `backend/app/analysis/schemas.py`
- Create: `backend/app/analysis/router.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_analysis_router.py`
- Reference: `backend/app/documents/router.py` (the `.delay()` via
  `asyncio.to_thread` dispatch pattern, and its `require_session`-for-
  `user_email` usage), `backend/app/chat/router.py` (a `GET` list endpoint
  shape)

**Contracts:**

```python
# backend/app/analysis/schemas.py
from typing import Literal

from pydantic import BaseModel

AnalysisRunStatus = Literal["running", "completed", "failed"]


class AnalysisReportSummary(BaseModel):
    id: str
    status: AnalysisRunStatus
    startedAt: str
    completedAt: str | None
    startedByEmail: str


class AnalysisConflict(BaseModel):
    documentAId: str
    documentAFilename: str
    chunkAId: str
    chunkAContent: str
    documentBId: str
    documentBFilename: str
    chunkBId: str
    chunkBContent: str
    description: str


class AnalysisReportDetail(AnalysisReportSummary):
    gapAnalysis: str | None
    conflicts: list[AnalysisConflict] | None
    totalTokens: int | None
    errorDetail: str | None
```

```python
# backend/app/analysis/router.py
@router.post("/analysis/reports", status_code=201)
async def start_analysis_run(
    user_email: str = Depends(require_session), session: AsyncSession = Depends(get_session)
) -> AnalysisReportSummary:
    """INSERTs a new analysis_reports row (status='running',
    started_by_email=user_email), commits, then dispatches
    run_documentation_analysis.delay(str(row.id)) via asyncio.to_thread -
    same eager-mode-safe pattern documents/router.py's upload_document
    already uses (see its own comment for why asyncio.to_thread is
    required, not optional, under the test suite's Celery eager mode).
    Returns immediately with status='running' - the frontend polls
    GET /analysis/reports/{id} (or re-fetches the list) until it isn't."""
    ...


@router.get("/analysis/reports")
async def list_analysis_reports(
    session: AsyncSession = Depends(get_session),
) -> list[AnalysisReportSummary]:
    """Every analysis_reports row, newest started_at first - powers the
    Analysis sub-tab's history sidebar."""
    ...


@router.get("/analysis/reports/{report_id}")
async def get_analysis_report(
    report_id: UUID, session: AsyncSession = Depends(get_session)
) -> AnalysisReportDetail:
    """One report's full detail. 404 if report_id doesn't exist."""
    ...
```

```python
# backend/app/main.py - add analysis_router to the existing loop (currently
# documents_router, chunks_router, chat_router, dashboard_router,
# dashboard_events_router, smoke_jobs_router)
```

**Step 1: Write the failing tests**

`test_analysis_router.py` - follow `test_chat_router.py`'s fixtures/
`authenticated_client`/mocking conventions:
- `POST /internal/analysis/reports` -> 201, `status: "running"`,
  `startedByEmail` matches the authenticated user; a `dashboard_events`-
  style check isn't needed here (that's Task 3's own test) but assert the
  Celery task was dispatched (mock `run_documentation_analysis.delay`,
  same idiom `test_documents_router.py` uses for `run_document_pipeline.delay`).
- `GET /internal/analysis/reports` -> returns seeded rows, newest first.
- `GET /internal/analysis/reports/{id}` -> full detail for a `completed`
  seeded row (gapAnalysis/conflicts/totalTokens all present); 404 for an
  unknown id.
- All three require a session cookie (401 without one) - same one-line
  pattern as this project's other router test files.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_router.py -v`
Expected: FAIL, then PASS. Then run the full suite: `.venv/Scripts/python.exe -m pytest tests/ -q`.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q`
Expected: PASS, no regressions.

**Step 4: Commit**

```bash
git add backend/app/analysis/schemas.py backend/app/analysis/router.py backend/app/main.py backend/tests/test_analysis_router.py
git commit -m "feat(analysis): start/list/get report endpoints"
```

---

### Task 5: Frontend API client - types, methods, mock data

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/httpClient.ts`
- Modify: `frontend/src/api/mockClient.ts`
- Test: `frontend/src/api/httpClient.test.ts`

**Contracts:**

```typescript
// frontend/src/api/types.ts - add
export type AnalysisRunStatus = 'running' | 'completed' | 'failed'

export interface AnalysisReportSummary {
  id: string
  status: AnalysisRunStatus
  startedAt: string
  completedAt: string | null
  startedByEmail: string
}

export interface AnalysisConflict {
  documentAId: string
  documentAFilename: string
  chunkAId: string
  chunkAContent: string
  documentBId: string
  documentBFilename: string
  chunkBId: string
  chunkBContent: string
  description: string
}

export interface AnalysisReportDetail extends AnalysisReportSummary {
  gapAnalysis: string | null
  conflicts: AnalysisConflict[] | null
  totalTokens: number | null
  errorDetail: string | null
}
```

```typescript
// frontend/src/api/client.ts - add to ApiClient interface
/** POST /internal/analysis/reports - starts a new run, returns immediately with status 'running'. */
startAnalysisRun(): Promise<AnalysisReportSummary>
/** GET /internal/analysis/reports - every past run, newest first. */
listAnalysisReports(): Promise<AnalysisReportSummary[]>
/** GET /internal/analysis/reports/{reportId} - one report's full detail. */
getAnalysisReport(reportId: string): Promise<AnalysisReportDetail>
```

`httpClient.ts`: `startAnalysisRun` POSTs `/internal/analysis/reports` with
no body. `listAnalysisReports` GETs `/internal/analysis/reports`.
`getAnalysisReport` GETs `/internal/analysis/reports/${reportId}`. Follow
this file's existing method shapes immediately around
`getDislikedMessages`/`dismissNoAnswerMessage` for the exact idiom.

`mockClient.ts`: seed one or two `AnalysisReportSummary`/`AnalysisReportDetail`-
shaped entries (a `completed` one with sample gap analysis text and an
empty or one-entry `conflicts` array is enough) and implement the three
methods against that seeded array, following this file's existing
seed-data + array-mutation conventions.

**Step 1: Write the failing test**

`httpClient.test.ts`: assert `startAnalysisRun()` POSTs
`/internal/analysis/reports` and returns the parsed summary;
`listAnalysisReports()` GETs `/internal/analysis/reports`;
`getAnalysisReport('abc')` GETs `/internal/analysis/reports/abc`.

Run: `cd frontend && npx vitest run src/api/httpClient.test.ts`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run src/api/httpClient.test.ts` and
`npx tsc -b` (the mock client must still satisfy `ApiClient`).
Expected: PASS, no type errors.

**Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/httpClient.ts frontend/src/api/mockClient.ts frontend/src/api/httpClient.test.ts
git commit -m "feat(analysis): add analysis-report API client methods"
```

---

### Task 6: Logs tab - recognize the new event type

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Test: `frontend/src/pages/DashboardPage.test.tsx`

**Contracts:**

```typescript
// frontend/src/pages/DashboardPage.tsx
// Replace the single-prefix LOG_EVENT_TYPE_PREFIX ('document.') with a
// list, since the Logs tab must now also show 'analysis.*' events -
// filteredLogsEvents' own `!event.type.startsWith(LOG_EVENT_TYPE_PREFIX)`
// check becomes `!LOG_EVENT_TYPE_PREFIXES.some((prefix) => event.type.startsWith(prefix))`.
const LOG_EVENT_TYPE_PREFIXES = ['document.', 'analysis.']

// EVENT_TYPE_LABELS - add
'analysis.run_completed': 'Documentation Analysis — Completed',
'analysis.run_failed': 'Documentation Analysis — Failed',
```

**Step 1: Write the failing test**

Extend `DashboardPage.test.tsx`'s existing Logs-tab fixture events with one
`analysis.run_completed` event -> assert it's shown in the Logs tab (by its
human label), same pattern the existing `document.*` fixture events are
already asserted on.

Run: `cd frontend && npx vitest run src/pages/DashboardPage.test.tsx`
Expected: FAIL, then PASS.

**Step 2: Implement**

Per the contract above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run src/pages/DashboardPage.test.tsx` and `npx tsc -b`.
Expected: PASS.

**Step 4: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx frontend/src/pages/DashboardPage.test.tsx
git commit -m "feat(analysis): show analysis runs on the Logs tab"
```

---

### Task 7: ImprovementsPage - real Analysis tab (history sidebar + report + run button)

**Files:**
- Modify: `frontend/src/pages/ImprovementsPage.tsx` (replace
  `AnalysisPlaceholder`)
- Modify: `frontend/src/pages/ImprovementsPage.test.tsx`
- Reference: `frontend/src/pages/UploadPage.tsx` (the
  `POLL_INTERVAL_MS`/unsettled-status polling `useEffect` shape - import
  `POLL_INTERVAL_MS` from there rather than redefining it),
  `frontend/src/pages/ChunkPreviewPage.tsx`'s route (`/upload/:documentId/chunks`,
  for the conflict cards' "view chunk" links)

**Contracts:**

```typescript
// frontend/src/pages/ImprovementsPage.tsx
// Replace AnalysisPlaceholder with a stateful component, e.g.:
function AnalysisTab(): JSX.Element {
  // reports: AnalysisReportSummary[] (from listAnalysisReports, fetched on mount)
  // selectedReportId: string | null
  // selectedReport: AnalysisReportDetail | null (fetched via getAnalysisReport
  //   whenever selectedReportId changes)
  // isStarting: boolean (true only for the brief window between clicking
  //   "Analyze with AI" and the POST resolving - NOT the same as the
  //   selected report's own status==='running', which covers the whole
  //   run's duration)
  ...
}
```

Layout: a `Group`/two-column layout inside the same
`PANEL_AREA_HEIGHT`-tall shell the Lists sub-tab's panels already use (see
`ImprovementsListPanel`'s own `height: '100%'` + internal `overflowY:
auto` scroll-area split) - a narrower history sidebar (each past report as
a clickable card: started-at timestamp via `formatDateTime`,
`startedByEmail`, a status `Badge`) next to a wider content area showing
the selected report: an "Analyze with AI" button at the top (disabled
while `isStarting` or while the most-recently-started report's
`status === 'running'`), then, once a report is selected, its
`gapAnalysis` text and its `conflicts` list (each conflict as its own
card: both chunks' filename + content excerpt + `description`, plus a
link to `/upload/:documentId/chunks` for each side - `Link`/`useNavigate`
from `react-router-dom`, same as `UploadPage.tsx`'s own edit-icon
navigation). A `status==='running'` selected report shows a clear
in-progress state (e.g. a `Loader` + "Analysis in progress...") instead of
stale/empty gap-analysis-and-conflicts fields.

Polling: while `reports[0]?.status === 'running'` (the most recent report
is still running - matches `UploadPage.tsx`'s `isUnsettled`-driven
`useEffect` shape, reuse `POLL_INTERVAL_MS` from there), periodically
re-fetch `listAnalysisReports()` and, if the currently selected report is
the one that just finished, re-fetch its detail too. Stops as soon as
nothing is `running`.

Starting a run: `startAnalysisRun()` -> prepend the returned summary to
`reports`, select it, `isStarting` false again once the POST resolves
(the run itself keeps going in the background - the polling effect above
picks up its completion).

**Step 1: Write the failing tests**

Extend `ImprovementsPage.test.tsx` (stub `fetch` the same way the existing
tests in this file already do):
- Switching to the Analysis sub-tab fetches and shows the report history
  list and the most recent report's content.
- Clicking "Analyze with AI" POSTs to `/internal/analysis/reports`, shows
  an in-progress state, and disables the button.
- Selecting a different report from the history sidebar fetches and shows
  that report's own detail (assert the right `reportId` in the fetch URL).
- While the most recent report's status is `running`, the list is
  re-fetched on the next poll tick (use fake timers, matching however this
  repo's existing polling tests - if any - advance time, or assert via
  `waitFor` + a mocked `fetch` resolving to `status: 'completed'` on the
  second call).
- A report's conflicts render with links to `/upload/:documentId/chunks`
  for each side.

Run: `cd frontend && npx vitest run src/pages/ImprovementsPage.test.tsx`
Expected: FAIL, then PASS.

**Step 2: Implement**

Per the contracts above, following the referenced existing patterns.

**Step 3: Verify**

Run: `cd frontend && npx vitest run` (full suite) and `npx tsc -b`.
Expected: PASS, no regressions, no type errors.

**Step 4: Commit**

```bash
git add frontend/src/pages/ImprovementsPage.tsx frontend/src/pages/ImprovementsPage.test.tsx
git commit -m "feat(analysis): wire up the Analysis tab - run button, history sidebar, report display"
```

---

### Task 8: Full regression + live smoke test

**Files:** None new - verification only.

**Step 1:** `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q` - PASS.

**Step 2:** `cd frontend && npx vitest run && npx tsc -b` - PASS, no type errors.

**Step 3:** `docker compose up -d --build backend worker frontend`, then
`docker compose exec backend alembic upgrade head` (applies migration 0008).

**Step 4:** Live smoke test via a throwaway user (same idiom as this
session's earlier Improvements-page smoke test - create via
`app.auth.service.create_user`, exercise the flow, clean up every seeded
row afterward including `analysis_reports`): trigger a couple of
disliked/no-answer messages first (so the gap-analysis half has real
input), then start an analysis run via the UI, confirm it shows as running,
confirm it completes and shows a real gap-analysis report plus (if the
uploaded documents happen to genuinely conflict) or without (if not, that's
fine - the corpus may not actually contain a contradiction right now)
conflict entries, confirm a `analysis.run_completed` entry with a token
count appears on the Logs tab, confirm the report reappears correctly after
selecting it again from the history sidebar. Clean up the throwaway
user/session/seeded chat rows/analysis_reports row(s) afterward, same as
every other live check this session.

**Step 5: Commit** (only if Steps 1-2 required fixes)

```bash
git add -A
git commit -m "test: fix regressions found during documentation-analysis smoke testing"
```
