from sqlalchemy import text

from app.db.sync_session import SyncSessionLocal
from app.documents import deps
from app.documents.extraction import extract_text
from app.documents.pipeline import (
    mark_document_failed,
    run_pipeline,
    run_pipeline_with_manual_chunks,
)
from app.worker.celery_app import celery_app


class DocumentNotFoundError(Exception):
    pass


@celery_app.task(name="run_document_pipeline")
def run_document_pipeline(
    document_id: str,
    source_text: str | None = None,
    manual_chunks: list[str] | None = None,
) -> None:
    """Three entry paths, checked in this order:

    1. `manual_chunks` given (manual-boundaries re-chunk path,
       Save-triggered with manualBoundaries=True): runs
       run_pipeline_with_manual_chunks directly over the given ordered
       list of chunk texts, skipping the algorithmic splitter entirely.
       Takes precedence over `source_text` if both were somehow given -
       the router endpoint only ever passes one or the other, never both,
       but manual_chunks winning is the safer interpretation: an
       operator's explicit boundary edits should never be silently
       discarded in favor of a full re-chunk.
    2. Else, `source_text` given (automatic re-chunk path, Save-triggered
       with manualBoundaries=False/default): runs the pipeline directly
       over it via run_pipeline (algorithmic split), no storage access.
    3. Else (initial-processing path, both None): reads the document's
       filename/storage_key, reads the file via deps.get_storage(),
       extracts its text, then runs run_pipeline over that.

    The storage-read + extract_text step (initial-processing path only)
    happens before run_pipeline ever runs, so it can't rely on
    run_pipeline's own try/except to catch a bad file. It gets its own
    try/except here, funneled through pipeline.mark_document_failed - the
    exact same failure boundary run_pipeline/run_pipeline_with_manual_chunks
    use internally - so a missing storage object, an unsupported file
    type, or a corrupt PDF/DOCX gives the same guarantee as a
    chunking/embedding failure: the document lands on 'failed' with a
    non-empty error detail recorded as a dashboard event, never stuck at
    'uploaded' indefinitely.

    Deliberately does NOT flip the document to 'chunking' first in this
    case: chunking hasn't started yet (there's no text to chunk until
    extraction succeeds), so going straight 'uploaded' -> 'failed' is the
    more accurate status history, and it avoids a duplicate
    'chunking_started' event being recorded right before run_pipeline
    would record its own on the same run."""
    if manual_chunks is not None:
        with SyncSessionLocal() as session:
            run_pipeline_with_manual_chunks(document_id, manual_chunks, session)
        return

    if source_text is not None:
        with SyncSessionLocal() as session:
            run_pipeline(document_id, source_text, session)
        return

    with SyncSessionLocal() as session:
        row = session.execute(
            text(
                "SELECT filename, storage_key FROM documents WHERE id = :document_id"
            ),
            {"document_id": document_id},
        ).one_or_none()
        if row is None:
            raise DocumentNotFoundError(document_id)

        try:
            data = deps.get_storage().read(row.storage_key)
            extracted_text = extract_text(row.filename, data)
        except Exception as exc:
            mark_document_failed(document_id, session, exc)
            return  # unreachable: mark_document_failed always raises

        run_pipeline(document_id, extracted_text, session)
