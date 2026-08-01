import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db_sync import SyncSessionLocal
from app.llm import LLMError

ZERO_VECTOR_1536 = "[" + ",".join(["0"] * 1536) + "]"


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    # External-boundary mock (app.routers.chat.embed_texts) so no real
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
                "app.routers.chat.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
            ),
            patch(
                "app.routers.chat.generate_reply",
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
        patch("app.routers.chat.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.routers.chat.generate_reply",
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
        patch("app.routers.chat.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.routers.chat.generate_reply",
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


def test_dislike_message_is_idempotent(client: TestClient) -> None:
    message_ids: list[str] = []
    user_content = f"dislike me {uuid.uuid4()}"
    with (
        patch("app.routers.chat.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.routers.chat.generate_reply", new=AsyncMock(return_value="a reply")
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

        first_dislike = client.post(
            f"/internal/chat/messages/{assistant_id}/dislike"
        )
        assert first_dislike.status_code == 204
        assert first_dislike.content == b""

        list_response = client.get("/internal/chat/messages")
        matching = next(
            m for m in list_response.json() if m["id"] == assistant_id
        )
        assert matching["disliked"] is True

        second_dislike = client.post(
            f"/internal/chat/messages/{assistant_id}/dislike"
        )
        assert second_dislike.status_code == 204
    finally:
        _cleanup_messages(message_ids)
