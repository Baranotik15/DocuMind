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
from app.documents.tasks import run_document_pipeline
from app.main import app


@pytest.fixture
def client(authenticated_client: TestClient) -> TestClient:
    # GET /internal/documents and friends now require a session (see
    # app/main.py's include_router(..., dependencies=[Depends(require_session)])) -
    # this overrides the plain, unauthenticated `client` fixture from
    # conftest.py for every test in this module, so none of the test
    # bodies below had to change. test_list_documents_without_session_cookie_returns_401
    # further down builds its own bare TestClient directly to prove the
    # guard is actually wired up, rather than relying on this override.
    return authenticated_client


@pytest.fixture(autouse=True)
def _celery_eager() -> None:
    # Matches the project-wide convention (test_smoke_job.py, test_pipeline.py)
    # of forcing eager execution so uploads' enqueued pipeline task actually
    # runs inline, with no broker/worker round trip.
    from app.worker.celery_app import celery_app

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


@pytest.fixture(autouse=True)
def _pipeline_dispatch_runs_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fixes the real root cause of the live Dashboard's event log getting
    polluted with test noise every time this suite runs: `run_document_pipeline
    .delay(...)` on a live, real Celery app (this project's `celery_broker_url`
    always points at the real, shared Redis broker - there is no separate
    test broker) publishes a real message, and the separately-running
    `worker` container (a different OS process entirely) picks it up and
    executes the pipeline for real - against this same shared dev DB and
    dev Dashboard.

    Worse, this file's own `patch("app.documents.pipeline.embed_texts", ...)`
    mocks below only patch THIS test process's own memory - they have zero
    effect on whatever the separate worker process actually runs. So without
    this fixture, hitting POST /internal/documents for real isn't just
    polluting the live event log, it also silently stops testing what it
    looks like it's testing (the worker's real, unpatched pipeline decides
    the resulting document/chunk state, asynchronously, well after this
    test's own assertions already ran).

    Patches `run_document_pipeline.delay` itself - the same Task singleton
    referenced both here (via app.documents.router) and by
    app.chunks.router - to call the task's own underlying function directly
    instead of going through Celery's dispatch machinery at all: synchronous,
    in-process, no broker round trip, no dependence on the `task_always_eager`
    config `_celery_eager` above sets (this makes that guarantee
    unconditional rather than relying on a mutable global Celery singleton
    staying correctly configured). Every assertion below that treats the
    pipeline as having already finished by the time the response comes back
    (e.g. status == "ready") stays true and deterministic under this, exactly
    as it did when eager mode was doing its job - it just no longer depends
    on that global config bit.
    """

    def _run_inline(*args, **kwargs):
        return run_document_pipeline(*args, **kwargs)

    monkeypatch.setattr(run_document_pipeline, "delay", _run_inline)


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    # External-boundary mock (app.documents.pipeline.embed_texts) so no real OpenAI
    # call happens - same pattern as test_pipeline.py.
    return [[0.1] * 1536 for _ in texts]


def _unique_filename(suffix: str = ".txt") -> str:
    return f"router-test-{uuid.uuid4()}{suffix}"


def _cleanup(filename: str, document_id: str | None = None) -> None:
    """Deletes the test's own `documents` row (by filename) AND every
    `dashboard_events` row it created - both the router's own
    document.uploaded/document.deleted events and, now that the pipeline
    fixture above runs inline in-process, the pipeline's own
    document.chunking_started/succeeded/failed events, all recorded into
    this same shared dev Postgres the live Dashboard reads from (see
    app.documents.router/app.documents.pipeline's record_event_* call
    sites - every one of them embeds `document_id=<id>` in `detail`).

    `document_id` should be passed explicitly whenever the caller already
    has it (most tests below do) - required for tests whose own endpoint
    call already deleted the document row before this runs (the filename
    lookup below would otherwise find nothing to key the events cleanup
    off of). Falls back to looking it up by filename otherwise.
    """
    with SyncSessionLocal() as session:
        if document_id is None:
            document_id = session.execute(
                text("SELECT id FROM documents WHERE filename = :filename"),
                {"filename": filename},
            ).scalar_one_or_none()
        if document_id is not None:
            session.execute(
                text(
                    "DELETE FROM dashboard_events WHERE detail LIKE "
                    "'%' || :document_id || '%'"
                ),
                {"document_id": str(document_id)},
            )
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
    document_id = None
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
        document_id = body["id"]
        assert body["filename"] == filename
        # The pipeline dispatch fixture above runs it inline, in-process -
        # by the time we get a response, status may already be 'ready'.
        assert body["status"] in ("uploaded", "ready")
        assert "id" in body
        assert "uploadedAt" in body

        list_response = client.get("/internal/documents")
        assert list_response.status_code == 200
        filenames = [doc["filename"] for doc in list_response.json()]
        assert filename in filenames
    finally:
        _cleanup(filename, document_id)


def test_upload_path_traversal_filename_does_not_escape_storage_base_dir(
    client: TestClient,
) -> None:
    malicious_filename = "../../../../evil-traversal.txt"
    document_id = None
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
        document_id = body["id"]
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
        _cleanup(malicious_filename, document_id)


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
    original_id = None
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
        _cleanup(filename, original_id)


def test_upload_duplicate_filename_with_overwrite_reuses_same_id(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    original_id = None
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
        _cleanup(filename, original_id)


def test_upload_overwrite_while_chunking_returns_409_document_processing(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    document_id = None
    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            first = client.post(
                "/internal/documents",
                files={"file": (filename, io.BytesIO(b"Original content."), "text/plain")},
            )
        assert first.status_code == 200
        document_id = first.json()["id"]

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
        _cleanup(filename, document_id)


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
        _cleanup(filename, document_id)


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
        _cleanup(filename, document_id)


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
    document_id = None

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
        document_id = matching[0]["id"]
    finally:
        _cleanup(filename, document_id)


def test_delete_document_records_document_deleted_dashboard_event(
    client: TestClient,
) -> None:
    filename = _unique_filename()
    document_id = None
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
        # document_id is passed explicitly (not left to _cleanup's own
        # filename-based fallback lookup) because the document row itself is
        # already gone by this point (deleted above) - a filename lookup
        # here would find nothing, and the document.uploaded/chunking_*/
        # deleted events this test's own requests created would leak.
        _cleanup(filename, document_id)


def test_list_documents_without_session_cookie_returns_401() -> None:
    # A bare TestClient built directly (not via this module's `client`
    # fixture override, which is always pre-authenticated) so this request
    # genuinely carries no `session` cookie - proving require_session is
    # actually wired up on documents_router's include_router(...) call,
    # not just incidentally satisfied by every other test using the
    # authenticated fixture.
    with TestClient(app) as bare_client:
        response = bare_client.get("/internal/documents")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}
