import asyncio

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.chunks.embedding import embed_texts
from app.chunks.headings import HeadingMarker
from app.chunks.splitting import split_document
from app.chunks.tokens import count_tokens
from app.chunks.vectors import format_vector
from app.dashboard_events.constants import DashboardEventType
from app.dashboard_events.recording import record_event_sync
from app.documents.constants import DocumentStatus
from app.documents.formatting import build_document_event_detail


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
    error: Exception | None = None,
    user_email: str | None = None,
    token_count: int | None = None,
) -> None:
    """Shared status-transition step used by every place in this module
    that moves a document to a new status: updates `documents.status`
    (via a bound parameter, not string-interpolated - the previous copies
    of this each embedded the status directly into the SQL text) and
    captures the document's filename via RETURNING - detail strings use
    `filename=<name>` rather than `document_id=<id>` so a dashboard_events
    row stays readable even after its source `documents` row is later
    hard-deleted (see documents/router.py's delete_document). `error`,
    when given (mark_document_failed's only caller), is appended to the
    detail as `: <error>`. `user_email` is None only when the caller
    genuinely has none to give (there currently is no such caller in this
    app - every pipeline run traces back to an authenticated upload or
    Save, threaded all the way down from documents/router.py and
    chunks/router.py through documents/tasks.py - but the parameter stays
    optional for whichever future caller might not have one). `token_count`
    is None for every caller except _replace_chunks's own call below (the
    only place a token count is known - see its docstring) - it flows
    straight into build_document_event_detail's own optional third
    parameter, so it never appears on a chunking_started or chunking_failed
    event. Records the matching dashboard event, then commits."""
    row = session.execute(
        text(
            "UPDATE documents SET status = :status WHERE id = :document_id "
            "RETURNING filename, file_size_bytes"
        ),
        {"status": str(status), "document_id": document_id},
    ).one()
    detail = build_document_event_detail(row.filename, row.file_size_bytes, token_count)
    if error is not None:
        detail = f"{detail}: {error}"
    record_event_sync(session, event_type, detail, user_email=user_email)
    session.commit()


def mark_document_failed(
    document_id: str, session: Session, exc: Exception, user_email: str | None = None
) -> None:
    """Shared failure boundary: rolls back any partial work on `session`,
    marks the document 'failed', records a 'document.chunking_failed'
    dashboard event carrying `exc`'s detail, commits, then raises
    DocumentProcessingError chained from `exc`. Always raises - never
    returns normally - so every call site can treat it as the terminal
    step of its except block.

    Reused by run_pipeline's own except block below AND by
    documents.tasks.run_document_pipeline for failures that happen before
    run_pipeline runs at all (e.g. the file is missing from storage, or
    extract_document rejects an unsupported/corrupt file) - both cases must
    give the same guarantee: the document never gets stuck mid-pipeline,
    and the error is always visible as a dashboard event."""
    session.rollback()
    _transition_status(
        document_id,
        session,
        DocumentStatus.FAILED,
        DashboardEventType.DOCUMENT_CHUNKING_FAILED,
        error=exc,
        user_email=user_email,
    )
    raise DocumentProcessingError(str(exc)) from exc


def _start_chunking(document_id: str, session: Session, user_email: str | None = None) -> None:
    """Shared status-transition prologue for both pipeline entry points
    below: flips the document to 'chunking' and records
    'document.chunking_started', committed immediately (before any
    splitting/embedding work begins) so the document is visibly "in
    progress" for the whole duration of that work, not just once it
    succeeds."""
    _transition_status(
        document_id,
        session,
        DocumentStatus.CHUNKING,
        DashboardEventType.DOCUMENT_CHUNKING_STARTED,
        user_email=user_email,
    )


def _replace_chunks(
    document_id: str,
    chunk_texts: list[str],
    session: Session,
    user_email: str | None = None,
) -> None:
    """Shared success-path body for both pipeline entry points below: given
    a final, ordered list of chunk texts - already algorithmically split
    (run_pipeline), or provided verbatim by the caller (
    run_pipeline_with_manual_chunks) - embeds every chunk and atomically
    replaces the document's chunk set, then transitions status to 'ready'.
    Also sums each chunk's count_tokens into `token_count` and threads it
    into that final _transition_status call, so the resulting
    document.chunking_succeeded event's detail carries a
    'tokens spend = <n>' line - this is the only place in the pipeline a
    token count is known
    (chunking_started fires before embedding even runs; chunking_failed
    means embedding either never ran or can't be trusted), so it's also
    the only _transition_status call site that ever passes one.

    Must only be called from inside a try/except that funnels any
    exception here (an embedding-API failure, a DB error, ...) into
    mark_document_failed - this function itself doesn't catch anything,
    it just does the work and lets failures propagate to its caller.

    Atomic full-replace: delete + insert + status flip all happen in the
    same transaction, committed once at the end, so a concurrent reader
    never observes a half-replaced chunk set (old rows gone, new rows not
    fully written yet) or a stale-but-still-visible set."""
    embeddings = asyncio.run(embed_texts(chunk_texts))
    token_count = sum(count_tokens(chunk) for chunk in chunk_texts)

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
        document_id,
        session,
        DocumentStatus.READY,
        DashboardEventType.DOCUMENT_CHUNKING_SUCCEEDED,
        user_email=user_email,
        token_count=token_count,
    )


def run_pipeline(
    document_id: str,
    source_text: str,
    session: Session,
    headings: list[HeadingMarker] | None = None,
    user_email: str | None = None,
) -> None:
    """Core parse-independent pipeline, shared by initial processing and
    Save-triggered re-chunk (automatic-split path - see
    run_pipeline_with_manual_chunks below for the manual-boundaries
    alternative). See `.claude/plans/2026-08-01-phase-2-backend-
    integration.md` Task 5 for the full contract. Caller is responsible for
    having already confirmed no other pipeline is running for this document
    (Task 4/7's CAS guard for re-chunk; trivially true for a brand-new
    upload). `headings` is whatever format-native heading structure the
    caller could recover (see documents/extraction.py's ExtractedDocument) -
    threaded straight into split_document, which falls back to its own
    text-pattern detection when this is None/[] (the Save-triggered
    automatic re-chunk path, and any caller with no format-native structure
    available, both pass None here). `user_email` is attributed to every
    dashboard event this run produces - see _transition_status's
    docstring."""
    _start_chunking(document_id, session, user_email=user_email)

    try:
        if not source_text.strip():
            raise NoExtractableTextError(
                "No extractable text found in this document - it may be a "
                "scanned/image-only file with no text layer (OCR is not "
                "supported)"
            )

        chunks = split_document(source_text, headings=headings)
        _replace_chunks(document_id, chunks, session, user_email=user_email)
    except Exception as exc:
        mark_document_failed(document_id, session, exc, user_email=user_email)


def run_pipeline_with_manual_chunks(
    document_id: str,
    chunk_texts: list[str],
    session: Session,
    user_email: str | None = None,
) -> None:
    """Manual-boundaries entry point (see
    `.claude/specs/manual-chunk-boundaries.md`): the caller (Save, when the
    operator has manually dragged a chunk boundary this editing session)
    has already decided the final chunk boundaries - `chunk_texts` is the
    authoritative, ordered chunk list as-is, so `split_document` is
    never invoked. Otherwise mirrors run_pipeline exactly: same status-
    transition prologue, same shared `_replace_chunks` success path, same
    `mark_document_failed` failure handling on any error (empty/blank
    input included - see EmptyManualChunkError). `user_email` is
    attributed to every dashboard event this run produces - see
    _transition_status's docstring."""
    _start_chunking(document_id, session, user_email=user_email)

    try:
        if not chunk_texts or any(not chunk.strip() for chunk in chunk_texts):
            raise EmptyManualChunkError(
                "Manual chunk boundaries produced an empty chunk - every "
                "chunk must contain non-whitespace text"
            )

        _replace_chunks(document_id, chunk_texts, session, user_email=user_email)
    except Exception as exc:
        mark_document_failed(document_id, session, exc, user_email=user_email)
