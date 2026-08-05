import asyncio

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.chunks.embedding import embed_texts
from app.chunks.splitting import split_into_chunks
from app.chunks.vectors import format_vector
from app.dashboard_events.constants import DashboardEventType
from app.dashboard_events.recording import record_event_sync
from app.documents.constants import DocumentStatus


class NoExtractableTextError(Exception):
    """Raised by run_pipeline when `source_text` is empty or whitespace-only
    (e.g. a scanned/image-only PDF with no text layer, where pypdf parses
    the page structure without error but extracts nothing). Caught by
    run_pipeline's own except block below and turned into a normal
    mark_document_failed call, exactly like any other pipeline failure -
    this covers both the initial-upload path (extraction produced only
    whitespace) and the Save/re-chunk path (an operator edits a chunk set
    down to nothing) with the same check."""


class DocumentProcessingError(Exception):
    """Raised once a document has already been marked 'failed' and the
    failure recorded as a dashboard_events row - chains the original
    exception so Celery still logs the root cause. Raised both by
    run_pipeline (chunking/embedding/DB-replace failures) and by
    mark_document_failed's callers (e.g. documents.tasks.run_document_pipeline's
    storage-read/text-extraction step, which runs before run_pipeline is
    ever reached)."""


class EmptyManualChunkError(Exception):
    """Raised by run_pipeline_with_manual_chunks when `chunk_texts` is
    empty, or contains an empty/whitespace-only string as one of its
    elements. Caught by run_pipeline_with_manual_chunks's own except block
    below and turned into a normal mark_document_failed call - the manual-
    boundaries path skips the automatic splitter entirely, so nothing else
    downstream would ever catch an operator having dragged a boundary all
    the way to nothing (or saved with no chunks at all). Mirrors
    NoExtractableTextError's role for the automatic-split path, kept as a
    separate type since the two paths fail for different reasons (no text
    extracted at all, vs. an explicit-but-empty manual chunk)."""


def _transition_status(
    document_id: str,
    session: Session,
    status: DocumentStatus,
    event_type: DashboardEventType,
    detail: str | None = None,
) -> None:
    """Shared status-transition step used by every place in this module
    that moves a document to a new status: updates `documents.status`
    (via a bound parameter, not string-interpolated - the previous copies
    of this each embedded the status directly into the SQL text), records
    the matching dashboard event, then commits. `detail` defaults to the
    plain `document_id=<id>` form; callers needing more (e.g.
    mark_document_failed's error detail) pass their own."""
    session.execute(
        text("UPDATE documents SET status = :status WHERE id = :document_id"),
        {"status": str(status), "document_id": document_id},
    )
    record_event_sync(
        session,
        event_type,
        detail if detail is not None else f"document_id={document_id}",
    )
    session.commit()


def mark_document_failed(document_id: str, session: Session, exc: Exception) -> None:
    """Shared failure boundary: rolls back any partial work on `session`,
    marks the document 'failed', records a 'document.chunking_failed'
    dashboard event carrying `exc`'s detail, commits, then raises
    DocumentProcessingError chained from `exc`. Always raises - never
    returns normally - so every call site can treat it as the terminal
    step of its except block.

    Reused by run_pipeline's own except block below AND by
    documents.tasks.run_document_pipeline for failures that happen before
    run_pipeline runs at all (e.g. the file is missing from storage, or
    extract_text rejects an unsupported/corrupt file) - both cases must
    give the same guarantee: the document never gets stuck mid-pipeline,
    and the error is always visible as a dashboard event."""
    session.rollback()
    _transition_status(
        document_id,
        session,
        DocumentStatus.FAILED,
        DashboardEventType.DOCUMENT_CHUNKING_FAILED,
        detail=f"document_id={document_id}: {exc}",
    )
    raise DocumentProcessingError(str(exc)) from exc


def _start_chunking(document_id: str, session: Session) -> None:
    """Shared status-transition prologue for both pipeline entry points
    below: flips the document to 'chunking' and records
    'document.chunking_started', committed immediately (before any
    splitting/embedding work begins) so the document is visibly "in
    progress" for the whole duration of that work, not just once it
    succeeds."""
    _transition_status(
        document_id, session, DocumentStatus.CHUNKING, DashboardEventType.DOCUMENT_CHUNKING_STARTED
    )


def _replace_chunks(document_id: str, chunk_texts: list[str], session: Session) -> None:
    """Shared success-path body for both pipeline entry points below: given
    a final, ordered list of chunk texts - already algorithmically split
    (run_pipeline), or provided verbatim by the caller (
    run_pipeline_with_manual_chunks) - embeds every chunk and atomically
    replaces the document's chunk set, then transitions status to 'ready'.

    Must only be called from inside a try/except that funnels any
    exception here (an embedding-API failure, a DB error, ...) into
    mark_document_failed - this function itself doesn't catch anything,
    it just does the work and lets failures propagate to its caller.

    Atomic full-replace: delete + insert + status flip all happen in the
    same transaction, committed once at the end, so a concurrent reader
    never observes a half-replaced chunk set (old rows gone, new rows not
    fully written yet) or a stale-but-still-visible set."""
    embeddings = asyncio.run(embed_texts(chunk_texts))

    session.execute(
        text("DELETE FROM chunks WHERE document_id = :document_id"),
        {"document_id": document_id},
    )
    for position, (chunk_text, embedding) in enumerate(zip(chunk_texts, embeddings)):
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, :position, :content, :content, "
                ":embedding ::vector)"
            ),
            {
                "document_id": document_id,
                "position": position,
                "content": chunk_text,
                "embedding": format_vector(embedding),
            },
        )
    _transition_status(
        document_id, session, DocumentStatus.READY, DashboardEventType.DOCUMENT_CHUNKING_SUCCEEDED
    )


def run_pipeline(document_id: str, source_text: str, session: Session) -> None:
    """Core parse-independent pipeline, shared by initial processing and
    Save-triggered re-chunk (automatic-split path - see
    run_pipeline_with_manual_chunks below for the manual-boundaries
    alternative). See `.claude/plans/2026-08-01-phase-2-backend-
    integration.md` Task 5 for the full contract. Caller is responsible for
    having already confirmed no other pipeline is running for this document
    (Task 4/7's CAS guard for re-chunk; trivially true for a brand-new
    upload)."""
    _start_chunking(document_id, session)

    try:
        if not source_text.strip():
            raise NoExtractableTextError(
                "No extractable text found in this document - it may be a "
                "scanned/image-only file with no text layer (OCR is not "
                "supported)"
            )

        chunks = split_into_chunks(source_text)
        _replace_chunks(document_id, chunks, session)
    except Exception as exc:
        mark_document_failed(document_id, session, exc)


def run_pipeline_with_manual_chunks(
    document_id: str, chunk_texts: list[str], session: Session
) -> None:
    """Manual-boundaries entry point (see
    `.claude/specs/manual-chunk-boundaries.md`): the caller (Save, when the
    operator has manually dragged a chunk boundary this editing session)
    has already decided the final chunk boundaries - `chunk_texts` is the
    authoritative, ordered chunk list as-is, so `split_into_chunks` is
    never invoked. Otherwise mirrors run_pipeline exactly: same status-
    transition prologue, same shared `_replace_chunks` success path, same
    `mark_document_failed` failure handling on any error (empty/blank
    input included - see EmptyManualChunkError)."""
    _start_chunking(document_id, session)

    try:
        if not chunk_texts or any(not chunk.strip() for chunk in chunk_texts):
            raise EmptyManualChunkError(
                "Manual chunk boundaries produced an empty chunk - every "
                "chunk must contain non-whitespace text"
            )

        _replace_chunks(document_id, chunk_texts, session)
    except Exception as exc:
        mark_document_failed(document_id, session, exc)
