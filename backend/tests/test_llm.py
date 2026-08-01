import asyncio

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.llm import LLMError, embed_texts, generate_reply


def _make_embedding_response(vectors: list[list[float]]) -> MagicMock:
    data = [MagicMock(embedding=vector) for vector in vectors]
    return MagicMock(data=data)


def _make_chat_response(content: str) -> MagicMock:
    message = MagicMock(content=content)
    choice = MagicMock(message=message)
    return MagicMock(choices=[choice])


def test_embed_texts_returns_vectors_in_input_order() -> None:
    client = MagicMock()
    client.embeddings.create = AsyncMock(
        return_value=_make_embedding_response([[0.1, 0.2], [0.3, 0.4]])
    )

    result = asyncio.run(embed_texts(["first", "second"], client=client))

    assert result == [[0.1, 0.2], [0.3, 0.4]]


def test_embed_texts_calls_client_once_with_all_texts() -> None:
    client = MagicMock()
    client.embeddings.create = AsyncMock(
        return_value=_make_embedding_response([[0.1], [0.2], [0.3]])
    )

    asyncio.run(embed_texts(["a", "b", "c"], client=client))

    client.embeddings.create.assert_awaited_once()
    _, kwargs = client.embeddings.create.call_args
    assert kwargs["input"] == ["a", "b", "c"]


def test_embed_texts_raises_llm_error_on_sdk_failure() -> None:
    client = MagicMock()
    client.embeddings.create = AsyncMock(side_effect=RuntimeError("boom"))

    with pytest.raises(LLMError):
        asyncio.run(embed_texts(["a"], client=client))


def test_generate_reply_returns_completion_text_content() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("the answer")
    )

    result = asyncio.run(
        generate_reply("what is x?", ["chunk one", "chunk two"], client=client)
    )

    assert result == "the answer"


def test_generate_reply_request_includes_context_chunks_and_message() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("the answer")
    )

    asyncio.run(generate_reply("what is x?", ["chunk one", "chunk two"], client=client))

    client.chat.completions.create.assert_awaited_once()
    _, kwargs = client.chat.completions.create.call_args
    joined = " ".join(message["content"] for message in kwargs["messages"])
    assert "chunk one" in joined
    assert "chunk two" in joined
    assert "what is x?" in joined


def test_generate_reply_allows_empty_context_chunks() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("fallback answer")
    )

    result = asyncio.run(generate_reply("hello", [], client=client))

    assert result == "fallback answer"
    client.chat.completions.create.assert_awaited_once()


def test_generate_reply_raises_llm_error_on_sdk_failure() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(side_effect=RuntimeError("boom"))

    with pytest.raises(LLMError):
        asyncio.run(generate_reply("hi", [], client=client))
