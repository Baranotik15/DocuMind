import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from sqlalchemy import text

from app.chat.completion import GeneratedReply
from app.chat.constants import ChatChannel, ChatRole
from app.chunks.embedding import LLMError
from app.config import Settings
from app.db.sync_session import SyncSessionLocal
from app.slack import service

# The ts _FakeAsyncClient.post echoes back on a "successful" post whenever a
# test hasn't overridden `_FakeAsyncClient.next_response` - stands in for
# Slack's own message-timestamp identifier.
_FAKE_POSTED_TS = "999.111"


class _FakeResponse:
    """Minimal stand-in for an httpx.Response, covering only what
    service._post_reply actually touches (status_code, json())."""

    def __init__(self, *, status_code: int = 200, json_body: dict) -> None:
        self.status_code = status_code
        self._json_body = json_body

    def json(self) -> dict:
        return self._json_body


class _FakeAsyncClient:
    """Minimal async-context-manager stand-in for httpx.AsyncClient, used
    instead of a Mock: `async with obj:` looks up dunder methods on the
    type, not the instance, so a plain Mock instance can't fake this
    protocol without extra ceremony - a tiny real class is simpler and less
    fragile.

    `next_response` is a class attribute (not per-instance), since service
    code constructs its own httpx.AsyncClient() internally - there's no
    other way for a test to hand it a canned response. None (the default,
    restored by the autouse fixture below) means "succeed, echoing the
    posted channel back alongside _FAKE_POSTED_TS" - the common case every
    existing test relies on; set it to an explicit _FakeResponse to
    simulate a specific chat.postMessage failure instead.
    """

    instances: list["_FakeAsyncClient"] = []
    next_response: "_FakeResponse | None" = None

    def __init__(self, *args, **kwargs) -> None:
        self.posts: list[tuple[str, dict]] = []
        _FakeAsyncClient.instances.append(self)

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False

    async def post(self, url: str, **kwargs) -> _FakeResponse:
        self.posts.append((url, kwargs))
        if _FakeAsyncClient.next_response is not None:
            return _FakeAsyncClient.next_response
        return _FakeResponse(
            json_body={"ok": True, "channel": kwargs["json"]["channel"], "ts": _FAKE_POSTED_TS}
        )


@pytest.fixture(autouse=True)
def _reset_fake_client_instances() -> None:
    _FakeAsyncClient.instances = []
    _FakeAsyncClient.next_response = None
    yield
    _FakeAsyncClient.instances = []
    _FakeAsyncClient.next_response = None


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
                    "question_id, no_answer_found, slack_channel_id, slack_message_ts "
                    "FROM chat_messages WHERE question_id = :question_id"
                ),
                {"question_id": question_id},
            ).one()
        return session.execute(
            text(
                "SELECT id, role, content, channel, external_identity, "
                "question_id, no_answer_found, slack_channel_id, slack_message_ts "
                "FROM chat_messages WHERE content = :content"
            ),
            {"content": content},
        ).one()


def _fetch_dislike_state(message_id: str):
    with SyncSessionLocal() as session:
        return session.execute(
            text("SELECT disliked, disliked_at FROM chat_messages WHERE id = :id"),
            {"id": message_id},
        ).one()


def _insert_tracked_slack_reply(*, slack_channel_id: str, slack_message_ts: str) -> str:
    """Seeds a bare Slack-channel assistant row already carrying a
    slack_channel_id/slack_message_ts - standing in for a real row
    _answer_and_post would have written (via its own post-success UPDATE),
    without running the whole RAG pipeline just to get one. Returns the new
    row's id (as str)."""
    with SyncSessionLocal() as session:
        row = (
            session.execute(
                text(
                    "INSERT INTO chat_messages "
                    "(role, content, channel, slack_channel_id, slack_message_ts) "
                    "VALUES (:role, :content, :channel, :slack_channel_id, :slack_message_ts) "
                    "RETURNING id"
                ),
                {
                    "role": str(ChatRole.ASSISTANT),
                    "content": f"tracked reply {uuid.uuid4()}",
                    "channel": str(ChatChannel.SLACK),
                    "slack_channel_id": slack_channel_id,
                    "slack_message_ts": slack_message_ts,
                },
            )
        ).one()
        session.commit()
    return str(row.id)


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
        # The post "succeeded" (the default fake response), so the reply's
        # own posted-message identity should now be captured on this row.
        assert assistant_row.slack_channel_id == "C123"
        assert assistant_row.slack_message_ts == _FAKE_POSTED_TS
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
        # The fallback reply still gets posted (and, here, still succeeds)
        # - a failed RAG lookup is unrelated to a failed Slack post.
        assert assistant_row.slack_channel_id == "C123"
        assert assistant_row.slack_message_ts == _FAKE_POSTED_TS
    finally:
        _cleanup_chat_messages(message_ids)


def test_handle_app_mention_leaves_slack_message_identity_null_when_post_fails() -> None:
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
        _FakeAsyncClient.next_response = _FakeResponse(
            json_body={"ok": False, "error": "channel_not_found"}
        )
        with (
            patch("app.slack.service.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)),
            patch(
                "app.slack.service.generate_reply",
                new=AsyncMock(
                    return_value=GeneratedReply(content=reply_text, no_answer_found=False)
                ),
            ),
            patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient),
        ):
            asyncio.run(service.handle_app_mention(event))

        user_row = _fetch_message_row(content=question_text)
        message_ids.append(str(user_row.id))

        assistant_row = _fetch_message_row(question_id=str(user_row.id))
        message_ids.append(str(assistant_row.id))
        assert assistant_row.content == reply_text
        # The post failed (ok: false) - the reply was still (attempted to
        # be) delivered, but there's no posted-message identity to record,
        # so this row just can't be dislike-tracked via a reaction.
        assert assistant_row.slack_channel_id is None
        assert assistant_row.slack_message_ts is None
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
        assert assistant_row.slack_channel_id == "D123"
        assert assistant_row.slack_message_ts == _FAKE_POSTED_TS
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
        assert assistant_row.slack_channel_id == "D123"
        assert assistant_row.slack_message_ts == _FAKE_POSTED_TS
    finally:
        _cleanup_chat_messages(message_ids)


# --- _post_reply -----------------------------------------------------------


def test_post_reply_returns_parsed_response_body_on_success() -> None:
    with patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient):
        result = asyncio.run(service._post_reply("C123", "hello"))

    assert result == {"ok": True, "channel": "C123", "ts": _FAKE_POSTED_TS}
    assert len(_FakeAsyncClient.instances) == 1
    [(url, kwargs)] = _FakeAsyncClient.instances[0].posts
    assert url == "https://slack.com/api/chat.postMessage"
    assert kwargs["json"] == {"channel": "C123", "text": "hello"}


def test_post_reply_returns_none_when_response_body_has_ok_false() -> None:
    _FakeAsyncClient.next_response = _FakeResponse(
        json_body={"ok": False, "error": "channel_not_found"}
    )

    with patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient):
        result = asyncio.run(service._post_reply("C123", "hello"))

    assert result is None


def test_post_reply_returns_none_on_non_200_status_code() -> None:
    _FakeAsyncClient.next_response = _FakeResponse(status_code=500, json_body={"ok": False})

    with patch("app.slack.service.httpx.AsyncClient", new=_FakeAsyncClient):
        result = asyncio.run(service._post_reply("C123", "hello"))

    assert result is None


def test_post_reply_returns_none_on_network_error() -> None:
    class _RaisingAsyncClient(_FakeAsyncClient):
        async def post(self, url: str, **kwargs) -> _FakeResponse:
            self.posts.append((url, kwargs))
            raise httpx.ConnectError("boom")

    with patch("app.slack.service.httpx.AsyncClient", new=_RaisingAsyncClient):
        result = asyncio.run(service._post_reply("C123", "hello"))

    assert result is None


# --- handle_reaction ---------------------------------------------------


def test_handle_reaction_added_thumbsdown_marks_tracked_row_disliked() -> None:
    slack_channel_id = f"C{uuid.uuid4().hex[:10]}"
    slack_message_ts = f"{uuid.uuid4().hex[:10]}.111"
    message_id = _insert_tracked_slack_reply(
        slack_channel_id=slack_channel_id, slack_message_ts=slack_message_ts
    )

    try:
        event = {
            "type": "reaction_added",
            "user": "U024BE7LH",
            "reaction": "thumbsdown",
            "item": {"type": "message", "channel": slack_channel_id, "ts": slack_message_ts},
            "event_ts": slack_message_ts,
        }
        asyncio.run(service.handle_reaction(event))

        row = _fetch_dislike_state(message_id)
        assert row.disliked is True
        assert row.disliked_at is not None
    finally:
        _cleanup_chat_messages([message_id])


def test_handle_reaction_removed_thumbsdown_clears_disliked_on_same_row() -> None:
    slack_channel_id = f"C{uuid.uuid4().hex[:10]}"
    slack_message_ts = f"{uuid.uuid4().hex[:10]}.222"
    message_id = _insert_tracked_slack_reply(
        slack_channel_id=slack_channel_id, slack_message_ts=slack_message_ts
    )

    try:
        added_event = {
            "type": "reaction_added",
            "reaction": "thumbsdown",
            "item": {"type": "message", "channel": slack_channel_id, "ts": slack_message_ts},
        }
        removed_event = {
            "type": "reaction_removed",
            "reaction": "thumbsdown",
            "item": {"type": "message", "channel": slack_channel_id, "ts": slack_message_ts},
        }

        # Both handle_reaction calls (and the intermediate assertion, which
        # only touches the separate sync engine) run inside a single
        # asyncio.run() - the async engine's connection pool is a
        # module-level singleton bound to whichever event loop first used
        # it (see conftest.py's _dispose_engine_after_test), so a second,
        # separate asyncio.run() call here would hand it a stale connection
        # from the now-closed first loop.
        async def _apply_both() -> None:
            await service.handle_reaction(added_event)
            added_state = _fetch_dislike_state(message_id)
            assert added_state.disliked is True

            await service.handle_reaction(removed_event)

        asyncio.run(_apply_both())

        row = _fetch_dislike_state(message_id)
        assert row.disliked is False
        assert row.disliked_at is None
    finally:
        _cleanup_chat_messages([message_id])


def test_handle_reaction_on_untracked_message_is_a_harmless_no_op() -> None:
    # No chat_messages row anywhere carries this (channel, ts) pair - 0 rows
    # matched is expected and must not raise.
    event = {
        "type": "reaction_added",
        "reaction": "thumbsdown",
        "item": {
            "type": "message",
            "channel": f"C{uuid.uuid4().hex[:10]}",
            "ts": f"{uuid.uuid4().hex[:10]}.333",
        },
    }

    asyncio.run(service.handle_reaction(event))
