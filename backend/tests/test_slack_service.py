import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text

from app.chat.completion import GeneratedReply
from app.chat.constants import ChatChannel, ChatRole
from app.chunks.embedding import LLMError
from app.config import Settings
from app.db.sync_session import SyncSessionLocal
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


def _fetch_message_row(*, content: str | None = None, question_id: str | None = None):
    # Direct-SQL verification idiom matching test_chat_router.py's own
    # SyncSessionLocal usage - _answer_and_post opens its own AsyncSession
    # against the same (test) database via async_session_factory, so its
    # writes are visible here once committed.
    with SyncSessionLocal() as session:
        if question_id is not None:
            return session.execute(
                text(
                    "SELECT id, role, content, channel, external_identity, "
                    "question_id, no_answer_found FROM chat_messages "
                    "WHERE question_id = :question_id"
                ),
                {"question_id": question_id},
            ).one()
        return session.execute(
            text(
                "SELECT id, role, content, channel, external_identity, "
                "question_id, no_answer_found FROM chat_messages "
                "WHERE content = :content"
            ),
            {"content": content},
        ).one()


def _cleanup_chat_messages(message_ids: list[str]) -> None:
    if not message_ids:
        return
    with SyncSessionLocal() as session:
        session.execute(
            text("DELETE FROM chat_messages WHERE id = ANY(:ids)"),
            {"ids": message_ids},
        )
        session.commit()


def test_strip_mention_removes_leading_bot_mention_token() -> None:
    assert (
        service._strip_mention("<@U0123ABC> what's the refund policy?")
        == "what's the refund policy?"
    )


def test_strip_mention_leaves_text_without_a_leading_mention_unchanged() -> None:
    assert service._strip_mention("what's the refund policy?") == "what's the refund policy?"


def test_handle_app_mention_posts_generated_reply_and_persists_chat_messages() -> None:
    suffix = uuid.uuid4()
    question_text = f"what's the refund policy? {suffix}"
    reply_text = f"30 days, no questions asked. {suffix}"
    event = {
        "type": "app_mention",
        "text": f"<@U0123ABC> {question_text}",
        "channel": "C123",
        "user": "U555HUMAN",
        "ts": "111.222",
    }

    async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
        return [[0.0] * 1536 for _ in texts]

    message_ids: list[str] = []
    try:
        with (
            patch("app.slack.service.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
            patch(
                "app.slack.service.generate_reply",
                new=AsyncMock(
                    return_value=GeneratedReply(content=reply_text, no_answer_found=False)
                ),
            ) as mock_generate_reply,
            patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient),
        ):
            asyncio.run(service.handle_app_mention(event))

        mock_generate_reply.assert_awaited_once()
        args, _ = mock_generate_reply.call_args
        assert args[0] == question_text

        assert len(_FakeAsyncClient.instances) == 1
        [(url, kwargs)] = _FakeAsyncClient.instances[0].posts
        assert url == "https://slack.com/api/chat.postMessage"
        assert kwargs["headers"] == {"Authorization": "Bearer xoxb-fake-token"}
        assert kwargs["json"] == {"channel": "C123", "text": reply_text}

        user_row = _fetch_message_row(content=question_text)
        message_ids.append(str(user_row.id))
        assert user_row.role == str(ChatRole.USER)
        assert user_row.channel == str(ChatChannel.SLACK)
        assert user_row.external_identity == "U555HUMAN"

        assistant_row = _fetch_message_row(question_id=str(user_row.id))
        message_ids.append(str(assistant_row.id))
        assert assistant_row.role == str(ChatRole.ASSISTANT)
        assert assistant_row.content == reply_text
        assert assistant_row.channel == str(ChatChannel.SLACK)
        assert assistant_row.external_identity == "U555HUMAN"
        assert assistant_row.no_answer_found is False
    finally:
        _cleanup_chat_messages(message_ids)


def test_handle_app_mention_posts_fallback_message_and_persists_no_answer_found_on_llm_error() -> None:
    suffix = uuid.uuid4()
    question_text = f"what's the refund policy? {suffix}"
    event = {
        "type": "app_mention",
        "text": f"<@U0123ABC> {question_text}",
        "channel": "C123",
        "user": "U555HUMAN",
        "ts": "111.222",
    }

    message_ids: list[str] = []
    try:
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

        user_row = _fetch_message_row(content=question_text)
        message_ids.append(str(user_row.id))
        assert user_row.role == str(ChatRole.USER)
        assert user_row.channel == str(ChatChannel.SLACK)
        assert user_row.external_identity == "U555HUMAN"

        assistant_row = _fetch_message_row(question_id=str(user_row.id))
        message_ids.append(str(assistant_row.id))
        assert assistant_row.role == str(ChatRole.ASSISTANT)
        assert assistant_row.content == service._FALLBACK_REPLY
        assert assistant_row.channel == str(ChatChannel.SLACK)
        assert assistant_row.external_identity == "U555HUMAN"
        # Not the same signal as generate_reply's own no_answer_found (the
        # model determining the docs don't cover the question) - this is
        # "we failed to answer at all", still surfaced as a gap on the
        # Improvements page's no-answer list.
        assert assistant_row.no_answer_found is True
    finally:
        _cleanup_chat_messages(message_ids)


def test_handle_direct_message_posts_generated_reply_and_persists_chat_messages() -> None:
    # Unlike an app_mention's text, a DM's text has no leading "<@BOT_ID>"
    # token to strip - the whole thing is already the question.
    suffix = uuid.uuid4()
    question_text = f"what's the refund policy? {suffix}"
    reply_text = f"30 days, no questions asked. {suffix}"
    event = {
        "type": "message",
        "text": question_text,
        "channel": "D123",
        "channel_type": "im",
        "user": "U999",
        "ts": "111.222",
    }

    async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
        return [[0.0] * 1536 for _ in texts]

    message_ids: list[str] = []
    try:
        with (
            patch("app.slack.service.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
            patch(
                "app.slack.service.generate_reply",
                new=AsyncMock(
                    return_value=GeneratedReply(content=reply_text, no_answer_found=False)
                ),
            ) as mock_generate_reply,
            patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient),
        ):
            asyncio.run(service.handle_direct_message(event))

        mock_generate_reply.assert_awaited_once()
        args, _ = mock_generate_reply.call_args
        assert args[0] == question_text

        assert len(_FakeAsyncClient.instances) == 1
        [(url, kwargs)] = _FakeAsyncClient.instances[0].posts
        assert url == "https://slack.com/api/chat.postMessage"
        assert kwargs["headers"] == {"Authorization": "Bearer xoxb-fake-token"}
        assert kwargs["json"] == {"channel": "D123", "text": reply_text}

        user_row = _fetch_message_row(content=question_text)
        message_ids.append(str(user_row.id))
        assert user_row.role == str(ChatRole.USER)
        assert user_row.channel == str(ChatChannel.SLACK)
        assert user_row.external_identity == "U999"

        assistant_row = _fetch_message_row(question_id=str(user_row.id))
        message_ids.append(str(assistant_row.id))
        assert assistant_row.role == str(ChatRole.ASSISTANT)
        assert assistant_row.content == reply_text
        assert assistant_row.channel == str(ChatChannel.SLACK)
        assert assistant_row.external_identity == "U999"
        assert assistant_row.no_answer_found is False
    finally:
        _cleanup_chat_messages(message_ids)


def test_handle_direct_message_posts_fallback_message_and_persists_no_answer_found_on_llm_error() -> None:
    suffix = uuid.uuid4()
    question_text = f"what's the refund policy? {suffix}"
    event = {
        "type": "message",
        "text": question_text,
        "channel": "D123",
        "channel_type": "im",
        "user": "U999",
        "ts": "111.222",
    }

    message_ids: list[str] = []
    try:
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

        user_row = _fetch_message_row(content=question_text)
        message_ids.append(str(user_row.id))
        assert user_row.role == str(ChatRole.USER)
        assert user_row.channel == str(ChatChannel.SLACK)
        assert user_row.external_identity == "U999"

        assistant_row = _fetch_message_row(question_id=str(user_row.id))
        message_ids.append(str(assistant_row.id))
        assert assistant_row.role == str(ChatRole.ASSISTANT)
        assert assistant_row.content == service._FALLBACK_REPLY
        assert assistant_row.channel == str(ChatChannel.SLACK)
        assert assistant_row.external_identity == "U999"
        assert assistant_row.no_answer_found is True
    finally:
        _cleanup_chat_messages(message_ids)
