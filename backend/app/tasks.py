from datetime import datetime, timezone

from sqlalchemy import text

from app import deps
from app.celery_app import celery_app
from app.db_sync import SyncSessionLocal
from app.documents import extract_text
from app.pipeline import run_pipeline


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
    the pipeline directly over it, no storage access."""
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

        data = deps.get_storage().read(row.storage_key)
        extracted_text = extract_text(row.filename, data)
        run_pipeline(document_id, extracted_text, session)
