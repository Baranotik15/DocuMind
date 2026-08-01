import uuid

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db_sync import SyncSessionLocal


def _insert_event(event_type: str, detail: str, created_at: str) -> str:
    # Raw SQL (rather than record_event_async/record_event_sync, which both
    # always default created_at to now()) so the two seeded events get
    # explicit, unambiguously-ordered timestamps - making the
    # newest-first assertion below deterministic rather than dependent on
    # clock resolution between two back-to-back INSERTs.
    with SyncSessionLocal() as session:
        row = session.execute(
            text(
                "INSERT INTO dashboard_events (type, detail, created_at) "
                "VALUES (:type, :detail, :created_at) RETURNING id"
            ),
            {"type": event_type, "detail": detail, "created_at": created_at},
        ).scalar_one()
        session.commit()
    return str(row)


def _cleanup_events(event_ids: list[str]) -> None:
    if not event_ids:
        return
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM dashboard_events WHERE id = ANY(:ids)"),
            {"ids": event_ids},
        )
        session.commit()


def test_get_dashboard_events_returns_newest_first_with_expected_shape(
    client: TestClient,
) -> None:
    older_detail = f"older-{uuid.uuid4()}"
    newer_detail = f"newer-{uuid.uuid4()}"
    event_ids: list[str] = []
    try:
        event_ids.append(
            _insert_event("document.uploaded", older_detail, "2020-01-01T00:00:00Z")
        )
        event_ids.append(
            _insert_event("chat.message_sent", newer_detail, "2020-01-02T00:00:00Z")
        )

        response = client.get("/internal/dashboard/events")
        assert response.status_code == 200

        body = response.json()
        matching = [e for e in body if e["detail"] in (older_detail, newer_detail)]
        assert len(matching) == 2
        # Newest first - the opposite order from chat's list_messages, which
        # is ascending.
        assert matching[0]["detail"] == newer_detail
        assert matching[0]["type"] == "chat.message_sent"
        assert matching[1]["detail"] == older_detail
        assert matching[1]["type"] == "document.uploaded"

        for event in matching:
            assert set(event.keys()) == {"id", "type", "timestamp", "detail"}
            assert event["id"] in event_ids
    finally:
        _cleanup_events(event_ids)


def test_get_dashboard_events_empty_result_is_a_valid_empty_list(
    client: TestClient,
) -> None:
    response = client.get("/internal/dashboard/events")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
