import hashlib
import hmac
import json
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.slack import router as slack_router_module

_SIGNING_SECRET = "test-router-signing-secret"


@pytest.fixture(autouse=True)
def _patch_slack_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    # slack_router reads get_settings() per-request (not at import time), so
    # patching the module-level name here is enough - no lru_cache to bust,
    # unlike app.config.get_settings itself. Same idiom as test_llm.py's
    # `monkeypatch.setattr(embedding, "get_settings", ...)`.
    monkeypatch.setattr(
        slack_router_module,
        "get_settings",
        lambda: Settings(slack_signing_secret=_SIGNING_SECRET),
    )


def _sign(body: bytes, timestamp: str) -> str:
    basestring = f"v0:{timestamp}:{body.decode()}"
    return "v0=" + hmac.new(_SIGNING_SECRET.encode(), basestring.encode(), hashlib.sha256).hexdigest()


def _signed_headers(body: bytes, *, timestamp: str | None = None) -> dict:
    ts = timestamp if timestamp is not None else str(int(time.time()))
    return {
        "X-Slack-Signature": _sign(body, ts),
        "X-Slack-Request-Timestamp": ts,
        "Content-Type": "application/json",
    }


@pytest.fixture
def client() -> TestClient:
    # Deliberately a bare TestClient(app), not conftest's authenticated_client
    # - this router must be reachable with no `session` cookie at all (see
    # test_slack_events_reachable_without_session_cookie below).
    with TestClient(app) as test_client:
        yield test_client


def _app_mention_payload(text: str = "<@U0123ABC> what's the refund policy?") -> dict:
    return {
        "type": "event_callback",
        "event": {
            "type": "app_mention",
            "text": text,
            "channel": "C123",
            "ts": "111.222",
        },
    }


def _dm_message_payload(text: str = "what's the refund policy?", **event_overrides: object) -> dict:
    event = {
        "type": "message",
        "text": text,
        "channel": "D123",
        "channel_type": "im",
        "user": "U999",
        "ts": "111.222",
    }
    event.update(event_overrides)
    return {"type": "event_callback", "event": event}


def test_url_verification_echoes_challenge(client: TestClient) -> None:
    body = json.dumps({"type": "url_verification", "challenge": "abc123"}).encode()

    response = client.post(
        "/internal/slack/events", content=body, headers=_signed_headers(body)
    )

    assert response.status_code == 200
    assert response.json() == {"challenge": "abc123"}


def test_invalid_signature_returns_401(client: TestClient) -> None:
    body = json.dumps({"type": "url_verification", "challenge": "abc123"}).encode()
    headers = _signed_headers(body)
    headers["X-Slack-Signature"] = "v0=" + ("0" * 64)

    response = client.post("/internal/slack/events", content=body, headers=headers)

    assert response.status_code == 401


def test_missing_signature_headers_returns_401(client: TestClient) -> None:
    body = json.dumps({"type": "url_verification", "challenge": "abc123"}).encode()

    response = client.post(
        "/internal/slack/events", content=body, headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 401


def test_stale_timestamp_returns_401(client: TestClient) -> None:
    body = json.dumps({"type": "url_verification", "challenge": "abc123"}).encode()
    stale_timestamp = str(int(time.time()) - (60 * 10))

    response = client.post(
        "/internal/slack/events",
        content=body,
        headers=_signed_headers(body, timestamp=stale_timestamp),
    )

    assert response.status_code == 401


def test_app_mention_event_schedules_background_task_and_returns_200_promptly(
    client: TestClient,
) -> None:
    body = json.dumps(_app_mention_payload()).encode()

    with patch(
        "app.slack.router.handle_app_mention", new=AsyncMock()
    ) as mock_handle:
        response = client.post(
            "/internal/slack/events", content=body, headers=_signed_headers(body)
        )

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle.assert_awaited_once()
    args, _ = mock_handle.call_args
    assert args[0]["text"] == "<@U0123ABC> what's the refund policy?"
    assert args[0]["channel"] == "C123"


def test_app_mention_with_retry_header_does_not_schedule_background_work(
    client: TestClient,
) -> None:
    body = json.dumps(_app_mention_payload()).encode()
    headers = _signed_headers(body)
    headers["X-Slack-Retry-Num"] = "1"

    with patch(
        "app.slack.router.handle_app_mention", new=AsyncMock()
    ) as mock_handle:
        response = client.post("/internal/slack/events", content=body, headers=headers)

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle.assert_not_awaited()


def test_non_app_mention_event_callback_returns_200_without_scheduling(
    client: TestClient,
) -> None:
    payload = {
        "type": "event_callback",
        "event": {"type": "message", "text": "just a channel message", "channel": "C1", "ts": "1"},
    }
    body = json.dumps(payload).encode()

    with patch(
        "app.slack.router.handle_app_mention", new=AsyncMock()
    ) as mock_handle:
        response = client.post(
            "/internal/slack/events", content=body, headers=_signed_headers(body)
        )

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle.assert_not_awaited()


def test_app_mention_event_with_bot_id_does_not_schedule_background_work(
    client: TestClient,
) -> None:
    # app_mention events are only ever fired for genuine human mentions per
    # Slack's docs, but this guard is added for consistency with the DM path
    # (where it's load-bearing, see the bot-loop tests below) and costs
    # nothing.
    payload = _app_mention_payload()
    payload["event"]["bot_id"] = "B0123"
    body = json.dumps(payload).encode()

    with patch(
        "app.slack.router.handle_app_mention", new=AsyncMock()
    ) as mock_handle:
        response = client.post(
            "/internal/slack/events", content=body, headers=_signed_headers(body)
        )

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle.assert_not_awaited()


def test_dm_message_event_schedules_background_task_and_returns_200_promptly(
    client: TestClient,
) -> None:
    body = json.dumps(_dm_message_payload()).encode()

    with patch(
        "app.slack.router.handle_direct_message", new=AsyncMock()
    ) as mock_handle:
        response = client.post(
            "/internal/slack/events", content=body, headers=_signed_headers(body)
        )

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle.assert_awaited_once()
    args, _ = mock_handle.call_args
    assert args[0]["text"] == "what's the refund policy?"
    assert args[0]["channel"] == "D123"


def test_dm_message_event_with_bot_id_does_not_schedule_background_work(
    client: TestClient,
) -> None:
    # This is the bot-loop-prevention case: our own reply into the DM fires
    # another message/im event carrying bot_id - must never be scheduled,
    # or the bot would reply to its own replies forever.
    body = json.dumps(_dm_message_payload(bot_id="B0123")).encode()

    with (
        patch("app.slack.router.handle_direct_message", new=AsyncMock()) as mock_handle_dm,
        patch("app.slack.router.handle_app_mention", new=AsyncMock()) as mock_handle_mention,
    ):
        response = client.post(
            "/internal/slack/events", content=body, headers=_signed_headers(body)
        )

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle_dm.assert_not_awaited()
    mock_handle_mention.assert_not_awaited()


def test_dm_message_event_with_subtype_does_not_schedule_background_work(
    client: TestClient,
) -> None:
    # message_changed/message_deleted (and other subtypes) are edits or
    # deletions, not a genuine new message to answer - the event shape is
    # also different (nested message/previous_message, no top-level text the
    # same way).
    body = json.dumps(_dm_message_payload(subtype="message_changed")).encode()

    with patch(
        "app.slack.router.handle_direct_message", new=AsyncMock()
    ) as mock_handle:
        response = client.post(
            "/internal/slack/events", content=body, headers=_signed_headers(body)
        )

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle.assert_not_awaited()


def test_dm_message_event_with_retry_header_does_not_schedule_background_work(
    client: TestClient,
) -> None:
    body = json.dumps(_dm_message_payload()).encode()
    headers = _signed_headers(body)
    headers["X-Slack-Retry-Num"] = "1"

    with patch(
        "app.slack.router.handle_direct_message", new=AsyncMock()
    ) as mock_handle:
        response = client.post("/internal/slack/events", content=body, headers=headers)

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle.assert_not_awaited()


def test_channel_message_event_does_not_schedule_dm_or_mention_handling(
    client: TestClient,
) -> None:
    # A plain (non-app_mention) message in a real channel must keep being
    # ignored - channels stay mention-only, only DMs (channel_type "im") get
    # the no-mention-needed behavior.
    payload = {
        "type": "event_callback",
        "event": {
            "type": "message",
            "text": "just a channel message",
            "channel": "C1",
            "channel_type": "channel",
            "ts": "1",
        },
    }
    body = json.dumps(payload).encode()

    with (
        patch("app.slack.router.handle_direct_message", new=AsyncMock()) as mock_handle_dm,
        patch("app.slack.router.handle_app_mention", new=AsyncMock()) as mock_handle_mention,
    ):
        response = client.post(
            "/internal/slack/events", content=body, headers=_signed_headers(body)
        )

    assert response.status_code == 200
    assert response.json() == {}
    mock_handle_dm.assert_not_awaited()
    mock_handle_mention.assert_not_awaited()


def test_slack_events_reachable_without_session_cookie(client: TestClient) -> None:
    # If slack_router were mistakenly mounted through main.py's
    # require_session loop (like every other router except auth_router),
    # this validly-signed, cookie-less request would 401 with
    # "not_authenticated" instead of being processed on its own merits.
    body = json.dumps({"type": "url_verification", "challenge": "no-cookie-needed"}).encode()

    response = client.post(
        "/internal/slack/events", content=body, headers=_signed_headers(body)
    )

    assert response.status_code == 200
    assert response.json() == {"challenge": "no-cookie-needed"}
