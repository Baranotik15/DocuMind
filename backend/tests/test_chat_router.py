import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.chunks.embedding import LLMError
from app.chunks.vectors import format_vector
from app.db.sync_session import SyncSessionLocal

ZERO_VECTOR_1536 = "[" + ",".join(["0"] * 1536) + "]"


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
                new=AsyncMock(return_value="mocked reply"),
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
            new=AsyncMock(return_value="fallback reply"),
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
            "app.chat.router.generate_reply", new=AsyncMock(return_value="a reply")
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
