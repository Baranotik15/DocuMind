import json

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from app.config import get_settings
from app.slack.service import handle_app_mention, handle_direct_message, handle_reaction
from app.slack.signature import verify_slack_signature

router = APIRouter()

_SIGNATURE_HEADER = "X-Slack-Signature"
_TIMESTAMP_HEADER = "X-Slack-Request-Timestamp"
# Present (with an incrementing value) whenever Slack is retrying a webhook
# delivery, e.g. because our own first ack took longer than its 3-second
# budget. Only ever act on the first delivery of a given event - scheduling
# the RAG lookup again on a retry would double-reply in the Slack thread.
_RETRY_NUM_HEADER = "X-Slack-Retry-Num"

_INVALID_SIGNATURE_ERROR = "invalid_slack_signature"

# Slack's canonical reaction name is "thumbsdown"; "-1" is the legacy alias
# some older/third-party clients still send for the same emoji - both are
# treated as the same dislike signal (see app.slack.service.handle_reaction).
_DISLIKE_REACTIONS = ("thumbsdown", "-1")


@router.post("/slack/events")
async def slack_events(request: Request, background_tasks: BackgroundTasks) -> dict:
    """Slack Events API webhook - mounted at POST /internal/slack/events
    without session auth (see app/main.py: this router is included the same
    way auth_router is, outside the require_session loop). Slack itself is
    the caller here, not a logged-in admin-panel operator - it authenticates
    via the request-signature scheme in app/slack/signature.py instead of a
    session cookie.

    Reads the raw body first (needed byte-for-byte for signature
    verification, not FastAPI's parsed-model body) and rejects with 401
    before any JSON parsing happens if the signature doesn't check out.

    Branches on the parsed payload's `type`:
    - "url_verification": Slack's one-time endpoint-ownership check when the
      Request URL is saved in the Slack app config - echoes back the given
      challenge token.
    - "event_callback" with event.type == "app_mention": acks with 200
      immediately and defers the actual RAG lookup + Slack reply to a
      BackgroundTasks callback (see app.slack.service.handle_app_mention) -
      Slack requires a response within 3 seconds, well under what an LLM
      round trip can take.
    - "event_callback" with event.type == "message" and
      event.channel_type == "im": a direct message to the bot - answered
      unprompted (no @ mention needed), same deferred-BackgroundTasks
      pattern via app.slack.service.handle_direct_message. Two kinds of
      "message"/"im" events are filtered out first, since neither is a
      genuine new human message to answer:
        * anything carrying a `subtype` (e.g. "message_changed",
          "message_deleted") - edits/deletions, not new messages, and a
          different event shape (nested message/previous_message).
        * anything carrying a `bot_id` - critically, this is what stops an
          infinite reply loop: when we post our own RAG answer back into
          the DM via chat.postMessage, Slack fires a *new* message/im event
          for that very reply. Every bot/app-authored message carries
          bot_id (Slack's own documented way to tell it apart from a human
          message), so skipping these is what breaks the loop before it
          starts.
      The same bot_id guard is applied to the app_mention path too, for
      consistency, even though Slack only ever fires app_mention for human
      mentions in practice.
    - "event_callback" with event.type in ("reaction_added",
      "reaction_removed"), event.item.type == "message", and
      event.reaction in _DISLIKE_REACTIONS: a human added/removed a
      thumbsdown (or its legacy "-1" alias) on some Slack message - deferred
      to app.slack.service.handle_reaction, same BackgroundTasks pattern as
      above, to flip that message's chat_messages.disliked flag if (and
      only if) it's a tracked bot reply (see handle_reaction's own
      docstring for the no-op-if-untracked case). The bot_id guard is
      deliberately NOT applied here: per Slack's documented event shape
      (https://api.slack.com/events/reaction_added), a reaction_added/
      reaction_removed event never carries a bot_id field at all (unlike
      message/app_mention events) - there's nothing to guard against, since
      this bot never calls reactions.add/remove on anything itself. Any
      other reaction (not thumbsdown/-1) or a reaction on a non-message
      item (e.g. a file) is a no-op, same as the general fallthrough below -
      deliberately not a general-purpose reaction-tracking system.
    - All of the above are skipped entirely (no background work scheduled,
      but still 200) when X-Slack-Retry-Num is present, since that means
      Slack already sent this same event once before.
    - anything else (event_callback for any other event.type/channel_type
      combination, or any other top-level `type`): acked with an empty 200,
      no-op.
    """
    raw_body = await request.body()

    settings = get_settings()
    if not verify_slack_signature(
        signing_secret=settings.slack_signing_secret,
        timestamp=request.headers.get(_TIMESTAMP_HEADER),
        signature=request.headers.get(_SIGNATURE_HEADER),
        body=raw_body,
    ):
        raise HTTPException(status_code=401, detail=_INVALID_SIGNATURE_ERROR)

    payload = json.loads(raw_body)

    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}

    if payload.get("type") == "event_callback":
        event = payload.get("event", {})
        is_retry = _RETRY_NUM_HEADER in request.headers
        # Never act on a message the bot itself authored - see the
        # bot-loop-prevention note in the docstring above. Applies to both
        # branches below.
        is_bot_authored = bool(event.get("bot_id"))

        if not is_retry and not is_bot_authored:
            if event.get("type") == "app_mention":
                background_tasks.add_task(handle_app_mention, event)
            elif (
                event.get("type") == "message"
                and event.get("channel_type") == "im"
                and not event.get("subtype")
            ):
                background_tasks.add_task(handle_direct_message, event)

        # Reaction events (see docstring above) have no bot_id field at all
        # per Slack's documented event shape, so this branch deliberately
        # only checks is_retry, not is_bot_authored.
        if (
            not is_retry
            and event.get("type") in ("reaction_added", "reaction_removed")
            and event.get("item", {}).get("type") == "message"
            and event.get("reaction") in _DISLIKE_REACTIONS
        ):
            background_tasks.add_task(handle_reaction, event)

    return {}
