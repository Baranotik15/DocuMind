import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import Settings
from app.db_sync import SyncSessionLocal
from app.routers import dashboard
from app.routers.dashboard import (
    _bucket_completions_tokens,
    _bucket_embeddings_tokens,
    _bucket_spend_amount,
    _project_to_3d,
    _summarize_openai_spend,
    _summarize_openai_tokens,
)
from app.vectors import format_vector


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


def _insert_message(
    role: str, content: str, created_at: datetime, disliked: bool = False
) -> str:
    # Raw SQL with an explicit created_at (bypassing chat_messages' own
    # now()-default, and the router's normal INSERT statements, both of
    # which always stamp "now") so this message can be placed deterministically
    # inside a specific bucket. Mirrors _insert_event's same reasoning above.
    with SyncSessionLocal() as session:
        row = session.execute(
            text(
                "INSERT INTO chat_messages (role, content, disliked, created_at) "
                "VALUES (:role, :content, :disliked, :created_at) RETURNING id"
            ),
            {
                "role": role,
                "content": content,
                "disliked": disliked,
                "created_at": created_at,
            },
        ).scalar_one()
        session.commit()
    return str(row)


def _cleanup_messages(message_ids: list[str]) -> None:
    if not message_ids:
        return
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM chat_messages WHERE id = ANY(:ids)"),
            {"ids": message_ids},
        )
        session.commit()


def _actual_count(table_name: str) -> int:
    with SyncSessionLocal() as session:
        return session.execute(text(f"SELECT COUNT(*) FROM {table_name}")).scalar_one()


def _actual_dislike_count() -> int:
    with SyncSessionLocal() as session:
        return session.execute(
            text("SELECT COUNT(*) FROM chat_messages WHERE disliked = true")
        ).scalar_one()


def _get_stats(client: TestClient, range_value: str) -> dict:
    response = client.get("/internal/dashboard/stats", params={"range": range_value})
    assert response.status_code == 200
    return response.json()


def test_stats_total_users_is_always_zero(client: TestClient) -> None:
    body = _get_stats(client, "day")
    assert body["totalUsers"] == 0


def test_stats_total_chunks_and_total_documents_match_actual_row_counts(
    client: TestClient,
) -> None:
    # This suite runs against the live dev Postgres (same caveat as
    # test_chat_router.py's top-chunks tests) - so the expected counts are
    # read directly from the DB at test time rather than hardcoded.
    expected_chunks = _actual_count("chunks")
    expected_documents = _actual_count("documents")

    body = _get_stats(client, "day")

    assert body["totalChunks"] == expected_chunks
    assert body["totalDocuments"] == expected_documents


def test_stats_total_dislikes_matches_actual_disliked_row_count_and_is_range_independent(
    client: TestClient,
) -> None:
    # totalDislikes is an all-time count, unlike dislikeBuckets (which is
    # scoped to the trailing window `range` implies) - so it must be
    # identical across every range value, not just correct for one.
    expected = _actual_dislike_count()

    for range_value in ("day", "7days", "month", "year"):
        body = _get_stats(client, range_value)
        assert body["totalDislikes"] == expected


@pytest.mark.parametrize(
    "range_value,expected_bucket_count",
    [("day", 12), ("7days", 7), ("month", 5), ("year", 12)],
)
def test_stats_returns_fixed_zero_filled_bucket_count_per_range(
    client: TestClient, range_value: str, expected_bucket_count: int
) -> None:
    body = _get_stats(client, range_value)

    assert len(body["messageBuckets"]) == expected_bucket_count
    assert len(body["dislikeBuckets"]) == expected_bucket_count
    for bucket in body["messageBuckets"] + body["dislikeBuckets"]:
        assert set(bucket.keys()) == {"bucketStart", "count"}
        assert isinstance(bucket["count"], int)
        assert bucket["count"] >= 0
        # Never omitted for having no data - every bucket, including
        # zero-count ones, is present as an explicit {"count": 0} entry
        # (implied by the fixed-length assertions above, since a dropped
        # empty bucket would shrink the list below expected_bucket_count).


def test_stats_invalid_range_returns_422(client: TestClient) -> None:
    response = client.get("/internal/dashboard/stats", params={"range": "nonsense"})
    assert response.status_code == 422


def test_stats_missing_range_returns_422(client: TestClient) -> None:
    response = client.get("/internal/dashboard/stats")
    assert response.status_code == 422


def test_stats_day_buckets_are_evenly_spaced_2_hours_ending_near_now(
    client: TestClient,
) -> None:
    body = _get_stats(client, "day")
    starts = [datetime.fromisoformat(b["bucketStart"]) for b in body["messageBuckets"]]

    for earlier, later in zip(starts, starts[1:]):
        assert later - earlier == timedelta(hours=2)

    now = datetime.now(timezone.utc)
    # Bucket 11 (the last) starts ~2h ago - allow a small tolerance for the
    # time elapsed between computing `now` here and the endpoint computing
    # its own `now` a moment earlier.
    assert timedelta(hours=1, minutes=59) <= now - starts[-1] <= timedelta(hours=2, minutes=1)


def test_stats_7days_buckets_are_evenly_spaced_24_hours_ending_near_now(
    client: TestClient,
) -> None:
    body = _get_stats(client, "7days")
    starts = [datetime.fromisoformat(b["bucketStart"]) for b in body["messageBuckets"]]

    for earlier, later in zip(starts, starts[1:]):
        assert later - earlier == timedelta(days=1)

    now = datetime.now(timezone.utc)
    assert timedelta(hours=23, minutes=59) <= now - starts[-1] <= timedelta(days=1, minutes=1)


def test_stats_month_buckets_are_evenly_spaced_7_days_ending_near_now(
    client: TestClient,
) -> None:
    body = _get_stats(client, "month")
    starts = [datetime.fromisoformat(b["bucketStart"]) for b in body["messageBuckets"]]

    for earlier, later in zip(starts, starts[1:]):
        assert later - earlier == timedelta(days=7)

    now = datetime.now(timezone.utc)
    assert timedelta(days=6, hours=23, minutes=59) <= now - starts[-1] <= timedelta(
        days=7, minutes=1
    )


def test_stats_year_buckets_are_calendar_months_starting_on_the_1st(
    client: TestClient,
) -> None:
    body = _get_stats(client, "year")
    starts = [datetime.fromisoformat(b["bucketStart"]) for b in body["messageBuckets"]]

    for start in starts:
        assert (start.day, start.hour, start.minute, start.second) == (1, 0, 0, 0)
        assert start.tzinfo is not None

    for earlier, later in zip(starts, starts[1:]):
        # Exactly one calendar month apart - not a fixed 28/29/30/31-day
        # timedelta, so compare year/month tuples instead of subtracting.
        months_earlier = earlier.year * 12 + earlier.month
        months_later = later.year * 12 + later.month
        assert months_later - months_earlier == 1

    now = datetime.now(timezone.utc)
    # The last bucket is the current (possibly incomplete) calendar month.
    assert (starts[-1].year, starts[-1].month) == (now.year, now.month)


def _assert_message_lands_only_in_expected_bucket(
    client: TestClient, range_value: str, bucket_index: int
) -> None:
    message_ids: list[str] = []
    try:
        before = _get_stats(client, range_value)
        starts = [
            datetime.fromisoformat(b["bucketStart"]) for b in before["messageBuckets"]
        ]
        assert len(starts) > bucket_index + 1  # keep a real "next" bucket to bound against

        target_start = starts[bucket_index]
        next_start = starts[bucket_index + 1]
        # Comfortably inside the bucket (its midpoint) - never on a boundary,
        # so small clock drift between the "before" and "after" requests
        # below can't flip which bucket it lands in.
        midpoint = target_start + (next_start - target_start) / 2

        message_ids.append(
            _insert_message("user", f"bucket probe {uuid.uuid4()}", midpoint)
        )

        after = _get_stats(client, range_value)

        assert len(after["messageBuckets"]) == len(before["messageBuckets"])
        for i, (before_bucket, after_bucket) in enumerate(
            zip(before["messageBuckets"], after["messageBuckets"])
        ):
            expected_delta = 1 if i == bucket_index else 0
            assert after_bucket["count"] == before_bucket["count"] + expected_delta, (
                range_value,
                i,
                before_bucket,
                after_bucket,
            )
    finally:
        _cleanup_messages(message_ids)


def test_stats_day_message_lands_in_expected_bucket_and_no_other(
    client: TestClient,
) -> None:
    _assert_message_lands_only_in_expected_bucket(client, "day", bucket_index=6)


def test_stats_7days_message_lands_in_expected_bucket_and_no_other(
    client: TestClient,
) -> None:
    _assert_message_lands_only_in_expected_bucket(client, "7days", bucket_index=3)


def test_stats_month_message_lands_in_expected_bucket_and_no_other(
    client: TestClient,
) -> None:
    _assert_message_lands_only_in_expected_bucket(client, "month", bucket_index=2)


def test_stats_year_message_lands_in_expected_bucket_and_no_other(
    client: TestClient,
) -> None:
    _assert_message_lands_only_in_expected_bucket(client, "year", bucket_index=6)


def test_stats_dislike_buckets_only_count_disliked_message_buckets_count_all_roles(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    try:
        before = _get_stats(client, "day")
        starts = [
            datetime.fromisoformat(b["bucketStart"]) for b in before["messageBuckets"]
        ]
        bucket_index = 6
        target_start = starts[bucket_index]
        next_start = starts[bucket_index + 1]
        midpoint = target_start + (next_start - target_start) / 2

        message_ids.append(
            _insert_message("user", f"role-user {uuid.uuid4()}", midpoint, disliked=False)
        )
        message_ids.append(
            _insert_message(
                "assistant", f"role-assistant {uuid.uuid4()}", midpoint, disliked=False
            )
        )
        message_ids.append(
            _insert_message(
                "assistant",
                f"role-assistant-disliked {uuid.uuid4()}",
                midpoint,
                disliked=True,
            )
        )

        after = _get_stats(client, "day")

        assert (
            after["messageBuckets"][bucket_index]["count"]
            == before["messageBuckets"][bucket_index]["count"] + 3
        )
        assert (
            after["dislikeBuckets"][bucket_index]["count"]
            == before["dislikeBuckets"][bucket_index]["count"] + 1
        )
    finally:
        _cleanup_messages(message_ids)


# --- chunk-graph -------------------------------------------------------
#
# _project_to_3d's fewer-than-4-points and zero-points branches are unit
# tested directly against the pure function (rather than through the
# endpoint, like every other test in this file) because this suite runs
# against the live dev Postgres (same caveat noted on
# test_stats_total_chunks_and_total_documents_match_actual_row_counts
# above) - it already has dozens of real chunks seeded in it, so an HTTP
# call can never observe a 0- or 2-or-3-total-chunk state to exercise
# those branches. The >=4-point/UMAP path *is* exercised end-to-end below,
# since the live DB's real total is always comfortably >= 4.


@pytest.mark.parametrize("n", [0, 1, 2, 3])
def test_project_to_3d_below_four_points_returns_one_position_per_point_without_crashing(
    n: int,
) -> None:
    positions = _project_to_3d([[0.1] * 1536 for _ in range(n)])

    assert len(positions) == n
    for position in positions:
        assert len(position) == 3
        assert all(isinstance(coordinate, float) for coordinate in position)


def _insert_graph_document() -> tuple[str, str]:
    filename = f"chunk-graph-{uuid.uuid4()}.txt"
    with SyncSessionLocal() as session:
        document_id = session.execute(
            text(
                "INSERT INTO documents (filename, storage_key, status) "
                "VALUES (:filename, :storage_key, 'ready') RETURNING id"
            ),
            {"filename": filename, "storage_key": f"docs/{filename}"},
        ).scalar_one()
        session.commit()
    return str(document_id), filename


def _insert_graph_chunk(document_id: str, position: int, embedding: str) -> str:
    with SyncSessionLocal() as session:
        chunk_id = session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, :position, 'content', 'content', :embedding ::vector) "
                "RETURNING id"
            ),
            {"document_id": document_id, "position": position, "embedding": embedding},
        ).scalar_one()
        session.commit()
    return str(chunk_id)


def _cleanup_graph_document(document_id: str) -> None:
    # chunks.document_id REFERENCES documents(id) ON DELETE CASCADE (0003
    # migration) - deleting the document is enough, same as
    # test_documents_router.py's delete test relies on.
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM documents WHERE id = :id"), {"id": document_id}
        )
        session.commit()


def _axis_embedding(x: float, y: float) -> str:
    # A 1536-dim embedding with its first two components set to (x, y) and
    # the rest zero-padded - varied enough (unlike a single repeated
    # constant vector) for UMAP to have something non-degenerate to work
    # with. Same construction as test_chat_router.py's own _axis_embedding.
    return format_vector([x, y] + [0.0] * 1534)


def _seed_graph_chunks(count: int = 5) -> tuple[str, list[str]]:
    document_id, _filename = _insert_graph_document()
    chunk_ids = [
        _insert_graph_chunk(document_id, position, _axis_embedding(position, -position))
        for position in range(count)
    ]
    return document_id, chunk_ids


def test_chunk_graph_returns_every_chunk_with_expected_keys_and_float_coordinates(
    client: TestClient,
) -> None:
    document_id, chunk_ids = _seed_graph_chunks()
    try:
        expected_total = _actual_count("chunks")

        response = client.get("/internal/dashboard/chunk-graph")

        assert response.status_code == 200
        nodes = response.json()["nodes"]
        assert len(nodes) == expected_total

        for node in nodes:
            assert set(node.keys()) == {"id", "documentId", "filename", "x", "y", "z", "position"}
            assert isinstance(node["x"], (int, float))
            assert isinstance(node["y"], (int, float))
            assert isinstance(node["z"], (int, float))
            assert isinstance(node["position"], int)

        node_ids = {node["id"] for node in nodes}
        for chunk_id in chunk_ids:
            assert chunk_id in node_ids
    finally:
        _cleanup_graph_document(document_id)


def test_chunk_graph_position_matches_the_chunk_s_own_position_within_its_document(
    client: TestClient,
) -> None:
    # The frontend chains same-document nodes in reading order (chunk 1 ->
    # chunk 2 -> chunk 3 -> ...), so `position` has to be the chunk's real
    # position within its document, not e.g. an index into the response.
    document_id, chunk_ids = _seed_graph_chunks()
    try:
        response = client.get("/internal/dashboard/chunk-graph")
        nodes_by_id = {node["id"]: node for node in response.json()["nodes"]}

        for expected_position, chunk_id in enumerate(chunk_ids):
            assert nodes_by_id[chunk_id]["position"] == expected_position
    finally:
        _cleanup_graph_document(document_id)


def test_chunk_graph_is_deterministic_across_repeated_calls(client: TestClient) -> None:
    document_id, chunk_ids = _seed_graph_chunks()
    try:
        first = client.get("/internal/dashboard/chunk-graph")
        second = client.get("/internal/dashboard/chunk-graph")

        assert first.status_code == 200
        assert second.status_code == 200

        first_by_id = {node["id"]: node for node in first.json()["nodes"]}
        second_by_id = {node["id"]: node for node in second.json()["nodes"]}

        for chunk_id in chunk_ids:
            first_node, second_node = first_by_id[chunk_id], second_by_id[chunk_id]
            assert first_node["x"] == second_node["x"]
            assert first_node["y"] == second_node["y"]
            assert first_node["z"] == second_node["z"]
    finally:
        _cleanup_graph_document(document_id)


def test_chunk_graph_empty_nodes_key_shape_is_a_list(client: TestClient) -> None:
    # Can't force a genuinely empty *total* (see the module-level comment
    # above), but every response - regardless of how many chunks currently
    # exist - must have a "nodes" list, never a missing/null key.
    response = client.get("/internal/dashboard/chunk-graph")

    assert response.status_code == 200
    assert isinstance(response.json()["nodes"], list)


# --- openai-spend --------------------------------------------------------
#
# _fetch_openai_spend_buckets/_fetch_openai_completions_buckets/
# _fetch_openai_embeddings_buckets (the only pieces of this feature that
# talk to the real OpenAI SDK) are patched directly in every test below -
# the same external-boundary-mocking convention test_chat_router.py uses
# for app.routers.chat.embed_texts/generate_reply - so none of these tests
# ever attempt a real OpenAI call. Every test that reaches
# get_openai_spend's try block patches all three, even ones that only care
# about one of them, since GET /internal/dashboard/openai-spend now awaits
# all three concurrently (asyncio.gather) and an un-patched one would
# otherwise attempt a real network call.
# _summarize_openai_spend/_bucket_spend_amount/_summarize_openai_tokens/
# _bucket_completions_tokens/_bucket_embeddings_tokens (pure functions) are
# also unit tested directly, the same way test_project_to_3d_* above unit
# tests _project_to_3d directly.

_ZERO_SPEND_BODY = {
    "day": 0.0,
    "week": 0.0,
    "month": 0.0,
    "year": 0.0,
    "currency": "usd",
}

_ZERO_TOKENS_BODY = {"day": 0, "week": 0, "month": 0, "year": 0}


def _make_cost_result(value: float, currency: str = "usd") -> SimpleNamespace:
    return SimpleNamespace(amount=SimpleNamespace(value=value, currency=currency))


def _make_completions_result(input_tokens: int, output_tokens: int) -> SimpleNamespace:
    return SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens)


def _make_embeddings_result(input_tokens: int) -> SimpleNamespace:
    return SimpleNamespace(input_tokens=input_tokens)


def _make_bucket(start_time: datetime, results: list) -> SimpleNamespace:
    return SimpleNamespace(start_time=int(start_time.timestamp()), results=results)


def _patch_openai_usage_fetchers(
    monkeypatch: pytest.MonkeyPatch,
    *,
    cost_buckets: list | Exception | None = None,
    completions_buckets: list | Exception | None = None,
    embeddings_buckets: list | Exception | None = None,
) -> None:
    """Patches all three of dashboard._fetch_openai_spend_buckets/
    _fetch_openai_completions_buckets/_fetch_openai_embeddings_buckets at
    once - a plain `list` argument becomes an AsyncMock that returns it, an
    Exception instance becomes an AsyncMock that raises it, and the default
    None becomes an AsyncMock that returns an empty list. Keeps the
    per-test setup below to one call each, rather than three near-identical
    monkeypatch.setattr lines every time."""

    def _mock_for(value: list | Exception | None) -> AsyncMock:
        if isinstance(value, Exception):
            return AsyncMock(side_effect=value)
        return AsyncMock(return_value=list(value or []))

    monkeypatch.setattr(
        dashboard, "_fetch_openai_spend_buckets", _mock_for(cost_buckets)
    )
    monkeypatch.setattr(
        dashboard, "_fetch_openai_completions_buckets", _mock_for(completions_buckets)
    )
    monkeypatch.setattr(
        dashboard, "_fetch_openai_embeddings_buckets", _mock_for(embeddings_buckets)
    )


def test_openai_spend_not_configured_returns_zeros_and_never_calls_openai(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        dashboard, "get_settings", lambda: Settings(openai_admin_api_key="")
    )
    cost_mock = AsyncMock()
    completions_mock = AsyncMock()
    embeddings_mock = AsyncMock()
    monkeypatch.setattr(dashboard, "_fetch_openai_spend_buckets", cost_mock)
    monkeypatch.setattr(dashboard, "_fetch_openai_completions_buckets", completions_mock)
    monkeypatch.setattr(dashboard, "_fetch_openai_embeddings_buckets", embeddings_mock)

    response = client.get("/internal/dashboard/openai-spend")

    assert response.status_code == 200
    assert response.json() == {
        **_ZERO_SPEND_BODY,
        "tokens": _ZERO_TOKENS_BODY,
        "configured": False,
    }
    cost_mock.assert_not_awaited()
    completions_mock.assert_not_awaited()
    embeddings_mock.assert_not_awaited()


def test_openai_spend_success_sums_buckets_into_rolling_windows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        dashboard, "get_settings", lambda: Settings(openai_admin_api_key="sk-admin-test")
    )
    now = datetime.now(timezone.utc)
    cost_buckets = [
        _make_bucket(now, [_make_cost_result(0.42)]),  # in every window
        _make_bucket(now - timedelta(days=3), [_make_cost_result(1.00)]),  # week/month/year
        _make_bucket(now - timedelta(days=20), [_make_cost_result(5.00)]),  # month/year
        _make_bucket(now - timedelta(days=200), [_make_cost_result(10.00)]),  # year only
    ]
    completions_buckets = [
        _make_bucket(now, [_make_completions_result(100, 50)]),  # 150, every window
        _make_bucket(now - timedelta(days=3), [_make_completions_result(200, 100)]),  # 300
        _make_bucket(now - timedelta(days=20), [_make_completions_result(400, 200)]),  # 600
        _make_bucket(now - timedelta(days=200), [_make_completions_result(800, 400)]),  # 1200
    ]
    embeddings_buckets = [
        _make_bucket(now, [_make_embeddings_result(10)]),  # every window
        _make_bucket(now - timedelta(days=3), [_make_embeddings_result(20)]),
        _make_bucket(now - timedelta(days=20), [_make_embeddings_result(40)]),
        _make_bucket(now - timedelta(days=200), [_make_embeddings_result(80)]),  # year only
    ]
    _patch_openai_usage_fetchers(
        monkeypatch,
        cost_buckets=cost_buckets,
        completions_buckets=completions_buckets,
        embeddings_buckets=embeddings_buckets,
    )

    response = client.get("/internal/dashboard/openai-spend")

    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is True
    assert body["currency"] == "usd"
    assert body["day"] == pytest.approx(0.42)
    assert body["week"] == pytest.approx(1.42)
    assert body["month"] == pytest.approx(6.42)
    assert body["year"] == pytest.approx(16.42)
    assert body["tokens"] == {
        "day": 160,  # completions 150 + embeddings 10
        "week": 480,  # completions 150+300 + embeddings 10+20
        "month": 1120,  # completions 150+300+600 + embeddings 10+20+40
        "year": 2400,  # completions 150+300+600+1200 + embeddings 10+20+40+80
    }


def test_openai_spend_fetch_failure_returns_200_with_zeroed_data_and_configured_true(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        dashboard, "get_settings", lambda: Settings(openai_admin_api_key="sk-admin-test")
    )
    _patch_openai_usage_fetchers(monkeypatch, cost_buckets=RuntimeError("boom"))

    response = client.get("/internal/dashboard/openai-spend")

    # Never a 500 - a failed OpenAI call must not take down the rest of the
    # Stats tab.
    assert response.status_code == 200
    assert response.json() == {
        **_ZERO_SPEND_BODY,
        "tokens": _ZERO_TOKENS_BODY,
        "configured": True,
    }


def test_openai_spend_token_fetch_failure_zeros_the_whole_response(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Design decision: a partial failure across the three OpenAI calls
    (costs/completions/embeddings) zeros the WHOLE response, not just the
    field(s) that failed to fetch - see get_openai_spend's docstring. Here
    costs succeeds with real spend but completions fails; the money fields
    must still come back zeroed, not the real cost total, so the Stats tab
    never shows a mix of real and zeroed numbers side by side."""
    monkeypatch.setattr(
        dashboard, "get_settings", lambda: Settings(openai_admin_api_key="sk-admin-test")
    )
    now = datetime.now(timezone.utc)
    _patch_openai_usage_fetchers(
        monkeypatch,
        cost_buckets=[_make_bucket(now, [_make_cost_result(9.99)])],
        completions_buckets=RuntimeError("boom"),
        embeddings_buckets=[_make_bucket(now, [_make_embeddings_result(10)])],
    )

    response = client.get("/internal/dashboard/openai-spend")

    assert response.status_code == 200
    assert response.json() == {
        **_ZERO_SPEND_BODY,
        "tokens": _ZERO_TOKENS_BODY,
        "configured": True,
    }


def test_openai_spend_empty_buckets_falls_back_to_usd_currency(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The documented shape for a zero-spend account (verified live) - every
    # bucket present but each with an empty `results` list.
    monkeypatch.setattr(
        dashboard, "get_settings", lambda: Settings(openai_admin_api_key="sk-admin-test")
    )
    now = datetime.now(timezone.utc)
    _patch_openai_usage_fetchers(
        monkeypatch,
        cost_buckets=[_make_bucket(now, [])],
        completions_buckets=[_make_bucket(now, [])],
        embeddings_buckets=[_make_bucket(now, [])],
    )

    response = client.get("/internal/dashboard/openai-spend")

    assert response.status_code == 200
    assert response.json() == {
        **_ZERO_SPEND_BODY,
        "tokens": _ZERO_TOKENS_BODY,
        "configured": True,
    }


def test_bucket_spend_amount_sums_multiple_results_and_reads_currency() -> None:
    bucket = _make_bucket(
        datetime.now(timezone.utc),
        [_make_cost_result(1.5, "usd"), _make_cost_result(2.5, "usd")],
    )

    amount, currency = _bucket_spend_amount(bucket)

    assert amount == pytest.approx(4.0)
    assert currency == "usd"


def test_bucket_spend_amount_empty_results_is_zero_with_no_currency() -> None:
    bucket = _make_bucket(datetime.now(timezone.utc), [])

    amount, currency = _bucket_spend_amount(bucket)

    assert amount == 0.0
    assert currency is None


def test_summarize_openai_spend_day_excludes_a_bucket_from_eight_days_ago() -> None:
    now = datetime.now(timezone.utc)
    buckets = [_make_bucket(now - timedelta(days=8), [_make_cost_result(3.0)])]

    result = _summarize_openai_spend(buckets, now)

    assert result["day"] == 0.0
    assert result["week"] == 0.0
    assert result["month"] == pytest.approx(3.0)
    assert result["year"] == pytest.approx(3.0)


def test_summarize_openai_spend_with_no_buckets_is_all_zero_usd() -> None:
    result = _summarize_openai_spend([], datetime.now(timezone.utc))

    assert result == _ZERO_SPEND_BODY


def test_bucket_completions_tokens_sums_input_and_output_across_results() -> None:
    bucket = _make_bucket(
        datetime.now(timezone.utc),
        [_make_completions_result(100, 50), _make_completions_result(200, 25)],
    )

    assert _bucket_completions_tokens(bucket) == 375


def test_bucket_completions_tokens_empty_results_is_zero() -> None:
    bucket = _make_bucket(datetime.now(timezone.utc), [])

    assert _bucket_completions_tokens(bucket) == 0


def test_bucket_embeddings_tokens_sums_input_tokens_across_results() -> None:
    bucket = _make_bucket(
        datetime.now(timezone.utc),
        [_make_embeddings_result(10), _make_embeddings_result(15)],
    )

    assert _bucket_embeddings_tokens(bucket) == 25


def test_bucket_embeddings_tokens_empty_results_is_zero() -> None:
    bucket = _make_bucket(datetime.now(timezone.utc), [])

    assert _bucket_embeddings_tokens(bucket) == 0


def test_summarize_openai_tokens_combines_completions_and_embeddings_per_window() -> None:
    now = datetime.now(timezone.utc)
    completions_buckets = [
        _make_bucket(now, [_make_completions_result(100, 50)]),  # 150, every window
        _make_bucket(now - timedelta(days=200), [_make_completions_result(800, 400)]),  # year only
    ]
    embeddings_buckets = [
        _make_bucket(now, [_make_embeddings_result(10)]),  # every window
        _make_bucket(now - timedelta(days=200), [_make_embeddings_result(80)]),  # year only
    ]

    result = _summarize_openai_tokens(completions_buckets, embeddings_buckets, now)

    assert result["day"] == 160
    assert result["week"] == 160
    assert result["month"] == 160
    assert result["year"] == 160 + 1200 + 80


def test_summarize_openai_tokens_with_no_buckets_is_all_zero() -> None:
    result = _summarize_openai_tokens([], [], datetime.now(timezone.utc))

    assert result == _ZERO_TOKENS_BODY
