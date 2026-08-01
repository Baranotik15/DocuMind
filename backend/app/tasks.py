from datetime import datetime, timezone

from sqlalchemy import text

from app import deps
from app.celery_app import celery_app
from app.db_sync import SyncSessionLocal
from app.documents import extract_text
from app.pipeline import mark_document_failed, run_pipeline


class SmokeJobNotFoundError(Exception):
    pass


class DocumentNotFoundError(Exception):
    pass


@celery_app.task(name="run_smoke_job")
def run_smoke_job(job_id: str) -> None:
    with SyncSessionLocal() as session:
        result = session.execute(
            text(
                "UPDATE smoke_jobs SET status = 'done', completed_at = :completed_at "
                "WHERE id = :job_id"
            ),
            {"completed_at": datetime.now(timezone.utc), "job_id": job_id},
        )
        if result.rowcount == 0:
            raise SmokeJobNotFoundError(job_id)
        session.commit()


@celery_app.task(name="run_document_pipeline")
def run_document_pipeline(document_id: str, source_text: str | None = None) -> None:
    """If source_text is None (initial-processing path): reads the
    document's filename/storage_key, reads the file via
    deps.get_storage(), extracts its text, then runs the pipeline over
    that. If source_text is given (re-chunk path, Save-triggered): runs
    the pipeline directly over it, no storage access.

    The storage-read + extract_text step (initial-processing path only)
    happens before run_pipeline ever runs, so it can't rely on
    run_pipeline's own try/except to catch a bad file. It gets its own
    try/except here, funneled through pipeline.mark_document_failed - the
    exact same failure boundary run_pipeline uses internally - so a
    missing storage object, an unsupported file type, or a corrupt
    PDF/DOCX gives the same guarantee as a chunking/embedding failure:
    the document lands on 'failed' with a non-empty error detail recorded
    as a dashboard event, never stuck at 'uploaded' indefinitely.

    Deliberately does NOT flip the document to 'chunking' first in this
    case: chunking hasn't started yet (there's no text to chunk until
    extraction succeeds), so going straight 'uploaded' -> 'failed' is the
    more accurate status history, and it avoids a duplicate
    'chunking_started' event being recorded right before run_pipeline
    would record its own on the same run."""
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
