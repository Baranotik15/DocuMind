import asyncio

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.documents import split_into_chunks
from app.events import record_event_sync
from app.llm import embed_texts
from app.vectors import format_vector


class DocumentProcessingError(Exception):
    """Raised once a document has already been marked 'failed' and the
    failure recorded as a dashboard_events row - chains the original
    exception so Celery still logs the root cause. Raised both by
    run_pipeline (chunking/embedding/DB-replace failures) and by
    mark_document_failed's callers (e.g. tasks.run_document_pipeline's
    storage-read/text-extraction step, which runs before run_pipeline is
    ever reached)."""


def mark_document_failed(document_id: str, session: Session, exc: Exception) -> None:
    """Shared failure boundary: rolls back any partial work on `session`,
    marks the document 'failed', records a 'document.chunking_failed'
    dashboard event carrying `exc`'s detail, commits, then raises
    DocumentProcessingError chained from `exc`. Always raises - never
    returns normally - so every call site can treat it as the terminal
    step of its except block.

    Reused by run_pipeline's own except block below AND by
    tasks.run_document_pipeline for failures that happen before
    run_pipeline runs at all (e.g. the file is missing from storage, or
    extract_text rejects an unsupported/corrupt file) - both cases must
    give the same guarantee: the document never gets stuck mid-pipeline,
    and the error is always visible as a dashboard event."""
    session.rollback()
    session.execute(
        text("UPDATE documents SET status = 'failed' WHERE id = :document_id"),
        {"document_id": document_id},
    )
    record_event_sync(
        session,
        "document.chunking_failed",
        f"document_id={document_id}: {exc}",
    )
    session.commit()
    raise DocumentProcessingError(str(exc)) from exc


def run_pipeline(document_id: str, source_text: str, session: Session) -> None:
    """Core parse-independent pipeline, shared by initial processing and
    Save-triggered re-chunk. See `.claude/plans/2026-08-01-phase-2-backend-
    integration.md` Task 5 for the full contract. Caller is responsible for
    having already confirmed no other pipeline is running for this document
    (Task 4/7's CAS guard for re-chunk; trivially true for a brand-new
    upload)."""
    session.execute(
        text("UPDATE documents SET status = 'chunking' WHERE id = :document_id"),
        {"document_id": document_id},
    )
    record_event_sync(
        session, "document.chunking_started", f"document_id={document_id}"
    )
    session.commit()

    try:
        chunks = split_into_chunks(source_text)
        embeddings = asyncio.run(embed_texts(chunks))

        # Atomic full-replace: delete + insert + status flip all happen in
        # the same transaction, committed once at the end, so a concurrent
        # reader never observes a half-replaced chunk set (old rows gone,
        # new rows not fully written yet) or a stale-but-still-visible set.
        session.execute(
            text("DELETE FROM chunks WHERE document_id = :document_id"),
            {"document_id": document_id},
        )
        for position, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
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
        session.execute(
            text("UPDATE documents SET status = 'ready' WHERE id = :document_id"),
            {"document_id": document_id},
        )
        record_event_sync(
            session, "document.chunking_succeeded", f"document_id={document_id}"
        )
        session.commit()
    except Exception as exc:
        mark_document_failed(document_id, session, exc)
