import uuid

import pytest
from sqlalchemy import text

from app.db.sync_session import SyncSessionLocal
from app.documents.pipeline import DocumentProcessingError
from app.documents.storage import StorageKeyNotFoundError
from app.documents.tasks import run_document_pipeline


@pytest.fixture(autouse=True)
def _celery_eager() -> None:
    # Matches the project-wide convention (test_smoke_job.py, test_pipeline.py)
    # of forcing eager execution, even though this file calls the task
    # function directly rather than via .delay().
    from app.worker.celery_app import celery_app

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


def _insert_document_without_stored_file(session, *, status: str = "uploaded") -> str:
    # Deliberately never calls storage.save() for this filename/storage_key,
    # so deps.get_storage().read(storage_key) fails with
    # StorageKeyNotFoundError - simulating a document row whose underlying
    # file is missing from storage (e.g. lost, or the pre-09433a5 bug
    # where a storage-read failure left a document stuck forever).
    filename = f"tasks-test-{uuid.uuid4()}.txt"
    document_id = session.execute(
        text(
            "INSERT INTO documents (filename, storage_key, status) "
            "VALUES (:filename, :storage_key, :status) RETURNING id"
        ),
        {"filename": filename, "storage_key": f"docs/{filename}", "status": status},
    ).scalar_one()
    session.commit()
    return str(document_id)


def _document_status(session, document_id: str) -> str:
    return session.execute(
        text("SELECT status FROM documents WHERE id = :document_id"),
        {"document_id": document_id},
    ).scalar_one()


def _event_details(session, event_type: str) -> list[str]:
    return [
        row.detail
        for row in session.execute(
            text("SELECT detail FROM dashboard_events WHERE type = :type"),
            {"type": event_type},
        ).all()
    ]


def _cleanup(document_id: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        )
        session.commit()


def test_run_document_pipeline_storage_read_failure_marks_document_failed_not_stuck() -> None:
    """Regression test for the bug where a storage-read failure (file
    missing from storage) on the initial-processing path (source_text=None)
    propagated straight out of run_document_pipeline, uncaught, leaving the
    document stuck at 'uploaded' forever with no recorded error. Confirmed
    live before this fix via a real StorageKeyNotFoundError."""
    with SyncSessionLocal() as session:
        document_id = _insert_document_without_stored_file(session)

    try:
        with pytest.raises(DocumentProcessingError) as exc_info:
            run_document_pipeline(document_id)

        # The chained cause is the real root cause (a missing storage
        # object), not swallowed or replaced.
        assert isinstance(exc_info.value.__cause__, StorageKeyNotFoundError)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            failure_details = _event_details(session, "document.chunking_failed")
            matching = [detail for detail in failure_details if document_id in detail]
            assert matching
            assert all(len(detail) > 0 for detail in matching)
    finally:
        _cleanup(document_id)
