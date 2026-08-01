import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text

from app.db_sync import SyncSessionLocal
from app.pipeline import DocumentProcessingError, run_pipeline

ZERO_VECTOR_1536 = "[" + ",".join(["0"] * 1536) + "]"


@pytest.fixture(autouse=True)
def _celery_eager() -> None:
    # run_pipeline itself is plain sync code, not a Celery task, but this
    # matches the project-wide convention (test_smoke_job.py) of forcing
    # eager execution so no test ever waits on a broker/worker round trip.
    from app.celery_app import celery_app

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


def _insert_document(session, *, status: str = "uploaded") -> str:
    filename = f"pipeline-{uuid.uuid4()}.txt"
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


def _chunk_rows(session, document_id: str) -> list:
    return session.execute(
        text(
            "SELECT position, original_content, edited_content, embedding "
            "FROM chunks WHERE document_id = :document_id ORDER BY position"
        ),
        {"document_id": document_id},
    ).all()


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


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    return [[0.1] * 1536 for _ in texts]


def test_run_pipeline_success_leaves_document_ready_with_exact_reconstruction() -> None:
    source_text = "First paragraph of the document.\n\nSecond paragraph, a bit longer.\n\nThird and final paragraph."

    with SyncSessionLocal() as session:
        document_id = _insert_document(session)

    try:
        with patch(
            "app.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                run_pipeline(document_id, source_text, session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            rows = _chunk_rows(session, document_id)
            assert len(rows) > 0
            assert "".join(row.edited_content for row in rows) == source_text
            assert "".join(row.original_content for row in rows) == source_text
            assert [row.position for row in rows] == list(range(len(rows)))
            for row in rows:
                assert row.embedding is not None

            assert any(
                document_id in detail
                for detail in _event_details(session, "document.chunking_started")
            )
            assert any(
                document_id in detail
                for detail in _event_details(session, "document.chunking_succeeded")
            )
    finally:
        _cleanup(document_id)


def test_run_pipeline_with_whitespace_only_source_text_marks_document_failed() -> None:
    # Reproduces the scanned-PDF bug: pypdf/extract_text can "succeed" (no
    # exception) while returning nothing but newlines - e.g. one \n per page
    # of an image-only PDF with no text layer. That must be treated as a
    # pipeline failure, not silently chunked/embedded into a useless
    # whitespace-only chunk that lands the document at 'ready'.
    with SyncSessionLocal() as session:
        document_id = _insert_document(session)

    try:
        with patch(
            "app.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                with pytest.raises(DocumentProcessingError):
                    run_pipeline(document_id, "\n\n\n", session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            failure_details = _event_details(session, "document.chunking_failed")
            matching = [detail for detail in failure_details if document_id in detail]
            assert matching
            assert all(len(detail) > 0 for detail in matching)

            rows = _chunk_rows(session, document_id)
            assert len(rows) == 0
    finally:
        _cleanup(document_id)


def test_run_pipeline_failure_marks_document_failed_and_leaves_old_chunks_untouched() -> None:
    with SyncSessionLocal() as session:
        document_id = _insert_document(session, status="ready")
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, 0, :content, :content, :embedding ::vector)"
            ),
            {
                "document_id": document_id,
                "content": "pre-existing chunk, untouched by a failed re-chunk",
                "embedding": ZERO_VECTOR_1536,
            },
        )
        session.commit()

    try:
        failing_embed_texts = AsyncMock(side_effect=RuntimeError("embedding API down"))
        with patch("app.pipeline.embed_texts", new=failing_embed_texts):
            with SyncSessionLocal() as session:
                with pytest.raises(DocumentProcessingError):
                    run_pipeline(document_id, "some new source text", session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            failure_details = _event_details(session, "document.chunking_failed")
            matching = [detail for detail in failure_details if document_id in detail]
            assert matching
            assert all(len(detail) > 0 for detail in matching)

            rows = _chunk_rows(session, document_id)
            assert len(rows) == 1
            assert rows[0].original_content == (
                "pre-existing chunk, untouched by a failed re-chunk"
            )
    finally:
        _cleanup(document_id)
