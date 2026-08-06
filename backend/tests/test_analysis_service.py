import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import text

from app.analysis.candidates import (
    MAX_CONFLICT_CANDIDATES,
    SIMILAR_CHUNK_DISTANCE_THRESHOLD,
    find_conflict_candidates,
)
from app.analysis.service import (
    ConflictCheckResult,
    GapAnalysisResult,
    check_conflict,
    run_full_analysis,
    run_gap_analysis,
)
from app.chunks.embedding import LLMError
from app.chunks.vectors import format_vector
from app.dashboard_events.constants import DashboardEventType
from app.db.session import async_session_factory
from app.db.sync_session import SyncSessionLocal

# --- Shared helpers --------------------------------------------------------


def _axis_embedding(x: float, y: float) -> str:
    # Mirrors test_chat_router.py's own _axis_embedding: a 1536-dim unit-ish
    # embedding with only its first two components set, formatted for the
    # `::vector` cast - cosine distance between two of these is fully
    # determined by (x, y) alone.
    return format_vector([x, y] + [0.0] * 1534)


def _insert_document(*, status: str) -> str:
    filename = f"analysis-service-{uuid.uuid4()}.txt"
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


def _insert_chunk(document_id: str, position: int, content: str, embedding: str) -> str:
    with SyncSessionLocal() as session:
        chunk_id = session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, :position, :content, :content, :embedding ::vector) "
                "RETURNING id"
            ),
            {
                "document_id": document_id,
                "position": position,
                "content": content,
                "embedding": embedding,
            },
        ).scalar_one()
        session.commit()
    return str(chunk_id)


def _cleanup_documents(document_ids: list[str]) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM documents WHERE id = ANY(:ids)"), {"ids": document_ids}
        )
        session.commit()


def _run(coro):
    return asyncio.run(coro)


def _make_chat_response(content: str, total_tokens: int) -> MagicMock:
    message = MagicMock(content=content)
    choice = MagicMock(message=message)
    usage = MagicMock(total_tokens=total_tokens)
    return MagicMock(choices=[choice], usage=usage)


# --- find_conflict_candidates -----------------------------------------------


def test_find_conflict_candidates_returns_close_cross_document_pair_only() -> None:
    document_ids: list[str] = []
    try:
        # doc_a/doc_b: ready, one chunk each, identical embeddings (distance
        # 0.0, well below SIMILAR_CHUNK_DISTANCE_THRESHOLD) - the one pair
        # this test expects back.
        doc_a = _insert_document(status="ready")
        doc_b = _insert_document(status="ready")
        document_ids += [doc_a, doc_b]
        suffix = uuid.uuid4()
        chunk_a_id = _insert_chunk(doc_a, 0, f"chunk a {suffix}", _axis_embedding(1.0, 0.0))
        chunk_b_id = _insert_chunk(doc_b, 0, f"chunk b {suffix}", _axis_embedding(1.0, 0.0))

        # doc_c: ready, one chunk, opposite embedding (distance 2.0, far
        # above threshold) - must never appear in any returned row.
        doc_c = _insert_document(status="ready")
        document_ids.append(doc_c)
        chunk_c_id = _insert_chunk(
            doc_c, 0, f"chunk c {suffix}", _axis_embedding(-1.0, 0.0)
        )

        # doc_d: ready, TWO chunks in the SAME document, identical
        # embeddings on an unrelated axis (close to each other, but must
        # never be returned as a pair - cross-document only). Kept on a
        # different axis than doc_a/doc_b/doc_c so it can't accidentally
        # pair with them either.
        doc_d = _insert_document(status="ready")
        document_ids.append(doc_d)
        chunk_d1_id = _insert_chunk(
            doc_d, 0, f"chunk d1 {suffix}", _axis_embedding(0.0, 1.0)
        )
        chunk_d2_id = _insert_chunk(
            doc_d, 1, f"chunk d2 {suffix}", _axis_embedding(0.0, 1.0)
        )

        # doc_e: NOT ready, one chunk with the same close embedding as
        # doc_a/doc_b - would otherwise be a valid low-distance candidate,
        # but must be excluded since its document isn't 'ready'.
        doc_e = _insert_document(status="uploaded")
        document_ids.append(doc_e)
        chunk_e_id = _insert_chunk(
            doc_e, 0, f"chunk e {suffix}", _axis_embedding(1.0, 0.0)
        )

        async def _fetch():
            async with async_session_factory() as session:
                return await find_conflict_candidates(session)

        rows = _run(_fetch())

        def _pair_ids(row) -> set[str]:
            return {str(row.chunk_a_id), str(row.chunk_b_id)}

        matching = [row for row in rows if _pair_ids(row) == {chunk_a_id, chunk_b_id}]
        assert len(matching) == 1
        row = matching[0]
        content_by_chunk_id = {
            str(row.chunk_a_id): row.chunk_a_content,
            str(row.chunk_b_id): row.chunk_b_content,
        }
        assert content_by_chunk_id[chunk_a_id] == f"chunk a {suffix}"
        assert content_by_chunk_id[chunk_b_id] == f"chunk b {suffix}"
        document_id_by_chunk_id = {
            str(row.chunk_a_id): str(row.document_a_id),
            str(row.chunk_b_id): str(row.document_b_id),
        }
        assert document_id_by_chunk_id[chunk_a_id] == doc_a
        assert document_id_by_chunk_id[chunk_b_id] == doc_b

        # The far chunk never appears in any returned row.
        assert all(chunk_c_id not in _pair_ids(row) for row in rows)

        # The same-document pair never appears together.
        assert all(_pair_ids(row) != {chunk_d1_id, chunk_d2_id} for row in rows)

        # The not-ready document's chunk never appears in any returned row.
        assert all(chunk_e_id not in _pair_ids(row) for row in rows)
    finally:
        _cleanup_documents(document_ids)


def test_find_conflict_candidates_caps_at_max_conflict_candidates() -> None:
    async def _fetch():
        async with async_session_factory() as session:
            return await find_conflict_candidates(session)

    rows = _run(_fetch())
    assert len(rows) <= MAX_CONFLICT_CANDIDATES


def test_similar_chunk_distance_threshold_is_a_reasonable_cosine_distance() -> None:
    # Sanity check on the constant itself - cosine distance ranges [0, 2].
    assert 0.0 < SIMILAR_CHUNK_DISTANCE_THRESHOLD < 2.0


# --- run_gap_analysis --------------------------------------------------------


def test_run_gap_analysis_returns_content_and_tokens_from_response() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("Group A: ...\nGroup B: ...", 123)
    )

    result = _run(run_gap_analysis(["question one", "question two"], client=client))

    assert isinstance(result, GapAnalysisResult)
    assert result.content == "Group A: ...\nGroup B: ..."
    assert result.tokens_used == 123


def test_run_gap_analysis_with_empty_questions_still_calls_llm_with_no_data_prompt() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("No recurring themes to report.", 42)
    )

    result = _run(run_gap_analysis([], client=client))

    assert result.content == "No recurring themes to report."
    client.chat.completions.create.assert_awaited_once()
    _, kwargs = client.chat.completions.create.call_args
    joined = " ".join(message["content"] for message in kwargs["messages"])
    assert "no" in joined.lower()
    # A real question, if it had been passed, would show up verbatim in the
    # prompt - it must not appear here since none were given.
    assert "question one" not in joined


def test_run_gap_analysis_includes_every_question_in_the_prompt() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("themes", 10)
    )

    _run(run_gap_analysis(["how do I export?", "why is search broken?"], client=client))

    _, kwargs = client.chat.completions.create.call_args
    joined = " ".join(message["content"] for message in kwargs["messages"])
    assert "how do I export?" in joined
    assert "why is search broken?" in joined


def test_run_gap_analysis_raises_llm_error_on_sdk_failure() -> None:
    from app.chunks.embedding import LLMError

    client = MagicMock()
    client.chat.completions.create = AsyncMock(side_effect=RuntimeError("boom"))

    with pytest.raises(LLMError):
        _run(run_gap_analysis(["a question"], client=client))


# --- check_conflict -----------------------------------------------------------


def test_check_conflict_parses_conflict_response() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response(
            "CONFLICT\nDocument A says X is 5, Document B says X is 10.", 77
        )
    )

    result = _run(check_conflict("chunk A text", "chunk B text", client=client))

    assert isinstance(result, ConflictCheckResult)
    assert result.is_conflict is True
    assert result.description == "Document A says X is 5, Document B says X is 10."
    assert result.tokens_used == 77


def test_check_conflict_parses_no_conflict_response() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("NO_CONFLICT", 55)
    )

    result = _run(check_conflict("chunk A text", "chunk B text", client=client))

    assert result.is_conflict is False
    assert result.description is None
    assert result.tokens_used == 55


def test_check_conflict_request_includes_both_chunk_texts() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("NO_CONFLICT", 5)
    )

    _run(check_conflict("first chunk text", "second chunk text", client=client))

    _, kwargs = client.chat.completions.create.call_args
    joined = " ".join(message["content"] for message in kwargs["messages"])
    assert "first chunk text" in joined
    assert "second chunk text" in joined


def test_check_conflict_raises_llm_error_on_sdk_failure() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(side_effect=RuntimeError("boom"))

    with pytest.raises(LLMError):
        _run(check_conflict("a", "b", client=client))


# --- run_full_analysis --------------------------------------------------------


def _insert_report(*, status: str, started_by_email: str) -> str:
    with SyncSessionLocal() as session:
        report_id = session.execute(
            text(
                "INSERT INTO analysis_reports (status, started_by_email) "
                "VALUES (:status, :started_by_email) RETURNING id"
            ),
            {"status": status, "started_by_email": started_by_email},
        ).scalar_one()
        session.commit()
    return str(report_id)


def _report_row(report_id: str):
    with SyncSessionLocal() as session:
        return session.execute(
            text(
                "SELECT status, gap_analysis, conflicts, total_tokens, "
                "completed_at, error_detail FROM analysis_reports WHERE id = :id"
            ),
            {"id": report_id},
        ).one()


def _cleanup_report(report_id: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM analysis_reports WHERE id = :id"), {"id": report_id}
        )
        session.commit()


def _insert_chat_message(
    *, role: str, content: str, disliked: bool = False, no_answer_found: bool = False,
    question_id: str | None = None,
) -> str:
    with SyncSessionLocal() as session:
        message_id = session.execute(
            text(
                "INSERT INTO chat_messages "
                "(role, content, disliked, disliked_at, no_answer_found, question_id) "
                "VALUES (:role, :content, :disliked, "
                "CASE WHEN :disliked THEN now() ELSE NULL END, "
                ":no_answer_found, :question_id) "
                "RETURNING id"
            ),
            {
                "role": role,
                "content": content,
                "disliked": disliked,
                "no_answer_found": no_answer_found,
                "question_id": question_id,
            },
        ).scalar_one()
        session.commit()
    return str(message_id)


def _cleanup_messages(message_ids: list[str]) -> None:
    if not message_ids:
        return
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM chat_messages WHERE id = ANY(:ids)"), {"ids": message_ids}
        )
        session.commit()


def _events_for(user_email: str, event_type: str) -> list:
    with SyncSessionLocal() as session:
        return session.execute(
            text(
                "SELECT type, detail, user_email FROM dashboard_events "
                "WHERE user_email = :user_email AND type = :type"
            ),
            {"user_email": user_email, "type": event_type},
        ).all()


def _cleanup_events(user_email: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM dashboard_events WHERE user_email = :user_email"),
            {"user_email": user_email},
        )
        session.commit()


def test_run_full_analysis_completes_and_records_one_completed_event() -> None:
    user_email = f"analysis-run-{uuid.uuid4()}@example.com"
    report_id = _insert_report(status="running", started_by_email=user_email)
    document_ids: list[str] = []
    message_ids: list[str] = []
    try:
        # A couple of disliked/no-answer chat_messages - the gap-analysis
        # half's real input.
        question_id = _insert_chat_message(
            role="user", content=f"why is x broken {uuid.uuid4()}"
        )
        message_ids.append(question_id)
        disliked_id = _insert_chat_message(
            role="assistant",
            content="a disliked reply",
            disliked=True,
            question_id=question_id,
        )
        message_ids.append(disliked_id)
        no_answer_question_id = _insert_chat_message(
            role="user", content=f"how do I do y {uuid.uuid4()}"
        )
        message_ids.append(no_answer_question_id)
        no_answer_id = _insert_chat_message(
            role="assistant",
            content="no answer",
            no_answer_found=True,
            question_id=no_answer_question_id,
        )
        message_ids.append(no_answer_id)

        # Two close-embedding cross-document ready chunks - a candidate pair
        # for the conflict-detection half.
        doc_a = _insert_document(status="ready")
        doc_b = _insert_document(status="ready")
        document_ids += [doc_a, doc_b]
        suffix = uuid.uuid4()
        chunk_a_id = _insert_chunk(
            doc_a, 0, f"full-analysis chunk a {suffix}", _axis_embedding(1.0, 0.0)
        )
        chunk_b_id = _insert_chunk(
            doc_b, 0, f"full-analysis chunk b {suffix}", _axis_embedding(1.0, 0.0)
        )

        with (
            patch(
                "app.analysis.service.run_gap_analysis",
                new=AsyncMock(
                    return_value=GapAnalysisResult(content="gap report", tokens_used=100)
                ),
            ) as mock_gap,
            patch(
                "app.analysis.service.check_conflict",
                new=AsyncMock(
                    return_value=ConflictCheckResult(
                        is_conflict=True, description="they disagree", tokens_used=20
                    )
                ),
            ) as mock_check,
        ):
            _run(run_full_analysis(report_id))

        mock_gap.assert_awaited_once()
        assert mock_check.await_count >= 1

        row = _report_row(report_id)
        assert row.status == "completed"
        assert row.gap_analysis == "gap report"
        assert row.conflicts is not None
        assert row.total_tokens is not None
        assert row.total_tokens >= 100 + 20
        assert row.completed_at is not None
        assert row.error_detail is None

        matching_conflicts = [
            conflict
            for conflict in row.conflicts
            if conflict["chunkAId"] in (chunk_a_id, chunk_b_id)
            or conflict["chunkBId"] in (chunk_a_id, chunk_b_id)
        ]
        assert matching_conflicts, row.conflicts
        conflict = matching_conflicts[0]
        assert conflict["description"] == "they disagree"
        assert {conflict["documentAId"], conflict["documentBId"]} == {doc_a, doc_b}

        events = _events_for(user_email, DashboardEventType.ANALYSIS_RUN_COMPLETED)
        assert len(events) == 1
        assert events[0].user_email == user_email
        assert f"tokens spend = {row.total_tokens}" in events[0].detail

        no_failed_events = _events_for(user_email, DashboardEventType.ANALYSIS_RUN_FAILED)
        assert no_failed_events == []
    finally:
        _cleanup_report(report_id)
        _cleanup_documents(document_ids)
        _cleanup_messages(message_ids)
        _cleanup_events(user_email)


def test_run_full_analysis_llm_failure_marks_row_failed_and_records_failed_event() -> None:
    user_email = f"analysis-run-fail-{uuid.uuid4()}@example.com"
    report_id = _insert_report(status="running", started_by_email=user_email)
    try:
        with patch(
            "app.analysis.service.run_gap_analysis",
            new=AsyncMock(side_effect=LLMError("boom")),
        ):
            _run(run_full_analysis(report_id))

        row = _report_row(report_id)
        assert row.status == "failed"
        assert row.error_detail is not None
        assert "boom" in row.error_detail
        assert row.completed_at is not None
        assert row.gap_analysis is None

        events = _events_for(user_email, DashboardEventType.ANALYSIS_RUN_FAILED)
        assert len(events) == 1
        assert events[0].user_email == user_email

        no_completed_events = _events_for(
            user_email, DashboardEventType.ANALYSIS_RUN_COMPLETED
        )
        assert no_completed_events == []
    finally:
        _cleanup_report(report_id)
        _cleanup_events(user_email)


def test_run_full_analysis_survives_a_second_call_in_the_same_process() -> None:
    """Regression test for a live bug (found via manual smoke testing, not
    caught by the tests above): app.db.session's async engine is a
    module-level singleton whose connection pool binds to whichever event
    loop first used it. tasks.py's Celery task calls run_full_analysis via
    a bare `asyncio.run(...)` per task execution - a FRESH loop every time
    - but the worker process itself, and therefore this module-level
    engine, stays alive across many task executions. Without disposing the
    engine before this function's own event loop closes, a SECOND call in
    the same process reuses a connection pooled from the FIRST call's
    (now-closed) loop and crashes with "got Future ... attached to a
    different loop" the moment it's actually used - exactly what the two
    calls below did before this function started disposing the engine
    itself (see its own comment right after the find_conflict_candidates
    call).

    The two tests above don't catch this: conftest.py's own
    `_dispose_engine_after_test` autouse fixture disposes the engine
    between every test FUNCTION, which - ironically, for testing this
    exact scenario - masks the bug entirely, since in production nothing
    outside run_full_analysis ever disposes it between Celery task runs.
    This test reproduces the real shape (two bare asyncio.run() calls with
    nothing disposing the engine in between) inside a single test function
    instead, bypassing that fixture's protection."""
    user_email = f"analysis-run-twice-{uuid.uuid4()}@example.com"
    report_ids = [
        _insert_report(status="running", started_by_email=user_email) for _ in range(2)
    ]
    document_ids: list[str] = []
    try:
        for report_id in report_ids:
            doc_a = _insert_document(status="ready")
            doc_b = _insert_document(status="ready")
            document_ids += [doc_a, doc_b]
            suffix = uuid.uuid4()
            _insert_chunk(doc_a, 0, f"twice-run chunk a {suffix}", _axis_embedding(1.0, 0.0))
            _insert_chunk(doc_b, 0, f"twice-run chunk b {suffix}", _axis_embedding(1.0, 0.0))

        with (
            patch(
                "app.analysis.service.run_gap_analysis",
                new=AsyncMock(
                    return_value=GapAnalysisResult(content="gap report", tokens_used=1)
                ),
            ),
            patch(
                "app.analysis.service.check_conflict",
                new=AsyncMock(
                    return_value=ConflictCheckResult(
                        is_conflict=False, description=None, tokens_used=1
                    )
                ),
            ),
        ):
            # Two SEPARATE bare asyncio.run() calls, matching tasks.py's own
            # asyncio.run(run_full_analysis(report_id)) shape exactly - a
            # pytest-asyncio-style shared event loop across both calls would
            # NOT reproduce this bug, since the whole failure mode is about
            # a connection surviving from one CLOSED loop into a NEW one.
            asyncio.run(run_full_analysis(report_ids[0]))
            asyncio.run(run_full_analysis(report_ids[1]))

        for report_id in report_ids:
            row = _report_row(report_id)
            assert row.status == "completed", row.error_detail
            assert row.error_detail is None
    finally:
        for report_id in report_ids:
            _cleanup_report(report_id)
        _cleanup_documents(document_ids)
        _cleanup_events(user_email)
