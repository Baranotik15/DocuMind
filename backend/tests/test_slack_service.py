import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.chat.completion import GeneratedReply
from app.chunks.embedding import LLMError
from app.config import Settings
from app.slack import service


class _FakeAsyncClient:
    """Minimal async-context-manager stand-in for httpx.AsyncClient, used
    instead of a Mock: `async with obj:` looks up dunder methods on the
    type, not the instance, so a plain Mock instance can't fake this
    protocol without extra ceremony - a tiny real class is simpler and less
    fragile."""

    instances: list["_FakeAsyncClient"] = []

    def __init__(self, *args, **kwargs) -> None:
        self.posts: list[tuple[str, dict]] = []
        _FakeAsyncClient.instances.append(self)

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False

    async def post(self, url: str, **kwargs) -> None:
        self.posts.append((url, kwargs))


@pytest.fixture(autouse=True)
def _reset_fake_client_instances() -> None:
    _FakeAsyncClient.instances = []
    yield
    _FakeAsyncClient.instances = []


@pytest.fixture(autouse=True)
def _patch_slack_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        service,
        "get_settings",
        lambda: Settings(slack_bot_token="xoxb-fake-token"),
    )


def test_strip_mention_removes_leading_bot_mention_token() -> None:
    assert (
        service._strip_mention("<@U0123ABC> what's the refund policy?")
        == "what's the refund policy?"
    )


def test_strip_mention_leaves_text_without_a_leading_mention_unchanged() -> None:
    assert service._strip_mention("what's the refund policy?") == "what's the refund policy?"


def test_handle_app_mention_posts_generated_reply_to_slack_thread() -> None:
    event = {
        "type": "app_mention",
        "text": "<@U0123ABC> what's the refund policy?",
        "channel": "C123",
        "ts": "111.222",
    }

    async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
        return [[0.0] * 1536 for _ in texts]

    with (
        patch("app.slack.service.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.slack.service.generate_reply",
            new=AsyncMock(
                return_value=GeneratedReply(content="30 days, no questions asked.", no_answer_found=False)
            ),
        ) as mock_generate_reply,
        patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient),
    ):
        asyncio.run(service.handle_app_mention(event))

    mock_generate_reply.assert_awaited_once()
    args, _ = mock_generate_reply.call_args
    assert args[0] == "what's the refund policy?"

    assert len(_FakeAsyncClient.instances) == 1
    [(url, kwargs)] = _FakeAsyncClient.instances[0].posts
    assert url == "https://slack.com/api/chat.postMessage"
    assert kwargs["headers"] == {"Authorization": "Bearer xoxb-fake-token"}
    assert kwargs["json"] == {
        "channel": "C123",
        "text": "30 days, no questions asked.",
    }


def test_handle_app_mention_posts_fallback_message_on_llm_error() -> None:
    event = {
        "type": "app_mention",
        "text": "<@U0123ABC> what's the refund policy?",
        "channel": "C123",
        "ts": "111.222",
    }

    with (
        patch("app.slack.service.embed_texts", new=AsyncMock(side_effect=LLMError("boom"))),
        patch("app.slack.service.generate_reply", new=AsyncMock()) as mock_generate_reply,
        patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient),
    ):
        asyncio.run(service.handle_app_mention(event))

    mock_generate_reply.assert_not_awaited()

    assert len(_FakeAsyncClient.instances) == 1
    [(url, kwargs)] = _FakeAsyncClient.instances[0].posts
    assert url == "https://slack.com/api/chat.postMessage"
    assert kwargs["json"]["channel"] == "C123"
    assert kwargs["json"]["text"] == service._FALLBACK_REPLY


def test_handle_direct_message_posts_generated_reply_without_stripping_text() -> None:
    # Unlike an app_mention's text, a DM's text has no leading "<@BOT_ID>"
    # token to strip - the whole thing is already the question.
    event = {
        "type": "message",
        "text": "what's the refund policy?",
        "channel": "D123",
        "channel_type": "im",
        "user": "U999",
        "ts": "111.222",
    }

    async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
        return [[0.0] * 1536 for _ in texts]

    with (
        patch("app.slack.service.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
        patch(
            "app.slack.service.generate_reply",
            new=AsyncMock(
                return_value=GeneratedReply(content="30 days, no questions asked.", no_answer_found=False)
            ),
        ) as mock_generate_reply,
        patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient),
    ):
        asyncio.run(service.handle_direct_message(event))

    mock_generate_reply.assert_awaited_once()
    args, _ = mock_generate_reply.call_args
    assert args[0] == "what's the refund policy?"

    assert len(_FakeAsyncClient.instances) == 1
    [(url, kwargs)] = _FakeAsyncClient.instances[0].posts
    assert url == "https://slack.com/api/chat.postMessage"
    assert kwargs["headers"] == {"Authorization": "Bearer xoxb-fake-token"}
    assert kwargs["json"] == {
        "channel": "D123",
        "text": "30 days, no questions asked.",
    }


def test_handle_direct_message_posts_fallback_message_on_llm_error() -> None:
    event = {
        "type": "message",
        "text": "what's the refund policy?",
        "channel": "D123",
        "channel_type": "im",
        "user": "U999",
        "ts": "111.222",
    }

    with (
        patch("app.slack.service.embed_texts", new=AsyncMock(side_effect=LLMError("boom"))),
        patch("app.slack.service.generate_reply", new=AsyncMock()) as mock_generate_reply,
        patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient),
    ):
        asyncio.run(service.handle_direct_message(event))

    mock_generate_reply.assert_not_awaited()

    assert len(_FakeAsyncClient.instances) == 1
    [(url, kwargs)] = _FakeAsyncClient.instances[0].posts
    assert url == "https://slack.com/api/chat.postMessage"
    assert kwargs["json"]["channel"] == "D123"
    assert kwargs["json"]["text"] == service._FALLBACK_REPLY
