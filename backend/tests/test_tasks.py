import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text

from app.chunks.headings import HeadingMarker
from app.db.sync_session import SyncSessionLocal
from app.documents import deps
from app.documents.extraction import ExtractedDocument
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


def _insert_document_without_stored_file(
    session, *, status: str = "uploaded"
) -> tuple[str, str]:
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
    return str(document_id), filename


def _insert_document_with_stored_file(
    session, *, status: str = "uploaded"
) -> tuple[str, str]:
    # Unlike _insert_document_without_stored_file above, this one also
    # writes real bytes to storage at the matching storage_key, so
    # run_document_pipeline's initial-processing path (deps.get_storage()
    # .read(...)) succeeds - the exact bytes don't matter for tests that go
    # on to patch extract_document itself, only that the read step doesn't
    # raise StorageKeyNotFoundError.
    filename = f"tasks-test-{uuid.uuid4()}.txt"
    storage_key = f"docs/{filename}"
    document_id = session.execute(
        text(
            "INSERT INTO documents (filename, storage_key, status) "
            "VALUES (:filename, :storage_key, :status) RETURNING id"
        ),
        {"filename": filename, "storage_key": storage_key, "status": status},
    ).scalar_one()
    session.commit()
    deps.get_storage().save(storage_key, b"placeholder bytes - extract_document is mocked")
    return str(document_id), filename


def _chunk_rows(session, document_id: str) -> list:
    return session.execute(
        text(
            "SELECT position, original_content, edited_content "
            "FROM chunks WHERE document_id = :document_id ORDER BY position"
        ),
        {"document_id": document_id},
    ).all()


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    return [[0.1] * 1536 for _ in texts]


def _document_status(session, document_id: str) -> str:
    return session.execute(
        text("SELECT status FROM documents WHERE id = :document_id"),
        {"document_id": document_id},
    ).scalar_one()


def _matching_events(session, event_type: str, filename: str) -> list:
    """Rows (detail, user_email) of `event_type` events that carry this
    test's own filename in `detail` - mirrors test_pipeline.py's helper of
    the same name."""
    rows = session.execute(
        text("SELECT detail, user_email FROM dashboard_events WHERE type = :type"),
        {"type": event_type},
    ).all()
    return [row for row in rows if filename in row.detail]


def _cleanup(document_id: str, filename: str) -> None:
    # Also deletes every dashboard_events row this test's own
    # run_document_pipeline call created (document.chunking_failed here -
    # see app.documents.pipeline's mark_document_failed/record_event_sync)
    # so it never lingers in the live-shared dashboard_events table the
    # live Dashboard reads from - every one of those rows embeds
    # `filename=<name>` in `detail`, so a LIKE match on this test's own
    # filename is precise and doesn't touch any other test's rows.
    with SyncSessionLocal() as session:
        session.execute(
            text(
                "DELETE FROM dashboard_events WHERE detail LIKE "
                "'%' || :filename || '%'"
            ),
            {"filename": filename},
        )
        session.execute(
            text("DELETE FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        )
        session.commit()


def _delete_stored_file(filename: str) -> None:
    """Best-effort cleanup for tests using _insert_document_with_stored_file
    above - removes the placeholder bytes written directly to storage
    (bypassing the router, which would otherwise delete the file itself on
    document delete, see test_documents_router.py's delete tests)."""
    deps.get_storage().delete(f"docs/{filename}")


def test_run_document_pipeline_storage_read_failure_marks_document_failed_not_stuck() -> None:
    """Regression test for the bug where a storage-read failure (file
    missing from storage) on the initial-processing path (source_text=None)
    propagated straight out of run_document_pipeline, uncaught, leaving the
    document stuck at 'uploaded' forever with no recorded error. Confirmed
    live before this fix via a real StorageKeyNotFoundError."""
    with SyncSessionLocal() as session:
        document_id, filename = _insert_document_without_stored_file(session)

    try:
        with pytest.raises(DocumentProcessingError) as exc_info:
            run_document_pipeline(document_id)

        # The chained cause is the real root cause (a missing storage
        # object), not swallowed or replaced.
        assert isinstance(exc_info.value.__cause__, StorageKeyNotFoundError)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            matching = _matching_events(session, "document.chunking_failed", filename)
            assert matching
            # This test calls run_document_pipeline directly with no
            # user_email given (unlike the real router call sites, which
            # always thread one through - see app.documents.tasks
            # .run_document_pipeline's docstring), so it lands as None here.
            assert all(len(row.detail) > 0 and row.user_email is None for row in matching)
    finally:
        _cleanup(document_id, filename)


def test_run_document_pipeline_initial_processing_threads_extracted_headings_into_chunks() -> (
    None
):
    """The initial-processing path (source_text=None, manual_chunks=None)
    must call extract_document (not the removed extract_text) and thread
    its .headings into run_pipeline alongside .text. Proven by patching
    app.documents.tasks.extract_document to return a fixed
    ExtractedDocument whose headings split the resulting chunks at exact
    offsets a paragraph/token-limited split alone wouldn't have produced -
    same style of section-boundary assertion as test_pipeline.py's
    test_run_pipeline_with_headings_splits_at_heading_boundaries_not_paragraphs."""
    first_title = "Introduction"
    second_title = "Refund Policy"
    extracted_text = (
        f"{first_title}\n"
        "This is the introduction body, with no blank line separating it "
        "from the heading above or the next section below.\n"
        f"{second_title}\n"
        "This is the second section's body text, also with no blank-line "
        "paragraph break anywhere nearby."
    )
    second_offset = extracted_text.index(second_title)
    fixed_extraction = ExtractedDocument(
        text=extracted_text,
        headings=[
            HeadingMarker(offset=0, level=1),
            HeadingMarker(offset=second_offset, level=1),
        ],
    )

    with SyncSessionLocal() as session:
        document_id, filename = _insert_document_with_stored_file(session)

    try:
        with (
            patch("app.documents.tasks.extract_document", return_value=fixed_extraction),
            patch(
                "app.documents.pipeline.embed_texts",
                new=AsyncMock(side_effect=_fake_embed_texts),
            ),
        ):
            run_document_pipeline(document_id)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            rows = _chunk_rows(session, document_id)
            assert "".join(row.edited_content for row in rows) == extracted_text
            assert "".join(row.original_content for row in rows) == extracted_text

            # Exactly one chunk per given heading, split at each heading's
            # own offset - not wherever paragraph/token limits alone would
            # have landed (a single chunk, given this text has no blank
            # lines and fits well under DEFAULT_MAX_TOKENS).
            assert len(rows) == 2
            assert rows[0].original_content == extracted_text[:second_offset]
            assert rows[1].original_content == extracted_text[second_offset:]
    finally:
        _cleanup(document_id, filename)
        _delete_stored_file(filename)
