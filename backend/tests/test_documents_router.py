import io
import threading
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import Settings, get_settings
from app.documents import router as documents_router
from app.db.sync_session import SyncSessionLocal
from app.documents.deps import get_storage
from app.documents.storage import StorageKeyNotFoundError


@pytest.fixture(autouse=True)
def _celery_eager() -> None:
    # Matches the project-wide convention (test_smoke_job.py, test_pipeline.py)
    # of forcing eager execution so uploads' enqueued pipeline task actually
    # runs inline, with no broker/worker round trip.
    from app.worker.celery_app import celery_app

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    # External-boundary mock (app.documents.pipeline.embed_texts) so no real OpenAI
    # call happens - same pattern as test_pipeline.py.
    return [[0.1] * 1536 for _ in texts]


def _unique_filename(suffix: str = ".txt") -> str:
    return f"router-test-{uuid.uuid4()}{suffix}"


def _cleanup(filename: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM documents WHERE filename = :filename"),
            {"filename": filename},
        )
        session.commit()


def _force_status(filename: str, status: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("UPDATE documents SET status = :status WHERE filename = :filename"),
            {"status": status, "filename": filename},
        )
        session.commit()


def test_upload_txt_document_is_visible_via_list(client: TestClient) -> None:
    filename = _unique_filename()
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            response = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Hello, router test."), "text/plain")},
            )

        assert response.status_code == 200
        body = response.json()
        assert body["filename"] == filename
        # Celery is eager, so the pipeline runs inline during the request -
        # by the time we get a response, status may already be 'ready'.
        assert body["status"] in ("uploaded", "ready")
        assert "id" in body
        assert "uploadedAt" in body

        list_response = client.get("/internal/documents")
        assert list_response.status_code == 200
        filenames = [doc["filename"] for doc in list_response.json()]
        assert filename in filenames
    finally:
        _cleanup(filename)


def test_upload_path_traversal_filename_does_not_escape_storage_base_dir(
    client: TestClient,
) -> None:
    malicious_filename = "../../../../evil-traversal.txt"
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            response = client.post(
                "/internal/documents",
                files={
                    "file": (malicious_filename, io.BytesIO(b"payload"), "text/plain")
                },
            )

        assert response.status_code == 200
        body = response.json()
        # filename is kept verbatim as display/lookup metadata...
        assert body["filename"] == malicious_filename

        with SyncSessionLocal() as session:
            storage_key = session.execute(
                text("SELECT storage_key FROM documents WHERE id = :id"),
                {"id": body["id"]},
            ).scalar_one()

        # ...but the storage key must never be derived from it: no `..`
        # segments, and it must resolve inside storage_base_dir rather than
        # wherever the traversal would otherwise point.
        assert ".." not in storage_key
        base_dir = Path(get_settings().storage_base_dir).resolve()
        resolved = (base_dir / storage_key).resolve()
        assert resolved.is_relative_to(base_dir)
        assert resolved.is_file()
    finally:
        _cleanup(malicious_filename)


def test_upload_over_size_limit_returns_413_and_is_not_listed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        documents_router, "get_settings", lambda: Settings(max_upload_size_bytes=10)
    )
    filename = _unique_filename()

    response = client.post(
        "/internal/documents",
        files={
            "file": (filename, io.BytesIO(b"this payload is over ten bytes"), "text/plain")
        },
    )

    assert response.status_code == 413
    assert response.json()["detail"] == "file_too_large"

    list_response = client.get("/internal/documents")
    filenames = [doc["filename"] for doc in list_response.json()]
    assert filename not in filenames


def test_upload_unsupported_extension_returns_400_and_is_not_listed(
    client: TestClient,
) -> None:
    filename = _unique_filename(".exe")

    response = client.post(
        "/internal/documents",
        files={"file": (filename, io.BytesIO(b"MZ..."), "application/octet-stream")},
    )

    assert response.status_code == 400

    list_response = client.get("/internal/documents")
    filenames = [doc["filename"] for doc in list_response.json()]
    assert filename not in filenames


def test_upload_duplicate_filename_without_overwrite_returns_409(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            first = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Original content."), "text/plain")},
            )
        assert first.status_code == 200
        original_id = first.json()["id"]

        second = client.post(
            "/internal/documents",
            files={"file": (filename, io.BytesIO(b"New content."), "text/plain")},
        )

        assert second.status_code == 409
        assert second.json()["detail"] == "duplicate_filename"

        list_response = client.get("/internal/documents")
        matching = [doc for doc in list_response.json() if doc["filename"] == filename]
        assert len(matching) == 1
        assert matching[0]["id"] == original_id
    finally:
        _cleanup(filename)


def test_upload_duplicate_filename_with_overwrite_reuses_same_id(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            first = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Original content."), "text/plain")},
            )
            assert first.status_code == 200
            original_id = first.json()["id"]

            second = client.post(
                "/internal/documents",
                files={
                    "file": (filename, io.BytesIO(b"Replacement content."), "text/plain")
                },
                data={"overwrite": "true"},
            )

        assert second.status_code == 200
        assert second.json()["id"] == original_id

        list_response = client.get("/internal/documents")
        matching = [doc for doc in list_response.json() if doc["filename"] == filename]
        assert len(matching) == 1
    finally:
        _cleanup(filename)


def test_upload_overwrite_while_chunking_returns_409_document_processing(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            first = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Original content."), "text/plain")},
            )
        assert first.status_code == 200

        _force_status(filename, "chunking")

        second = client.post(
            "/internal/documents",
            files={
                "file": (filename, io.BytesIO(b"Replacement content."), "text/plain")
            },
            data={"overwrite": "true"},
        )

        assert second.status_code == 409
        assert second.json()["detail"] == "document_processing"
    finally:
        _cleanup(filename)


def test_delete_ready_document_returns_204_and_removes_document_chunks_and_file(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            upload = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Delete me please."), "text/plain")},
            )
        assert upload.status_code == 200
        document_id = upload.json()["id"]

        with SyncSessionLocal() as session:
            storage_key = session.execute(
                text("SELECT storage_key FROM documents WHERE id = :id"),
                {"id": document_id},
            ).scalar_one()

        response = client.delete(f"/internal/documents/{document_id}")

        assert response.status_code == 204
        assert response.content == b""

        list_response = client.get("/internal/documents")
        filenames = [doc["filename"] for doc in list_response.json()]
        assert filename not in filenames

        # The `chunks.document_id REFERENCES documents(id) ON DELETE CASCADE`
        # FK (0003 migration) means chunks are removed automatically by
        # Postgres once the document row is gone - verified here via the
        # chunks endpoint rather than a direct DB check.
        chunks_response = client.get(f"/internal/documents/{document_id}/chunks")
        assert chunks_response.status_code == 200
        assert chunks_response.json() == []

        storage = get_storage()
        with pytest.raises(StorageKeyNotFoundError):
            storage.read(storage_key)
    finally:
        _cleanup(filename)


def test_delete_chunking_document_returns_409_and_leaves_it_and_chunks_intact(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            upload = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Busy document."), "text/plain")},
            )
        assert upload.status_code == 200
        document_id = upload.json()["id"]

        _force_status(filename, "chunking")

        response = client.delete(f"/internal/documents/{document_id}")

        assert response.status_code == 409
        assert response.json()["detail"] == "document_processing"

        list_response = client.get("/internal/documents")
        filenames = [doc["filename"] for doc in list_response.json()]
        assert filename in filenames

        chunks_response = client.get(f"/internal/documents/{document_id}/chunks")
        assert chunks_response.status_code == 200
        assert len(chunks_response.json()) > 0
    finally:
        _cleanup(filename)


def test_delete_nonexistent_document_returns_404(client: TestClient) -> None:
    response = client.delete(f"/internal/documents/{uuid.uuid4()}")

    assert response.status_code == 404
    assert response.json()["detail"] == "document_not_found"


def test_delete_malformed_document_id_returns_422_not_500(client: TestClient) -> None:
    response = client.delete("/internal/documents/not-a-uuid")

    assert response.status_code == 422


def test_concurrent_uploads_of_a_new_filename_never_500(client: TestClient) -> None:
    # Two requests racing to insert the same brand-new filename: the
    # documents.filename UNIQUE constraint means one of them loses at the
    # DB level. Asserts the loser gets a clean 409 (see the IntegrityError
    # handler in documents/router.py's upload_document), never a raw 500,
    # and that exactly one document row survives either way.
    filename = _unique_filename()
    barrier = threading.Barrier(2)
    results: list[int] = []
    results_lock = threading.Lock()

    def _upload() -> None:
        barrier.wait()
        response = client.post(
            "/internal/documents",
            files={"file": (filename, io.BytesIO(b"Race payload."), "text/plain")},
        )
        with results_lock:
            results.append(response.status_code)

    try:
        # Patched once around both threads, not once per thread -
        # unittest.mock.patch's enter/exit isn't safe for two threads
        # concurrently patching the same attribute (one thread's __exit__
        # can restore the real function while the other thread's request
        # is still relying on the mock still being installed).
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            threads = [threading.Thread(target=_upload) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        assert 500 not in results
        assert sorted(results) == [200, 409]

        list_response = client.get("/internal/documents")
        matching = [doc for doc in list_response.json() if doc["filename"] == filename]
        assert len(matching) == 1
    finally:
        _cleanup(filename)


def test_delete_document_records_document_deleted_dashboard_event(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            upload = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Event check."), "text/plain")},
            )
        assert upload.status_code == 200
        document_id = upload.json()["id"]

        delete_response = client.delete(f"/internal/documents/{document_id}")
        assert delete_response.status_code == 204

        events_response = client.get("/internal/dashboard/events")
        assert events_response.status_code == 200
        matching = [
            event
            for event in events_response.json()
            if event["type"] == "document.deleted" and filename in event["detail"]
        ]
        assert len(matching) == 1
    finally:
        _cleanup(filename)
