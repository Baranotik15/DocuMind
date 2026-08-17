import asyncio

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.chat.completion import (
    NO_ANSWER_MARKER,
    GeneratedReply,
    StreamingReplyResult,
    _parse_reply,
    generate_reply,
    generate_reply_stream,
)
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


def _make_stream_chunk(delta_content: str | None) -> MagicMock:
    delta = MagicMock(content=delta_content)
    choice = MagicMock(delta=delta)
    return MagicMock(choices=[choice])


class FakeAsyncStream:
    """Wraps a list of scripted items so it behaves like the async-iterable
    the real OpenAI SDK returns for stream=True: each item is either a chunk
    MagicMock (yielded) or a BaseException instance (raised from __anext__,
    simulating an SDK failure partway through iteration)."""

    def __init__(self, items: list) -> None:
        self._items = iter(items)

    def __aiter__(self) -> "FakeAsyncStream":
        return self

    async def __anext__(self):
        try:
            item = next(self._items)
        except StopIteration:
            raise StopAsyncIteration
        if isinstance(item, BaseException):
            raise item
        return item


async def _collect_stream(
    user_message: str,
    context_chunks: list[str],
    result: StreamingReplyResult,
    client: MagicMock,
) -> str:
    pieces = []
    async for delta in generate_reply_stream(user_message, context_chunks, result, client=client):
        pieces.append(delta)
    return "".join(pieces)


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

    assert isinstance(result, GeneratedReply)
    assert result.content == "the answer"
    assert result.no_answer_found is False


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

    assert result.content == "fallback answer"
    assert result.no_answer_found is False
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


def test_generate_reply_detects_no_answer_marker_and_strips_it() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response(
            f"{NO_ANSWER_MARKER} I'm sorry, I don't have an answer to that."
        )
    )

    result = asyncio.run(generate_reply("what is x?", ["chunk"], client=client))

    assert isinstance(result, GeneratedReply)
    assert result.no_answer_found is True
    assert result.content == "I'm sorry, I don't have an answer to that."
    assert NO_ANSWER_MARKER not in result.content


def test_generate_reply_without_marker_reports_no_answer_found_false() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_make_chat_response("an ordinary reply")
    )

    result = asyncio.run(generate_reply("what is x?", ["chunk"], client=client))

    assert result.no_answer_found is False
    assert result.content == "an ordinary reply"


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
    assert NO_ANSWER_MARKER in system_content
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
    assert NO_ANSWER_MARKER in system_content


def test_parse_reply_strips_marker_and_following_space() -> None:
    result = _parse_reply(f"{NO_ANSWER_MARKER} I'm sorry, no answer.")

    assert result == GeneratedReply(content="I'm sorry, no answer.", no_answer_found=True)


def test_parse_reply_strips_marker_and_following_newline() -> None:
    result = _parse_reply(f"{NO_ANSWER_MARKER}\nI'm sorry, no answer.")

    assert result == GeneratedReply(content="I'm sorry, no answer.", no_answer_found=True)


def test_parse_reply_without_marker_passes_content_through_unchanged() -> None:
    result = _parse_reply("just a normal reply")

    assert result == GeneratedReply(content="just a normal reply", no_answer_found=False)


def test_parse_reply_marker_mentioned_mid_reply_is_not_treated_as_prefix() -> None:
    content = f"this reply mentions {NO_ANSWER_MARKER} in the middle, not at the start"

    result = _parse_reply(content)

    assert result == GeneratedReply(content=content, no_answer_found=False)


def test_generate_reply_stream_yields_deltas_with_no_marker() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=FakeAsyncStream(
            [_make_stream_chunk("Hello"), _make_stream_chunk(" there")]
        )
    )
    result = StreamingReplyResult()

    collected = asyncio.run(_collect_stream("hi", [], result, client))

    assert collected == "Hello there"
    assert result.content == "Hello there"
    assert result.no_answer_found is False


def test_generate_reply_stream_drops_marker_split_across_chunks() -> None:
    split_point = len(NO_ANSWER_MARKER) // 2
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=FakeAsyncStream(
            [
                _make_stream_chunk(NO_ANSWER_MARKER[:split_point]),
                _make_stream_chunk(NO_ANSWER_MARKER[split_point:]),
                _make_stream_chunk("\nActual"),
                _make_stream_chunk(" answer"),
            ]
        )
    )
    result = StreamingReplyResult()

    collected = asyncio.run(_collect_stream("what is x?", ["chunk"], result, client))

    assert NO_ANSWER_MARKER not in collected
    assert collected == "Actual answer"
    assert result.content == "Actual answer"
    assert result.no_answer_found is True


def test_generate_reply_stream_short_reply_shorter_than_marker_flushes_on_stream_end() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=FakeAsyncStream([_make_stream_chunk("Hi")])
    )
    result = StreamingReplyResult()

    collected = asyncio.run(_collect_stream("hi", [], result, client))

    assert collected == "Hi"
    assert result.content == "Hi"
    assert result.no_answer_found is False


def test_generate_reply_stream_raises_llm_error_on_sdk_failure_mid_stream() -> None:
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=FakeAsyncStream(
            [_make_stream_chunk("Hello"), RuntimeError("boom")]
        )
    )
    result = StreamingReplyResult()

    async def _consume() -> None:
        async for _ in generate_reply_stream("hi", [], result, client=client):
            pass

    with pytest.raises(LLMError):
        asyncio.run(_consume())
