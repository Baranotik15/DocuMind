import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.sync_session import SyncSessionLocal
from app.main import app


@pytest.fixture
def client(authenticated_client: TestClient) -> TestClient:
    # analysis_router now requires a session (see app/main.py) - overrides
    # conftest.py's plain, unauthenticated `client` fixture for every test
    # in this module, same idiom as test_chat_router.py/test_documents_router.py.
    return authenticated_client


def _insert_report(
    *,
    status: str,
    started_by_email: str,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
    gap_analysis: str | None = None,
    conflicts: list | None = None,
    total_tokens: int | None = None,
    error_detail: str | None = None,
) -> str:
    with SyncSessionLocal() as session:
        report_id = session.execute(
            text(
                "INSERT INTO analysis_reports "
                "(status, started_by_email, started_at, completed_at, gap_analysis, "
                "conflicts, total_tokens, error_detail) "
                "VALUES (:status, :started_by_email, COALESCE(:started_at, now()), "
                ":completed_at, :gap_analysis, :conflicts ::jsonb, :total_tokens, "
                ":error_detail) "
                "RETURNING id"
            ),
            {
                "status": status,
                "started_by_email": started_by_email,
                "started_at": started_at,
                "completed_at": completed_at,
                "gap_analysis": gap_analysis,
                "conflicts": json.dumps(conflicts) if conflicts is not None else None,
                "total_tokens": total_tokens,
                "error_detail": error_detail,
            },
        ).scalar_one()
        session.commit()
    return str(report_id)


def _cleanup_reports(report_ids: list[str]) -> None:
    if not report_ids:
        return
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM analysis_reports WHERE id = ANY(:ids)"), {"ids": report_ids}
        )
        session.commit()


def test_start_analysis_run_returns_201_running_and_dispatches_task(
    client: TestClient,
) -> None:
    report_ids: list[str] = []
    try:
        with patch("app.analysis.router.run_documentation_analysis.delay") as mock_delay:
            response = client.post("/internal/analysis/reports")

        assert response.status_code == 201
        body = response.json()
        report_ids.append(body["id"])
        assert body["status"] == "running"
        assert body["completedAt"] is None
        assert "startedAt" in body

        me_response = client.get("/internal/auth/me")
        assert me_response.status_code == 200
        assert body["startedByEmail"] == me_response.json()["email"]

        mock_delay.assert_called_once_with(body["id"])
    finally:
        _cleanup_reports(report_ids)


def test_list_analysis_reports_returns_seeded_rows_newest_first(
    client: TestClient,
) -> None:
    report_ids: list[str] = []
    try:
        now = datetime.now(timezone.utc)
        older_id = _insert_report(
            status="completed",
            started_by_email=f"list-older-{uuid.uuid4()}@example.com",
            started_at=now - timedelta(hours=2),
        )
        report_ids.append(older_id)
        newer_id = _insert_report(
            status="running",
            started_by_email=f"list-newer-{uuid.uuid4()}@example.com",
            started_at=now - timedelta(minutes=1),
        )
        report_ids.append(newer_id)

        response = client.get("/internal/analysis/reports")

        assert response.status_code == 200
        body = response.json()
        ids_in_order = [item["id"] for item in body]
        assert ids_in_order.index(newer_id) < ids_in_order.index(older_id)

        newer_item = next(item for item in body if item["id"] == newer_id)
        assert newer_item["status"] == "running"
        older_item = next(item for item in body if item["id"] == older_id)
        assert older_item["status"] == "completed"
    finally:
        _cleanup_reports(report_ids)


def test_get_analysis_report_returns_full_detail_for_completed_report(
    client: TestClient,
) -> None:
    report_ids: list[str] = []
    try:
        conflicts = [
            {
                "documentAId": str(uuid.uuid4()),
                "documentAFilename": "doc-a.txt",
                "chunkAId": str(uuid.uuid4()),
                "chunkAContent": "chunk a content",
                "documentBId": str(uuid.uuid4()),
                "documentBFilename": "doc-b.txt",
                "chunkBId": str(uuid.uuid4()),
                "chunkBContent": "chunk b content",
                "description": "they disagree about X",
            }
        ]
        report_id = _insert_report(
            status="completed",
            started_by_email=f"detail-{uuid.uuid4()}@example.com",
            completed_at=datetime.now(timezone.utc),
            gap_analysis="Group A: export questions.",
            conflicts=conflicts,
            total_tokens=321,
        )
        report_ids.append(report_id)

        response = client.get(f"/internal/analysis/reports/{report_id}")

        assert response.status_code == 200
        body = response.json()
        assert body["id"] == report_id
        assert body["status"] == "completed"
        assert body["gapAnalysis"] == "Group A: export questions."
        assert body["totalTokens"] == 321
        assert body["errorDetail"] is None
        assert body["completedAt"] is not None
        assert len(body["conflicts"]) == 1
        assert body["conflicts"][0]["description"] == "they disagree about X"
        assert body["conflicts"][0]["chunkAContent"] == "chunk a content"
    finally:
        _cleanup_reports(report_ids)


def test_get_analysis_report_unknown_id_returns_404(client: TestClient) -> None:
    response = client.get(f"/internal/analysis/reports/{uuid.uuid4()}")

    assert response.status_code == 404


def test_get_analysis_report_malformed_id_returns_422_not_500(client: TestClient) -> None:
    response = client.get("/internal/analysis/reports/not-a-uuid")

    assert response.status_code == 422


def test_start_analysis_run_without_session_cookie_returns_401() -> None:
    with TestClient(app) as bare_client:
        response = bare_client.post("/internal/analysis/reports")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


def test_list_analysis_reports_without_session_cookie_returns_401() -> None:
    with TestClient(app) as bare_client:
        response = bare_client.get("/internal/analysis/reports")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


def test_get_analysis_report_without_session_cookie_returns_401() -> None:
    with TestClient(app) as bare_client:
        response = bare_client.get(f"/internal/analysis/reports/{uuid.uuid4()}")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


def test_delete_analysis_report_returns_204_and_removes_it_from_the_list(
    client: TestClient,
) -> None:
    report_ids: list[str] = []
    try:
        report_id = _insert_report(
            status="completed",
            started_by_email=f"delete-{uuid.uuid4()}@example.com",
            completed_at=datetime.now(timezone.utc),
        )
        report_ids.append(report_id)

        response = client.delete(f"/internal/analysis/reports/{report_id}")

        assert response.status_code == 204
        assert response.content == b""

        list_response = client.get("/internal/analysis/reports")
        assert list_response.status_code == 200
        ids_in_list = [item["id"] for item in list_response.json()]
        assert report_id not in ids_in_list
    finally:
        _cleanup_reports(report_ids)


def test_delete_analysis_report_records_a_dashboard_event(client: TestClient) -> None:
    report_ids: list[str] = []
    try:
        report_id = _insert_report(
            status="completed",
            started_by_email=f"delete-log-{uuid.uuid4()}@example.com",
            completed_at=datetime.now(timezone.utc),
        )
        report_ids.append(report_id)

        me_response = client.get("/internal/auth/me")
        deleting_user_email = me_response.json()["email"]

        response = client.delete(f"/internal/analysis/reports/{report_id}")
        assert response.status_code == 204

        with SyncSessionLocal() as session:
            events = session.execute(
                text(
                    "SELECT type, user_email FROM dashboard_events "
                    "WHERE type = 'analysis.run_deleted' AND user_email = :email"
                ),
                {"email": deleting_user_email},
            ).all()
        # authenticated_client provisions a fresh UUID-random email per
        # test (see conftest.py), so this email is unique to this test -
        # exactly one event is expected, not just "at least one".
        assert len(events) == 1
    finally:
        _cleanup_reports(report_ids)


def test_delete_analysis_report_unknown_id_returns_404(client: TestClient) -> None:
    response = client.delete(f"/internal/analysis/reports/{uuid.uuid4()}")

    assert response.status_code == 404


def test_delete_analysis_report_malformed_id_returns_422_not_500(client: TestClient) -> None:
    response = client.delete("/internal/analysis/reports/not-a-uuid")

    assert response.status_code == 422


def test_delete_analysis_report_without_session_cookie_returns_401() -> None:
    with TestClient(app) as bare_client:
        response = bare_client.delete(f"/internal/analysis/reports/{uuid.uuid4()}")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}
