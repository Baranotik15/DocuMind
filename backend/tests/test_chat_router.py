import asyncio
import io
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.testclient import WebSocketDenialResponse

import app.chat.router as chat_router
import app.chat.voice as voice
from app.chat.completion import GeneratedReply
from app.chat.voice import AudioConversionError, VoiceRecognitionUnavailableError
from app.chunks.embedding import LLMError
from app.chunks.vectors import format_vector
from app.config import Settings
from app.db.session import async_session_factory
from app.db.sync_session import SyncSessionLocal
from app.main import app

ZERO_VECTOR_1536 = "[" + ",".join(["0"] * 1536) + "]"


@pytest.fixture
def client(authenticated_client: TestClient) -> TestClient:
    # chat_router now requires a session (see app/main.py) - overrides
    # conftest.py's plain, unauthenticated `client` fixture for every test
    # in this module.
    return authenticated_client


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    # External-boundary mock (app.chat.router.embed_texts) so no real
    # OpenAI call happens - same pattern as test_pipeline.py /
    # test_documents_router.py / test_chunks_router.py.
    return [[0.1] * 1536 for _ in texts]


def _insert_document(*, status: str) -> str:
    filename = f"chat-router-{uuid.uuid4()}.txt"
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


def _insert_chunk(
    document_id: str,
    position: int,
    original: str,
    edited: str,
    embedding: str = ZERO_VECTOR_1536,
) -> None:
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
                "embedding": embedding,
            },
        )
        session.commit()


def _cleanup_document(document_id: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        )
        session.commit()


def _cleanup_messages(message_ids: list[str]) -> None:
    if not message_ids:
        return
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM chat_messages WHERE id = ANY(:ids)"),
            {"ids": message_ids},
        )
        session.commit()


def _insert_message(
    *,
    role: str,
    content: str,
    created_at: datetime | None = None,
    disliked: bool = False,
    disliked_at: datetime | None = None,
    no_answer_found: bool = False,
    question_id: str | None = None,
    channel: str = "admin",
    external_identity: str | None = None,
) -> str:
    # Direct-SQL backdating idiom (see test_documents_router.py's/
    # test_chunks_router.py's own _force_status) - lets range-filter tests
    # seed rows with an explicit created_at/disliked_at rather than relying
    # on now()-at-insert-time, which every real send_message/dislike call
    # uses instead. `channel` defaults to "admin" (the column's own default)
    # so every existing caller keeps seeding admin-channel rows unchanged;
    # tests exercising the Slack-exclusion behavior pass channel="slack"
    # explicitly.
    with SyncSessionLocal() as session:
        message_id = session.execute(
            text(
                "INSERT INTO chat_messages "
                "(role, content, created_at, disliked, disliked_at, no_answer_found, "
                "question_id, channel, external_identity) "
                "VALUES (:role, :content, COALESCE(:created_at, now()), :disliked, "
                ":disliked_at, :no_answer_found, :question_id, :channel, :external_identity) "
                "RETURNING id"
            ),
            {
                "role": role,
                "content": content,
                "created_at": created_at,
                "disliked": disliked,
                "disliked_at": disliked_at,
                "no_answer_found": no_answer_found,
                "question_id": question_id,
                "channel": channel,
                "external_identity": external_identity,
            },
        ).scalar_one()
        session.commit()
    return str(message_id)


def test_send_message_with_ready_document_returns_mocked_reply_and_appears_in_list(
    client: TestClient,
) -> None:
    document_id = _insert_document(status="ready")
    message_ids: list[str] = []
    try:
        _insert_chunk(document_id, 0, "relevant chunk", "relevant chunk")

        user_content = f"question {uuid.uuid4()}"
        with (
            patch(
                "app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
            ),
            patch(
                "app.chat.router.generate_reply",
                new=AsyncMock(
                    return_value=GeneratedReply(content="mocked reply", no_answer_found=False)
                ),
            ) as mock_generate_reply,
        ):
            response = client.post(
                "/internal/chat/messages", json={"content": user_content}
            )

        assert response.status_code == 200
        body = response.json()
        assert body["role"] == "assistant"
        assert body["content"] == "mocked reply"
        assert body["disliked"] is False
        assert "id" in body
        message_ids.append(body["id"])

        mock_generate_reply.assert_awaited_once()
        args, _ = mock_generate_reply.call_args
        assert args[0] == user_content
        assert args[1] == ["relevant chunk"]

        list_response = client.get("/internal/chat/messages")
        assert list_response.status_code == 200
        all_messages = list_response.json()
        matching = [m for m in all_messages if m["content"] in (user_content, "mocked reply")]
        assert len(matching) == 2
        assert matching[0]["role"] == "user"
        assert matching[0]["content"] == user_content
        assert matching[1]["role"] == "assistant"
        assert matching[1]["content"] == "mocked reply"
        message_ids.append(matching[0]["id"])
    finally:
        _cleanup_document(document_id)
        _cleanup_messages(message_ids)


def test_send_message_with_zero_ready_documents_calls_generate_reply_with_empty_context(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    user_content = f"lonely question {uuid.uuid4()}"
    with (
        patch("app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.chat.router.generate_reply",
            new=AsyncMock(
                return_value=GeneratedReply(content="fallback reply", no_answer_found=False)
            ),
        ) as mock_generate_reply,
    ):
        response = client.post("/internal/chat/messages", json={"content": user_content})

    try:
        assert response.status_code == 200
        body = response.json()
        assert body["content"] == "fallback reply"
        message_ids.append(body["id"])

        mock_generate_reply.assert_awaited_once()
        args, _ = mock_generate_reply.call_args
        assert args[0] == user_content
        assert args[1] == []

        list_response = client.get("/internal/chat/messages")
        matching = [
            m for m in list_response.json() if m["content"] in (user_content, "fallback reply")
        ]
        message_ids.extend(m["id"] for m in matching if m["id"] not in message_ids)
    finally:
        _cleanup_messages(message_ids)


def test_send_message_llm_error_returns_502_and_user_message_persisted_without_reply(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    user_content = f"doomed question {uuid.uuid4()}"
    with (
        patch("app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.chat.router.generate_reply",
            new=AsyncMock(side_effect=LLMError("boom")),
        ),
    ):
        response = client.post("/internal/chat/messages", json={"content": user_content})

    try:
        assert response.status_code == 502
        assert response.json()["detail"] == "chat_completion_failed"

        list_response = client.get("/internal/chat/messages")
        assert list_response.status_code == 200
        all_messages = list_response.json()
        matching = [m for m in all_messages if m["content"] == user_content]
        # Exactly one message with this content exists: the persisted user
        # message. No assistant row was ever written for it (a second
        # match with the same content, from an assistant reply that
        # happened to echo it, is not possible here since the mock never
        # returns a value on this path).
        assert len(matching) == 1
        assert matching[0]["role"] == "user"
        message_ids.append(matching[0]["id"])
    finally:
        _cleanup_messages(message_ids)


def test_send_message_embed_texts_llm_error_returns_502_and_user_message_persisted_without_reply(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    user_content = f"doomed embed question {uuid.uuid4()}"
    with (
        patch(
            "app.chat.router.embed_texts", new=AsyncMock(side_effect=LLMError("boom"))
        ),
        patch(
            "app.chat.router.generate_reply", new=AsyncMock()
        ) as mock_generate_reply,
    ):
        response = client.post("/internal/chat/messages", json={"content": user_content})

    try:
        assert response.status_code == 502
        assert response.json()["detail"] == "chat_completion_failed"

        mock_generate_reply.assert_not_awaited()

        list_response = client.get("/internal/chat/messages")
        assert list_response.status_code == 200
        all_messages = list_response.json()
        matching = [m for m in all_messages if m["content"] == user_content]
        # Exactly one message with this content exists: the persisted user
        # message. No assistant row was ever written for it, since
        # embed_texts raised before generate_reply could even be called.
        assert len(matching) == 1
        assert matching[0]["role"] == "user"
        message_ids.append(matching[0]["id"])
    finally:
        _cleanup_messages(message_ids)


def test_dislike_message_toggles_disliked_flag_on_and_off(client: TestClient) -> None:
    message_ids: list[str] = []
    user_content = f"dislike me {uuid.uuid4()}"
    with (
        patch("app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.chat.router.generate_reply",
            new=AsyncMock(return_value=GeneratedReply(content="a reply", no_answer_found=False)),
        ),
    ):
        response = client.post("/internal/chat/messages", json={"content": user_content})
    assert response.status_code == 200
    assistant_id = response.json()["id"]
    message_ids.append(assistant_id)

    try:
        list_response = client.get("/internal/chat/messages")
        user_message = next(
            m for m in list_response.json() if m["content"] == user_content
        )
        message_ids.append(user_message["id"])

        # Freshly sent messages start with disliked=false.
        matching = next(m for m in list_response.json() if m["id"] == assistant_id)
        assert matching["disliked"] is False

        # First call flips false -> true.
        first_dislike = client.post(
            f"/internal/chat/messages/{assistant_id}/dislike"
        )
        assert first_dislike.status_code == 204
        assert first_dislike.content == b""

        list_response = client.get("/internal/chat/messages")
        matching = next(m for m in list_response.json() if m["id"] == assistant_id)
        assert matching["disliked"] is True

        # Second call on the same message flips true -> false (undo).
        second_dislike = client.post(
            f"/internal/chat/messages/{assistant_id}/dislike"
        )
        assert second_dislike.status_code == 204
        assert second_dislike.content == b""

        list_response = client.get("/internal/chat/messages")
        matching = next(m for m in list_response.json() if m["id"] == assistant_id)
        assert matching["disliked"] is False
    finally:
        _cleanup_messages(message_ids)


def test_dislike_malformed_message_id_returns_422_not_500(client: TestClient) -> None:
    response = client.post("/internal/chat/messages/not-a-uuid/dislike")

    assert response.status_code == 422


def test_list_messages_excludes_slack_channel_messages(client: TestClient) -> None:
    # GET /chat/messages powers the single-threaded admin Chat page - a
    # channel='slack' row (potentially from an unrelated external Slack
    # user) must never show up interleaved in it, even though every other
    # chat_messages reader (dashboard stats, Improvements page) keeps
    # counting/showing across all channels.
    message_ids: list[str] = []
    admin_content = f"admin channel message {uuid.uuid4()}"
    slack_content = f"slack channel message {uuid.uuid4()}"
    try:
        admin_id = _insert_message(role="user", content=admin_content, channel="admin")
        message_ids.append(admin_id)
        slack_id = _insert_message(
            role="user",
            content=slack_content,
            channel="slack",
            external_identity="U999",
        )
        message_ids.append(slack_id)

        response = client.get("/internal/chat/messages")
        assert response.status_code == 200
        body = response.json()
        ids = {item["id"] for item in body}
        assert admin_id in ids
        assert slack_id not in ids
    finally:
        _cleanup_messages(message_ids)


async def _fake_embed_axis0(texts: list[str]) -> list[list[float]]:
    # Query embedding always points along the same unit axis, so each
    # chunk's cosine distance to it is fully determined by that chunk's
    # own embedding (constructed below) - not by anything content-based.
    return [[1.0] + [0.0] * 1535 for _ in texts]


def _axis_embedding(x: float, y: float) -> str:
    # A 1536-dim embedding with its first two components set to (x, y) and
    # the rest zero, formatted the same way production code formats
    # embeddings for the `::vector` cast.
    return format_vector([x, y] + [0.0] * 1534)


def test_top_chunks_returns_up_to_5_ordered_by_match_percent_desc(
    client: TestClient,
) -> None:
    # This project's suite runs against the live dev Postgres, which (per
    # its own manual-testing usage) already has real `ready` documents with
    # real embeddings in it - e.g. a meridian-reference-manual.md fixture
    # doc, not inserted by this test and not ours to touch or delete. Real,
    # topically-unrelated text embeddings observed against this same
    # axis-0 query direction score a match_percent of roughly 1-3% (they're
    # close to orthogonal, as expected in 1536 dimensions). The six
    # cos(theta) values below (0.96-1.0, plus one deliberately opposite)
    # are chosen far above that noise floor so this test's own chunks are
    # guaranteed to dominate the top of the ranking regardless of whatever
    # else is already in the corpus.
    document_id = _insert_document(status="ready")
    suffix = uuid.uuid4()
    try:
        # cos(theta) between the axis-0 query embedding and each chunk
        # below is exactly its label's value, since every vector here is
        # already unit-length: distance = 1 - cos(theta), so match_percent
        # = round(max(0, min(1, cos(theta))) * 100, 1).
        chunks = [
            ("match-100", _axis_embedding(1.0, 0.0)),
            ("match-99", _axis_embedding(0.99, (1 - 0.99**2) ** 0.5)),
            ("match-98", _axis_embedding(0.98, (1 - 0.98**2) ** 0.5)),
            ("match-97", _axis_embedding(0.97, (1 - 0.97**2) ** 0.5)),
            ("match-96", _axis_embedding(0.96, (1 - 0.96**2) ** 0.5)),
            # Worst (largest) distance of the six - opposite direction of
            # the query - must be the one excluded by the top-5 LIMIT.
            ("match-0-opposite", _axis_embedding(-1.0, 0.0)),
        ]
        for position, (label, embedding) in enumerate(chunks):
            content = f"{label} chunk {suffix}"
            _insert_chunk(document_id, position, content, content, embedding=embedding)

        with patch(
            "app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_axis0)
        ):
            response = client.post(
                "/internal/chat/top-chunks", json={"content": f"probe {suffix}"}
            )

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 5

        expected_order = [
            ("match-100", 100.0),
            ("match-99", 99.0),
            ("match-98", 98.0),
            ("match-97", 97.0),
            ("match-96", 96.0),
        ]
        for item, (label, expected_percent) in zip(body, expected_order):
            assert item["content"].startswith(label), (item, label)
            assert item["matchPercent"] == pytest.approx(expected_percent, abs=0.2)

        # The 6th, worst-matching chunk (opposite direction) never appears.
        assert all("match-0-opposite" not in item["content"] for item in body)
    finally:
        _cleanup_document(document_id)


def test_top_chunks_response_item_has_exactly_the_five_camelcase_keys(
    client: TestClient,
) -> None:
    # Same live-dev-Postgres caveat as the ordering test above: this uses a
    # perfect-match embedding (cos(theta) == 1.0, distance == 0.0) so this
    # test's own chunk is guaranteed to rank first regardless of whatever
    # other `ready` documents already exist in the corpus - checking
    # body[0] rather than assuming len(body) == 1.
    document_id = _insert_document(status="ready")
    with SyncSessionLocal() as session:
        filename = session.execute(
            text("SELECT filename FROM documents WHERE id = :id"), {"id": document_id}
        ).scalar_one()
    suffix = uuid.uuid4()
    try:
        content = f"lone chunk {suffix}"
        _insert_chunk(document_id, 0, content, content, embedding=_axis_embedding(1.0, 0.0))

        with patch(
            "app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_axis0)
        ):
            response = client.post(
                "/internal/chat/top-chunks", json={"content": f"probe {suffix}"}
            )

        assert response.status_code == 200
        body = response.json()
        assert len(body) >= 1
        item = body[0]
        assert set(item.keys()) == {
            "chunkId",
            "documentId",
            "filename",
            "content",
            "matchPercent",
        }
        assert item["documentId"] == document_id
        assert item["filename"] == filename
        assert item["content"] == content
        assert item["matchPercent"] == pytest.approx(100.0, abs=0.2)
        assert isinstance(item["chunkId"], str)
        assert isinstance(item["matchPercent"], float)
    finally:
        _cleanup_document(document_id)


def test_top_chunks_with_zero_ready_documents_returns_empty_list(
    client: TestClient,
) -> None:
    with patch(
        "app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
    ):
        response = client.post(
            "/internal/chat/top-chunks",
            json={"content": f"lonely probe {uuid.uuid4()}"},
        )

    assert response.status_code == 200
    assert response.json() == []


def test_top_chunks_embed_texts_llm_error_returns_502(client: TestClient) -> None:
    with patch(
        "app.chat.router.embed_texts", new=AsyncMock(side_effect=LLMError("boom"))
    ):
        response = client.post(
            "/internal/chat/top-chunks",
            json={"content": f"doomed probe {uuid.uuid4()}"},
        )

    assert response.status_code == 502
    assert response.json()["detail"] == "chat_completion_failed"


def test_dislikes_list_reflects_dislike_toggle_with_question_content(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    user_content = f"dislike list question {uuid.uuid4()}"
    with (
        patch("app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.chat.router.generate_reply",
            new=AsyncMock(
                return_value=GeneratedReply(content="a disliked reply", no_answer_found=False)
            ),
        ),
    ):
        response = client.post("/internal/chat/messages", json={"content": user_content})
    assert response.status_code == 200
    assistant_id = response.json()["id"]
    message_ids.append(assistant_id)

    try:
        list_response = client.get("/internal/chat/messages")
        user_message = next(
            m for m in list_response.json() if m["content"] == user_content
        )
        message_ids.append(user_message["id"])

        # Before disliking: absent from the Dislikes list.
        before = client.get("/internal/chat/dislikes", params={"range": "all"})
        assert before.status_code == 200
        assert all(item["id"] != assistant_id for item in before.json())

        dislike_response = client.post(
            f"/internal/chat/messages/{assistant_id}/dislike"
        )
        assert dislike_response.status_code == 204

        after = client.get("/internal/chat/dislikes", params={"range": "all"})
        assert after.status_code == 200
        matching = next(item for item in after.json() if item["id"] == assistant_id)
        assert matching["content"] == "a disliked reply"
        assert matching["questionContent"] == user_content
        assert matching["dislikedAt"] is not None

        # Un-disliking (toggle again) drops it out of the list and clears
        # disliked_at in the DB.
        undislike_response = client.post(
            f"/internal/chat/messages/{assistant_id}/dislike"
        )
        assert undislike_response.status_code == 204

        after_undislike = client.get("/internal/chat/dislikes", params={"range": "all"})
        assert all(item["id"] != assistant_id for item in after_undislike.json())

        with SyncSessionLocal() as session:
            disliked_at = session.execute(
                text("SELECT disliked_at FROM chat_messages WHERE id = :id"),
                {"id": assistant_id},
            ).scalar_one()
        assert disliked_at is None
    finally:
        _cleanup_messages(message_ids)


def test_no_answer_message_appears_in_list_with_marker_stripped_and_question_content(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    user_content = f"no answer question {uuid.uuid4()}"
    with (
        patch("app.chat.router.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.chat.router.generate_reply",
            new=AsyncMock(
                return_value=GeneratedReply(
                    content="I'm sorry, I don't have an answer to that.",
                    no_answer_found=True,
                )
            ),
        ),
    ):
        response = client.post("/internal/chat/messages", json={"content": user_content})
    assert response.status_code == 200
    assistant_id = response.json()["id"]
    message_ids.append(assistant_id)

    try:
        list_response = client.get("/internal/chat/messages")
        user_message = next(
            m for m in list_response.json() if m["content"] == user_content
        )
        message_ids.append(user_message["id"])

        with SyncSessionLocal() as session:
            no_answer_found = session.execute(
                text("SELECT no_answer_found FROM chat_messages WHERE id = :id"),
                {"id": assistant_id},
            ).scalar_one()
        assert no_answer_found is True

        no_answer_response = client.get(
            "/internal/chat/no-answer-messages", params={"range": "all"}
        )
        assert no_answer_response.status_code == 200
        matching = next(
            item for item in no_answer_response.json() if item["id"] == assistant_id
        )
        assert matching["questionContent"] == user_content
        assert matching["content"] == "I'm sorry, I don't have an answer to that."
        assert "[[NO_ANSWER]]" not in matching["content"]

        dismiss_response = client.post(
            f"/internal/chat/messages/{assistant_id}/dismiss-no-answer"
        )
        assert dismiss_response.status_code == 204

        after_dismiss = client.get(
            "/internal/chat/no-answer-messages", params={"range": "all"}
        )
        assert all(item["id"] != assistant_id for item in after_dismiss.json())

        # The underlying message itself is still visible in ordinary chat
        # history - dismiss only clears the flag, never deletes anything.
        still_there = client.get("/internal/chat/messages")
        assert any(m["id"] == assistant_id for m in still_there.json())
    finally:
        _cleanup_messages(message_ids)


def test_dismiss_no_answer_on_missing_id_is_a_204_noop(client: TestClient) -> None:
    response = client.post(
        f"/internal/chat/messages/{uuid.uuid4()}/dismiss-no-answer"
    )

    assert response.status_code == 204
    assert response.content == b""


def test_dislikes_list_range_filter_excludes_entries_outside_window(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    now = datetime.now(timezone.utc)
    try:
        question_id = _insert_message(role="user", content=f"range q {uuid.uuid4()}")
        message_ids.append(question_id)

        recent_id = _insert_message(
            role="assistant",
            content=f"recent disliked {uuid.uuid4()}",
            disliked=True,
            disliked_at=now - timedelta(hours=1),
            question_id=question_id,
        )
        message_ids.append(recent_id)

        old_id = _insert_message(
            role="assistant",
            content=f"old disliked {uuid.uuid4()}",
            disliked=True,
            disliked_at=now - timedelta(days=40),
            question_id=question_id,
        )
        message_ids.append(old_id)

        day_response = client.get("/internal/chat/dislikes", params={"range": "day"})
        assert day_response.status_code == 200
        day_ids = {item["id"] for item in day_response.json()}
        assert recent_id in day_ids
        assert old_id not in day_ids

        all_response = client.get("/internal/chat/dislikes", params={"range": "all"})
        assert all_response.status_code == 200
        all_ids = {item["id"] for item in all_response.json()}
        assert recent_id in all_ids
        assert old_id in all_ids
    finally:
        _cleanup_messages(message_ids)


def test_no_answer_messages_list_range_filter_excludes_entries_outside_window(
    client: TestClient,
) -> None:
    message_ids: list[str] = []
    now = datetime.now(timezone.utc)
    try:
        question_id = _insert_message(
            role="user", content=f"range no-answer q {uuid.uuid4()}"
        )
        message_ids.append(question_id)

        recent_id = _insert_message(
            role="assistant",
            content=f"recent no answer {uuid.uuid4()}",
            created_at=now - timedelta(hours=1),
            no_answer_found=True,
            question_id=question_id,
        )
        message_ids.append(recent_id)

        old_id = _insert_message(
            role="assistant",
            content=f"old no answer {uuid.uuid4()}",
            created_at=now - timedelta(days=40),
            no_answer_found=True,
            question_id=question_id,
        )
        message_ids.append(old_id)

        day_response = client.get(
            "/internal/chat/no-answer-messages", params={"range": "day"}
        )
        assert day_response.status_code == 200
        day_ids = {item["id"] for item in day_response.json()}
        assert recent_id in day_ids
        assert old_id not in day_ids

        all_response = client.get(
            "/internal/chat/no-answer-messages", params={"range": "all"}
        )
        assert all_response.status_code == 200
        all_ids = {item["id"] for item in all_response.json()}
        assert recent_id in all_ids
        assert old_id in all_ids
    finally:
        _cleanup_messages(message_ids)


def test_list_disliked_messages_without_session_cookie_returns_401() -> None:
    # A bare TestClient built directly (not via this module's `client`
    # fixture override, which is always pre-authenticated) so this request
    # genuinely carries no `session` cookie - same idiom as
    # test_documents_router.py's test_list_documents_without_session_cookie_returns_401.
    with TestClient(app) as bare_client:
        response = bare_client.get("/internal/chat/dislikes", params={"range": "all"})

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


def test_list_no_answer_messages_without_session_cookie_returns_401() -> None:
    with TestClient(app) as bare_client:
        response = bare_client.get(
            "/internal/chat/no-answer-messages", params={"range": "all"}
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


def test_transcribe_returns_text_from_transcribe_audio(client: TestClient) -> None:
    with patch(
        "app.chat.router.transcribe_audio",
        new=MagicMock(return_value="what is the refund policy"),
    ):
        response = client.post(
            "/internal/chat/transcribe",
            files={"file": ("recording.webm", io.BytesIO(b"fake-audio-bytes"), "audio/webm")},
        )

    assert response.status_code == 200
    assert response.json() == {"text": "what is the refund policy"}


def test_transcribe_voice_recognition_unavailable_returns_503(client: TestClient) -> None:
    with patch(
        "app.chat.router.transcribe_audio",
        new=MagicMock(side_effect=VoiceRecognitionUnavailableError("no model configured")),
    ):
        response = client.post(
            "/internal/chat/transcribe",
            files={"file": ("recording.webm", io.BytesIO(b"fake-audio-bytes"), "audio/webm")},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "voice_model_not_configured"


def test_transcribe_audio_conversion_error_returns_400(client: TestClient) -> None:
    with patch(
        "app.chat.router.transcribe_audio",
        new=MagicMock(side_effect=AudioConversionError("ffmpeg boom")),
    ):
        response = client.post(
            "/internal/chat/transcribe",
            files={"file": ("recording.webm", io.BytesIO(b"fake-audio-bytes"), "audio/webm")},
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "audio_processing_failed"


def test_transcribe_over_size_limit_returns_413(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.chat.router as chat_router

    monkeypatch.setattr(
        chat_router, "get_settings", lambda: Settings(max_upload_size_bytes=10)
    )

    response = client.post(
        "/internal/chat/transcribe",
        files={
            "file": (
                "recording.webm",
                io.BytesIO(b"this payload is over ten bytes"),
                "audio/webm",
            )
        },
    )

    assert response.status_code == 413
    assert response.json()["detail"] == "file_too_large"


def test_transcribe_without_session_cookie_returns_401() -> None:
    with TestClient(app) as bare_client:
        response = bare_client.post(
            "/internal/chat/transcribe",
            files={"file": ("recording.webm", io.BytesIO(b"fake-audio-bytes"), "audio/webm")},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


# --- POST /chat/voice-session (WebSocket) -----------------------------------
#
# First WebSocket route in this codebase - no prior test precedent to follow
# here. TestClient's `client.websocket_connect(...)` runs the ASGI app on a
# separate background thread's own event loop (see
# starlette.testclient.WebSocketTestSession), concurrently with this test's
# own foreground thread - so, unlike every other test in this file, there's
# no synchronous request/response round trip to rely on for "the server has
# finished processing what I just sent". `_wait_until` below polls instead of
# assuming any particular asyncio scheduling timing between the two threads.


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.01) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(f"condition not satisfied within {timeout}s")


class _FakeStreamingAudioDecoder:
    """Async-context-manager stand-in for app.chat.voice.StreamingAudioDecoder
    - no real ffmpeg subprocess. write() appends to an internal buffer AND
    puts the chunk onto an asyncio.Queue; read() re-yields whatever was
    written, in arrival order, as it becomes available - a queue rather than
    replaying a static list so the decode loop (a concurrent asyncio task)
    can consume chunks as the receive loop writes them, matching the real
    class's own concurrent-loops contract instead of assuming everything is
    written before anything is read."""

    def __init__(self) -> None:
        self.written: list[bytes] = []
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()

    async def __aenter__(self) -> "_FakeStreamingAudioDecoder":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    async def write(self, chunk: bytes) -> None:
        self.written.append(chunk)
        await self._queue.put(chunk)

    async def read(self):
        while True:
            yield await self._queue.get()


def _fake_kaldi_recognizer_factory(
    accept_waveform_results: list[bool], result_texts: list[str]
):
    """Returns a callable standing in for vosk.KaldiRecognizer - same
    monkeypatching spirit as test_chat_voice.py's own vosk.KaldiRecognizer
    fakes. `accept_waveform_results` scripts one AcceptWaveform() call per
    PCM chunk fed to it (in order); `result_texts` scripts Result()'s
    returned JSON text for each call where AcceptWaveform returned True (in
    order - fewer entries than True results in the mock's own
    StopIteration if over-called, which is deliberate: a test scripting too
    few Result() values indicates a bug in that test)."""

    def _factory(*args: object, **kwargs: object) -> MagicMock:
        recognizer = MagicMock()
        recognizer.AcceptWaveform = MagicMock(side_effect=accept_waveform_results)
        recognizer.Result = MagicMock(
            side_effect=[json.dumps({"text": t}) for t in result_texts]
        )
        return recognizer

    return _factory


def test_voice_session_without_session_cookie_is_rejected() -> None:
    # The one test proving this plan's own design-notes assumption -
    # Depends(require_session) actually rejects a websocket connection
    # cleanly under this app's exact FastAPI version - rather than just
    # trusting it. A bare TestClient (no session cookie, same idiom as
    # test_list_disliked_messages_without_session_cookie_returns_401 above)
    # must never reach voice_session's own body: FastAPI solves dependencies
    # BEFORE the endpoint runs, so require_session's HTTPException(401) is
    # raised pre-accept and Starlette/FastAPI convert that into a clean
    # WebSocketDenialResponse (a WebSocketDisconnect subclass carrying the
    # HTTPException's own status_code/body) instead of ever calling accept().
    with pytest.raises(WebSocketDenialResponse) as exc_info:
        with TestClient(app) as bare_client:
            with bare_client.websocket_connect("/internal/chat/voice-session"):
                pass  # pragma: no cover - never reached, connection is denied first

    assert exc_info.value.status_code == 401
    assert exc_info.value.json() == {"detail": "not_authenticated"}


def test_voice_session_finalized_segment_calls_handle_finalized_turn(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(chat_router, "get_voice_model", MagicMock(return_value=MagicMock()))
    monkeypatch.setattr(
        chat_router.vosk,
        "KaldiRecognizer",
        _fake_kaldi_recognizer_factory(
            accept_waveform_results=[False, True],
            result_texts=["what is the refund policy"],
        ),
    )
    monkeypatch.setattr(chat_router, "StreamingAudioDecoder", _FakeStreamingAudioDecoder)
    mock_handle_turn = AsyncMock()
    monkeypatch.setattr(chat_router, "_handle_finalized_turn", mock_handle_turn)

    with client.websocket_connect("/internal/chat/voice-session") as ws:
        ws.send_bytes(b"chunk-1")
        ws.send_bytes(b"chunk-2")

        _wait_until(lambda: mock_handle_turn.await_count >= 1)

    mock_handle_turn.assert_awaited_once_with(ANY, ANY, ANY, "what is the refund policy")


def test_voice_session_empty_finalized_text_is_skipped_and_session_stays_open(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(chat_router, "get_voice_model", MagicMock(return_value=MagicMock()))
    monkeypatch.setattr(
        chat_router.vosk,
        "KaldiRecognizer",
        _fake_kaldi_recognizer_factory(
            # 2nd chunk finalizes to silence/noise (empty text) - must be
            # silently skipped. 3rd chunk is a "canary": it finalizes to
            # real text afterward, proving the session is still alive and
            # correctly processing chunks after the empty one, not just
            # that nothing crashed within some fixed wait window.
            accept_waveform_results=[False, True, True],
            result_texts=["", "canary text"],
        ),
    )
    monkeypatch.setattr(chat_router, "StreamingAudioDecoder", _FakeStreamingAudioDecoder)
    mock_handle_turn = AsyncMock()
    monkeypatch.setattr(chat_router, "_handle_finalized_turn", mock_handle_turn)

    with client.websocket_connect("/internal/chat/voice-session") as ws:
        ws.send_bytes(b"chunk-1")
        ws.send_bytes(b"chunk-2")
        ws.send_bytes(b"chunk-3")

        _wait_until(lambda: mock_handle_turn.await_count >= 1)

    # Exactly one call, ever - the canary's. The empty-text finalize on
    # chunk-2 never triggered a call of its own.
    mock_handle_turn.assert_awaited_once_with(ANY, ANY, ANY, "canary text")


def test_voice_session_unconfigured_model_sends_error_event_and_closes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Same monkeypatch idiom as test_chat_voice.py's own
    # test_get_model_raises_when_vosk_model_path_unconfigured - exercises
    # the REAL app.chat.voice._get_model (aliased as
    # app.chat.router.get_voice_model) rather than mocking it away, so this
    # test also proves the two are genuinely wired together.
    voice._get_model.cache_clear()
    monkeypatch.setattr(voice, "get_settings", lambda: Settings(vosk_model_path=""))
    try:
        with client.websocket_connect("/internal/chat/voice-session") as ws:
            event = ws.receive_json()
            assert event == {"type": "error", "detail": "voice_model_not_configured"}

            with pytest.raises(WebSocketDisconnect):
                ws.receive_text()
    finally:
        voice._get_model.cache_clear()


# --- _handle_finalized_turn (Task 4: retrieval + streaming reply) ----------
#
# Called directly as a plain async function (not through the WebSocket route
# itself) against a real test-DB session, matching test_analysis_service.py's
# own `_run(coro)` + `async_session_factory()` idiom rather than
# test_chat_router.py's HTTP-request-based tests above - there's no HTTP
# request/response cycle for a VAD-triggered turn to ride along on.


def _run(coro):
    return asyncio.run(coro)


async def _call_handle_finalized_turn(websocket, spoken_text: str) -> None:
    async with async_session_factory() as session:
        await chat_router._handle_finalized_turn(
            websocket, session, asyncio.Lock(), spoken_text
        )


async def _fake_generate_reply_stream_success(user_message, context_chunks, result):
    # Mirrors app.chat.completion.generate_reply_stream's own out-parameter
    # contract: every piece yielded is also appended to result.content, and
    # result.no_answer_found is set once the stream is fully consumed.
    for piece in ["Paris", " is", " the capital"]:
        result.content += piece
        yield piece
    result.no_answer_found = False


async def _fake_generate_reply_stream_llm_error_partway(user_message, context_chunks, result):
    result.content += "Pa"
    yield "Pa"
    raise LLMError("boom mid-stream")


def _fetch_chat_message_row(message_id: str):
    with SyncSessionLocal() as session:
        return session.execute(
            text(
                "SELECT id, role, content, question_id, no_answer_found "
                "FROM chat_messages WHERE id = :id"
            ),
            {"id": message_id},
        ).one_or_none()


def _chat_messages_with_question_id(question_id: str) -> list:
    with SyncSessionLocal() as session:
        return session.execute(
            text("SELECT id FROM chat_messages WHERE question_id = :question_id"),
            {"question_id": question_id},
        ).all()


def test_handle_finalized_turn_happy_path_streams_reply_and_persists_both_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chat_router, "embed_texts", AsyncMock(side_effect=_fake_embed_texts))
    monkeypatch.setattr(
        chat_router, "generate_reply_stream", _fake_generate_reply_stream_success
    )
    mock_websocket = MagicMock()
    mock_websocket.send_json = AsyncMock()
    user_content = f"what is the capital {uuid.uuid4()}"
    message_ids: list[str] = []

    try:
        _run(_call_handle_finalized_turn(mock_websocket, user_content))

        calls = mock_websocket.send_json.call_args_list
        assert len(calls) == 5

        user_event = calls[0].args[0]
        assert user_event["type"] == "user_message"
        assert user_event["content"] == user_content
        message_ids.append(user_event["id"])

        delta_events = [call.args[0] for call in calls[1:4]]
        assert [event["type"] for event in delta_events] == ["reply_delta"] * 3
        assert [event["content"] for event in delta_events] == ["Paris", " is", " the capital"]

        done_event = calls[4].args[0]
        assert done_event["type"] == "reply_done"
        assert done_event["noAnswerFound"] is False
        message_ids.append(done_event["id"])

        user_row = _fetch_chat_message_row(user_event["id"])
        assert user_row is not None
        assert user_row.role == "user"
        assert user_row.content == user_content

        assistant_row = _fetch_chat_message_row(done_event["id"])
        assert assistant_row is not None
        assert assistant_row.role == "assistant"
        assert assistant_row.content == "Paris is the capital"
        assert str(assistant_row.question_id) == user_event["id"]
        assert assistant_row.no_answer_found is False
    finally:
        _cleanup_messages(message_ids)


def test_handle_finalized_turn_embed_texts_llm_error_sends_error_event_no_assistant_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chat_router, "embed_texts", AsyncMock(side_effect=LLMError("boom")))
    mock_generate_reply_stream = AsyncMock()
    monkeypatch.setattr(chat_router, "generate_reply_stream", mock_generate_reply_stream)
    mock_websocket = MagicMock()
    mock_websocket.send_json = AsyncMock()
    user_content = f"doomed voice question {uuid.uuid4()}"
    message_ids: list[str] = []

    try:
        _run(_call_handle_finalized_turn(mock_websocket, user_content))

        calls = mock_websocket.send_json.call_args_list
        assert len(calls) == 2

        user_event = calls[0].args[0]
        assert user_event["type"] == "user_message"
        message_ids.append(user_event["id"])

        error_event = calls[1].args[0]
        assert error_event == {"type": "error", "detail": "chat_completion_failed"}

        mock_generate_reply_stream.assert_not_called()

        user_row = _fetch_chat_message_row(user_event["id"])
        assert user_row is not None

        # No assistant row was ever written for this question.
        assert _chat_messages_with_question_id(user_event["id"]) == []
    finally:
        _cleanup_messages(message_ids)


def test_handle_finalized_turn_generate_reply_stream_llm_error_midstream_no_assistant_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chat_router, "embed_texts", AsyncMock(side_effect=_fake_embed_texts))
    monkeypatch.setattr(
        chat_router,
        "generate_reply_stream",
        _fake_generate_reply_stream_llm_error_partway,
    )
    mock_websocket = MagicMock()
    mock_websocket.send_json = AsyncMock()
    user_content = f"doomed streaming question {uuid.uuid4()}"
    message_ids: list[str] = []

    try:
        _run(_call_handle_finalized_turn(mock_websocket, user_content))

        calls = mock_websocket.send_json.call_args_list
        assert len(calls) >= 2

        user_event = calls[0].args[0]
        assert user_event["type"] == "user_message"
        message_ids.append(user_event["id"])

        error_event = calls[-1].args[0]
        assert error_event == {"type": "error", "detail": "chat_completion_failed"}

        # Still no assistant row - a partial/truncated reply must never be
        # persisted as if it were complete.
        assert _chat_messages_with_question_id(user_event["id"]) == []

        # The user message itself still persists (mirrors send_message's own
        # "user message persists even if generation fails" guarantee).
        user_row = _fetch_chat_message_row(user_event["id"])
        assert user_row is not None
    finally:
        _cleanup_messages(message_ids)
