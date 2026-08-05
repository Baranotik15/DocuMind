import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.sync_session import SyncSessionLocal
from app.documents.pipeline import DocumentProcessingError
from app.documents.tasks import run_document_pipeline

ZERO_VECTOR_1536 = "[" + ",".join(["0"] * 1536) + "]"


@pytest.fixture
def client(authenticated_client: TestClient) -> TestClient:
    # chunks_router now requires a session (see app/main.py) - overrides
    # conftest.py's plain, unauthenticated `client` fixture for every test
    # in this module.
    return authenticated_client


@pytest.fixture(autouse=True)
def _celery_eager() -> None:
    # Matches the project-wide convention (test_documents_router.py,
    # test_pipeline.py) of forcing eager execution so the re-chunk task
    # enqueued by save_chunks actually runs inline, with no broker/worker
    # round trip.
    from app.worker.celery_app import celery_app

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


@pytest.fixture(autouse=True)
def _pipeline_dispatch_runs_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same fix as test_documents_router.py's own fixture of the same name
    (see its docstring for the full root-cause explanation): `.delay()` on
    this project's real, live Celery app publishes to the real Redis broker,
    which the separately-running `worker` container would pick up and
    execute for real - polluting the live Dashboard's event log and running
    this file's `patch("app.documents.pipeline.embed_texts", ...)` mocks
    against a process they never touch. Patches `run_document_pipeline
    .delay` itself (the same Task singleton app.chunks.router references) to
    call the task's own underlying function directly instead - synchronous,
    in-process, no broker round trip, unconditionally (not dependent on the
    `task_always_eager` config `_celery_eager` above sets).
    """

    def _run_inline(*args, **kwargs):
        return run_document_pipeline(*args, **kwargs)

    monkeypatch.setattr(run_document_pipeline, "delay", _run_inline)


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    # External-boundary mock (app.documents.pipeline.embed_texts) so no real OpenAI
    # call happens - same pattern as test_pipeline.py /
    # test_documents_router.py.
    return [[0.1] * 1536 for _ in texts]


def _insert_document(*, status: str) -> str:
    filename = f"chunks-router-{uuid.uuid4()}.txt"
    with SyncSessionLocal() as session:
        document_id = session.execute(
            text(
                "INSERT INTO documents (filename, storage_key, status) "
                "VALUES (:filename, :storage_key, :status) RETURNING id"
            ),
            {"filename": filename, "storage_key": f"docs/{filename}", "status": status},
        ).scalar_one()
        session.commit()
    return str(document_id)


def _insert_chunk(document_id: str, position: int, original: str, edited: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, :position, :original, :edited, :embedding ::vector)"
            ),
            {
                "document_id": document_id,
                "position": position,
                "original": original,
                "edited": edited,
                "embedding": ZERO_VECTOR_1536,
            },
        )
        session.commit()


def _document_status(document_id: str) -> str:
    with SyncSessionLocal() as session:
        return session.execute(
            text("SELECT status FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        ).scalar_one()


def _chunk_rows(document_id: str) -> list:
    with SyncSessionLocal() as session:
        return session.execute(
            text(
                "SELECT position, original_content, edited_content "
                "FROM chunks WHERE document_id = :document_id ORDER BY position"
            ),
            {"document_id": document_id},
        ).all()


def _force_status(document_id: str, status: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("UPDATE documents SET status = :status WHERE id = :document_id"),
            {"status": status, "document_id": document_id},
        )
        session.commit()


def _cleanup(document_id: str) -> None:
    # Also deletes every dashboard_events row this test's own save_chunks
    # call(s) created (document.chunking_started/succeeded/failed - see
    # app.documents.pipeline's record_event_sync call sites, now running
    # inline in-process via the fixture above) - every one of them now
    # embeds `filename=<name>` in `detail`, not `document_id=<id>`, so the
    # filename is looked up from the still-live `documents` row first
    # (every test in this file inserts its document directly via
    # _insert_document and never deletes it before this runs, unlike
    # test_documents_router.py's own _cleanup, which matches by filename
    # directly since its document row may already be gone).
    with SyncSessionLocal() as session:
        filename = session.execute(
            text("SELECT filename FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        ).scalar_one_or_none()
        if filename is not None:
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


def test_get_chunks_malformed_document_id_returns_422_not_500(client: TestClient) -> None:
    response = client.get("/internal/documents/not-a-uuid/chunks")

    assert response.status_code == 422


def test_post_chunks_malformed_document_id_returns_422_not_500(client: TestClient) -> None:
    response = client.post("/internal/documents/not-a-uuid/chunks", json={"chunks": []})

    assert response.status_code == 422


def test_get_chunks_returns_them_in_position_order_with_isdirty_false(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="ready")
    try:
        # Insert out of position order to prove the endpoint orders by
        # `position`, not insertion order.
        _insert_chunk(document_id, 1, "second original", "second edited")
        _insert_chunk(document_id, 0, "first original", "first edited")

        response = client.get(f"/internal/documents/{document_id}/chunks")

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 2
        assert [chunk["originalContent"] for chunk in body] == [
            "first original",
            "second original",
        ]
        assert [chunk["editedContent"] for chunk in body] == [
            "first edited",
            "second edited",
        ]
        for chunk in body:
            assert chunk["documentId"] == document_id
            assert chunk["isDirty"] is False
            assert "id" in chunk
    finally:
        _cleanup(document_id)


def test_post_chunks_rechunks_document_and_reflects_edited_content(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="ready")
    try:
        _insert_chunk(document_id, 0, "stale original", "stale edited")

        new_text_parts = ["Edited paragraph one.\n\n", "Edited paragraph two."]
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            response = client.post(
                f"/internal/documents/{document_id}/chunks",
                json={"chunks": [{"editedContent": part} for part in new_text_parts]},
            )

        assert response.status_code == 202
        assert response.content == b""

        # Celery is eager, so the re-chunk pipeline has already run inline
        # by the time the response comes back.
        assert _document_status(document_id) == "ready"

        rows = _chunk_rows(document_id)
        reconstructed = "".join(row.edited_content for row in rows)
        assert reconstructed == "".join(new_text_parts)
        assert reconstructed != "stale edited"
    finally:
        _cleanup(document_id)


def test_post_chunks_records_the_acting_users_email_on_pipeline_events(
    client: TestClient,
) -> None:
    # save_chunks now threads its own Depends(require_session) user_email
    # through run_document_pipeline.delay(...) - see
    # app.chunks.router.save_chunks and app.documents.tasks
    # .run_document_pipeline's docstrings - so a Save/re-chunk's resulting
    # chunking_started/succeeded events should carry the acting user's
    # email, same as document.uploaded/document.deleted already do.
    document_id = _insert_document(status="ready")
    try:
        _insert_chunk(document_id, 0, "stale original", "stale edited")

        me_response = client.get("/internal/auth/me")
        assert me_response.status_code == 200
        expected_email = me_response.json()["email"]

        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            response = client.post(
                f"/internal/documents/{document_id}/chunks",
                json={"chunks": [{"editedContent": "new content for email check"}]},
            )
        assert response.status_code == 202

        with SyncSessionLocal() as session:
            filename = session.execute(
                text("SELECT filename FROM documents WHERE id = :document_id"),
                {"document_id": document_id},
            ).scalar_one()
            rows = session.execute(
                text(
                    "SELECT type, user_email FROM dashboard_events "
                    "WHERE type IN "
                    "('document.chunking_started', 'document.chunking_succeeded') "
                    "AND detail LIKE '%' || :filename || '%'"
                ),
                {"filename": filename},
            ).all()
        assert len(rows) == 2
        assert all(row.user_email == expected_email for row in rows)
    finally:
        _cleanup(document_id)


def test_post_chunks_on_uploaded_document_returns_409_and_leaves_chunks_untouched(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="uploaded")
    try:
        _insert_chunk(document_id, 0, "leftover original", "leftover edited")
        before = _chunk_rows(document_id)

        response = client.post(
            f"/internal/documents/{document_id}/chunks",
            json={"chunks": [{"editedContent": "new content"}]},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "document_processing"
        assert _document_status(document_id) == "uploaded"
        assert _chunk_rows(document_id) == before
    finally:
        _cleanup(document_id)


def test_post_chunks_while_already_chunking_returns_409_same_detail(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="ready")
    try:
        _insert_chunk(document_id, 0, "in-flight original", "in-flight edited")
        _force_status(document_id, "chunking")
        before = _chunk_rows(document_id)

        response = client.post(
            f"/internal/documents/{document_id}/chunks",
            json={"chunks": [{"editedContent": "should not apply"}]},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "document_processing"
        assert _document_status(document_id) == "chunking"
        assert _chunk_rows(document_id) == before
    finally:
        _cleanup(document_id)


def test_post_chunks_with_manual_boundaries_skips_rechunk_and_saves_exact_chunks(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="ready")
    try:
        _insert_chunk(document_id, 0, "stale original", "stale edited")

        # No blank-line paragraph separators between these, and well under
        # the 1500-char max_chars limit - if the algorithmic splitter ran
        # over the joined text, it would collapse into a single chunk.
        # Getting back exactly 3 chunks, matching this list verbatim,
        # proves the algorithm was skipped.
        manual_chunks = [
            "Manually placed chunk one.",
            "Manually placed chunk two.",
            "Manually placed chunk three.",
        ]
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            response = client.post(
                f"/internal/documents/{document_id}/chunks",
                json={
                    "chunks": [
                        {"editedContent": part} for part in manual_chunks
                    ],
                    "manualBoundaries": True,
                },
            )

        assert response.status_code == 202
        assert response.content == b""

        # Celery is eager, so the re-chunk pipeline has already run inline
        # by the time the response comes back.
        assert _document_status(document_id) == "ready"

        rows = _chunk_rows(document_id)
        assert [row.edited_content for row in rows] == manual_chunks
        assert [row.original_content for row in rows] == manual_chunks
    finally:
        _cleanup(document_id)


def test_post_chunks_with_manual_boundaries_on_uploaded_document_returns_409(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="uploaded")
    try:
        _insert_chunk(document_id, 0, "leftover original", "leftover edited")
        before = _chunk_rows(document_id)

        response = client.post(
            f"/internal/documents/{document_id}/chunks",
            json={
                "chunks": [{"editedContent": "new content"}],
                "manualBoundaries": True,
            },
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "document_processing"
        assert _document_status(document_id) == "uploaded"
        assert _chunk_rows(document_id) == before
    finally:
        _cleanup(document_id)


def test_post_chunks_with_manual_boundaries_while_already_chunking_returns_409(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="ready")
    try:
        _insert_chunk(document_id, 0, "in-flight original", "in-flight edited")
        _force_status(document_id, "chunking")
        before = _chunk_rows(document_id)

        response = client.post(
            f"/internal/documents/{document_id}/chunks",
            json={
                "chunks": [{"editedContent": "should not apply"}],
                "manualBoundaries": True,
            },
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "document_processing"
        assert _document_status(document_id) == "chunking"
        assert _chunk_rows(document_id) == before
    finally:
        _cleanup(document_id)


def test_post_chunks_with_manual_boundaries_failing_embedding_marks_document_failed(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="ready")
    try:
        _insert_chunk(
            document_id, 0, "pre-existing original", "pre-existing edited"
        )
        before = _chunk_rows(document_id)

        failing_embed_texts = AsyncMock(side_effect=RuntimeError("embedding API down"))
        with patch("app.documents.pipeline.embed_texts", new=failing_embed_texts):
            # Celery is eager with task_eager_propagates=True (project-wide
            # convention, see test_tasks.py), so the task runs inline
            # inside .delay() and its DocumentProcessingError propagates
            # straight out through this synchronous call - the endpoint
            # never gets a chance to return a response. What matters is
            # the terminal DB state mark_document_failed leaves behind.
            with pytest.raises(DocumentProcessingError):
                client.post(
                    f"/internal/documents/{document_id}/chunks",
                    json={
                        "chunks": [{"editedContent": "new chunk that fails to embed"}],
                        "manualBoundaries": True,
                    },
                )

        assert _document_status(document_id) == "failed"
        assert _chunk_rows(document_id) == before
    finally:
        _cleanup(document_id)
