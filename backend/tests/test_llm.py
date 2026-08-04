import asyncio

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.chat.completion import generate_reply
from app.chunks import embedding
from app.chunks.embedding import LLMError, embed_texts
from app.config import Settings


@pytest.fixture(autouse=True)
def _clear_client_cache() -> None:
    """get_client() is @lru_cache'd at module level (app.chunks.embedding,
    shared by embed_texts here and generate_reply's own call into it).
    Clear before and after each test so a client built against
    monkeypatched settings in one test never leaks into another test
    running later in the same process."""
    embedding.get_client.cache_clear()
    yield
    embedding.get_client.cache_clear()


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


def test_generate_reply_raises_llm_error_on_none_content() -> None:
    # A real OpenAI response shape (e.g. a content-filter refusal), not a
    # made-up edge case - content=None must become the same LLMError/502
    # contract as an outright SDK failure, not a silent None return.
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response(None)
    )

    with pytest.raises(LLMError):
        asyncio.run(generate_reply("hi", [], client=client))


def test_generate_reply_raises_llm_error_on_empty_choices() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=MagicMock(choices=[]))

    with pytest.raises(LLMError):
        asyncio.run(generate_reply("hi", [], client=client))


def test_embed_texts_raises_llm_error_when_api_key_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression test: get_client() calls AsyncOpenAI(api_key=...), whose
    constructor itself raises openai.OpenAIError at construction time when
    the key is missing/empty - not just when an API call fails. That error
    must be wrapped as LLMError like any other SDK failure, so callers only
    ever have to catch LLMError."""
    monkeypatch.setattr(embedding, "get_settings", lambda: Settings(openai_api_key=""))

    with pytest.raises(LLMError):
        asyncio.run(embed_texts(["a"]))


def test_generate_reply_raises_llm_error_when_api_key_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # generate_reply (app.chat.completion) calls the same shared get_client()
    # as embed_texts, defined in app.chunks.embedding - so that's the
    # module whose get_settings must be patched here too, not
    # app.chat.completion's own (only used for openai_chat_model, which
    # this failure path never reaches).
    monkeypatch.setattr(embedding, "get_settings", lambda: Settings(openai_api_key=""))

    with pytest.raises(LLMError):
        asyncio.run(generate_reply("hi", []))


def _system_message_content(kwargs: dict) -> str:
    return next(
        message["content"] for message in kwargs["messages"] if message["role"] == "system"
    )


def test_generate_reply_system_prompt_includes_house_rules_with_context() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("the answer")
    )

    asyncio.run(generate_reply("what is x?", ["chunk one", "chunk two"], client=client))

    _, kwargs = client.chat.completions.create.call_args
    system_content = _system_message_content(kwargs)
    assert "reply in the same language the user's question was written in" in system_content
    assert "Never discuss this system's own security" in system_content
    assert (
        "I'm sorry, I don't have an answer to that based on the available documents."
        in system_content
    )
    assert "chunk one" in system_content
    assert "chunk two" in system_content


def test_generate_reply_system_prompt_includes_house_rules_with_empty_context() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("fallback answer")
    )

    asyncio.run(generate_reply("hello", [], client=client))

    _, kwargs = client.chat.completions.create.call_args
    system_content = _system_message_content(kwargs)
    assert "reply in the same language the user's question was written in" in system_content
    assert "Never discuss this system's own security" in system_content
    assert (
        "I'm sorry, I don't have an answer to that based on the available documents."
        in system_content
    )
