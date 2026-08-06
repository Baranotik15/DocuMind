import re

import httpx
from sqlalchemy import text

from app.chat.completion import generate_reply
from app.chat.constants import ChatChannel, ChatRole
from app.chunks.embedding import LLMError, embed_texts
from app.chunks.retrieval import fetch_similar_chunks
from app.config import get_settings
from app.db.session import async_session_factory

_SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage"

# Slack always renders an @-mention at the very start of an app_mention
# event's text as "<@BOT_USER_ID> rest of the message" - stripped before the
# remainder is treated as the actual question. Only a literal leading match
# counts (count=1): a bot ID mentioned mid-message is left alone.
_MENTION_PREFIX_RE = re.compile(r"^<@[A-Z0-9]+>\s*")

# Posted to Slack instead of leaving an app_mention unanswered when the RAG
# lookup itself fails (embed_texts/generate_reply raising LLMError) - this
# runs in a background task, well after the webhook's own 200 response, so
# there's no HTTP response left to carry an error on.
_FALLBACK_REPLY = "Sorry, I couldn't generate a reply right now."


def _strip_mention(text: str) -> str:
    return _MENTION_PREFIX_RE.sub("", text, count=1)


async def handle_app_mention(event: dict) -> None:
    """Answers a Slack `app_mention` event and posts the reply back to
    Slack as a plain channel message (not threaded under the mention, by
    request - a thread reply is easy to miss). Intended to run as a FastAPI
    BackgroundTasks callback (see app/slack/router.py) - always ack the
    webhook with 200 first, then call this, since Slack requires a response
    within 3 seconds and the RAG + chat-completion round trip can easily
    take longer.

    Delegates the actual RAG lookup + Slack post to `_answer_and_post`,
    shared with `handle_direct_message` below - the only thing specific to
    an app_mention is that its `text` starts with a `<@BOT_ID>` token that
    needs stripping before it's a clean question. `event["user"]` is the
    Slack id of the human who did the mentioning - Slack always includes
    this on a genuine app_mention event - and is threaded through as the
    `chat_messages.external_identity` for both rows _answer_and_post
    persists.
    """
    question_text = _strip_mention(event.get("text", ""))
    await _answer_and_post(event["channel"], question_text, event["user"])


async def handle_direct_message(event: dict) -> None:
    """Answers a Slack DM `message` event (event.channel_type == "im") and
    posts the reply back to Slack as a plain message in the same DM
    channel. Intended to run as a FastAPI BackgroundTasks callback, same as
    handle_app_mention above.

    Unlike an app_mention's text, a DM's `text` has no leading bot-mention
    token to strip - the whole thing is already the question, so this just
    delegates straight to `_answer_and_post`. `event["user"]` (the Slack id
    of the human on the other end of the DM - Slack always includes this on
    a genuine message/im event) is threaded through the same way
    handle_app_mention's is.

    Relies on app/slack/router.py to only ever schedule this for a genuine
    new human message: events carrying a `subtype` (edits/deletions, a
    differently-shaped event) or a `bot_id` (the bot's own reply echoing
    back into the same DM - without filtering this out, the bot would
    answer its own answers forever) are never scheduled in the first place.
    """
    question_text = event.get("text", "")
    await _answer_and_post(event["channel"], question_text, event["user"])


async def _answer_and_post(channel: str, question_text: str, slack_user_id: str) -> None:
    """Shared by handle_app_mention and handle_direct_message: runs the
    exact same embed -> retrieve -> generate RAG pipeline as
    app.chat.router.send_message (see that module for the request-scoped
    version) against `question_text`, then posts the result to Slack as a
    plain (unthreaded) message in `channel` (the Slack channel/DM id to
    post the reply into - unrelated to `chat_messages.channel`, the
    'admin'/'slack' source-surface column both inserts below write as
    'slack').

    Opens its own AsyncSession via async_session_factory rather than a
    FastAPI `Depends(get_session)` - both callers run after the request/
    response cycle that would have provided one. That same session is
    reused for both chat_messages inserts below (not just the RAG
    retrieval step) - no second session is opened.

    Mirrors app.chat.router.send_message's own insert pattern: the user's
    question is inserted and committed immediately (persisted even if the
    RAG/LLM call below then fails), tagged channel='slack' and
    external_identity=slack_user_id. The assistant reply is inserted and
    committed afterward, with question_id pointing back at the user row.

    Never raises: an LLMError from either OpenAI call is caught and a short
    fallback message is both posted to Slack and persisted as the
    assistant row, instead of leaving the mention or DM unanswered.

    After that first session is closed and the reply is posted to Slack
    via _post_reply, a short second session/transaction records which
    Slack message the just-inserted assistant row *is* (chat.postMessage's
    own returned channel/ts - see _post_reply) against that row's
    slack_channel_id/slack_message_ts columns, so a later reaction_added/
    reaction_removed webhook event can be matched back to it (see
    handle_reaction below). Only written when the post actually succeeded
    and returned a ts - a failed post just leaves both columns NULL, which
    only means that particular reply can't be dislike-tracked via a
    reaction; it's still not a fatal condition for message delivery.
    """
    async with async_session_factory() as session:
        user_row = (
            await session.execute(
                text(
                    "INSERT INTO chat_messages (role, content, channel, external_identity) "
                    "VALUES (:role, :content, :channel, :external_identity) "
                    "RETURNING id"
                ),
                {
                    "role": str(ChatRole.USER),
                    "content": question_text,
                    "channel": str(ChatChannel.SLACK),
                    "external_identity": slack_user_id,
                },
            )
        ).one()
        await session.commit()

        try:
            [query_embedding] = await embed_texts([question_text])
            rows = await fetch_similar_chunks(
                session, query_embedding, get_settings().chat_retrieval_top_k
            )
            context_chunks = [row.edited_content for row in rows]
            reply = await generate_reply(question_text, context_chunks)
            reply_text = reply.content
            no_answer_found = reply.no_answer_found
        except LLMError:
            reply_text = _FALLBACK_REPLY
            # Not the same signal as generate_reply's own no_answer_found
            # (the model explicitly determining the docs don't cover the
            # question) - this is "we failed to answer at all" (embed_texts
            # or generate_reply itself raised). There's no better existing
            # flag for that from the Improvements page's no-answer list's
            # perspective, so it's set true here too rather than left
            # false, which would hide a real gap.
            no_answer_found = True

        assistant_row = (
            await session.execute(
                text(
                    "INSERT INTO chat_messages "
                    "(role, content, question_id, no_answer_found, channel, external_identity) "
                    "VALUES (:role, :content, :question_id, :no_answer_found, :channel, :external_identity) "
                    "RETURNING id"
                ),
                {
                    "role": str(ChatRole.ASSISTANT),
                    "content": reply_text,
                    "question_id": str(user_row.id),
                    "no_answer_found": no_answer_found,
                    "channel": str(ChatChannel.SLACK),
                    "external_identity": slack_user_id,
                },
            )
        ).one()
        await session.commit()

    post_response = await _post_reply(channel, reply_text)

    posted_ts = post_response.get("ts") if post_response is not None else None
    if posted_ts:
        async with async_session_factory() as session:
            await session.execute(
                text(
                    "UPDATE chat_messages SET "
                    "slack_channel_id = :slack_channel_id, slack_message_ts = :slack_message_ts "
                    "WHERE id = :id"
                ),
                {
                    "slack_channel_id": post_response.get("channel"),
                    "slack_message_ts": posted_ts,
                    "id": str(assistant_row.id),
                },
            )
            await session.commit()


async def _post_reply(channel: str, text: str) -> dict | None:
    """POSTs `text` as a plain message into Slack `channel` via
    chat.postMessage. Returns the parsed JSON response body on success -
    Slack's own documented shape is at least {"ok": true, "channel": "...",
    "ts": "..."}, where `ts` is Slack's own identifier for this specific
    posted message (used by _answer_and_post above to later match a
    reaction_added/reaction_removed event back to the chat_messages row
    this reply is) - or None on any failure: a network-level error, a
    non-2xx HTTP response, or a 200 response whose body itself carries
    "ok": false (Slack's chat.postMessage always answers with HTTP 200
    even for an API-level failure like an invalid channel, so the body's
    own "ok" field has to be checked too, not just the status code).

    Never raises: a failure here must not prevent message delivery from
    otherwise completing - the reply has still been (attempted to be)
    posted by the time this returns, so the caller treats a None return as
    "this reply just can't be dislike-tracked via a Slack reaction",
    nothing more severe.
    """
    settings = get_settings()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                _SLACK_POST_MESSAGE_URL,
                headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
                json={"channel": channel, "text": text},
            )
        if response.status_code != 200:
            return None
        body = response.json()
    except (httpx.HTTPError, ValueError):
        return None

    if not body.get("ok"):
        return None
    return body


async def handle_reaction(event: dict) -> None:
    """Answers a Slack `reaction_added`/`reaction_removed` webhook event
    for a thumbsdown (or its legacy "-1" alias) reaction - the only
    reaction app/slack/router.py ever schedules this for (any other
    reaction, or a reaction on a non-message item, is filtered out before
    this is even called - see that module's docstring).

    Sets chat_messages.disliked (and pairs it with disliked_at, populated
    iff disliked=true - same convention app.chat.router.dislike_message
    already established for the admin Chat page's own dislike button) for
    whichever row's slack_channel_id/slack_message_ts matches
    event["item"]["channel"]/event["item"]["ts"]. Unlike dislike_message's
    single toggle button, this is a direct (not toggled) set:
    reaction_added/reaction_removed already carry unambiguous
    directionality from Slack itself, so `event["type"]` alone determines
    the target state.

    A 0-row match is expected and harmless whenever the reacted-to message
    isn't a tracked bot reply - e.g. someone reacting to their own message,
    to an admin-channel message never posted through _post_reply, or to a
    bot reply whose slack_channel_id/slack_message_ts wasn't captured
    because its own post failed (see _answer_and_post). Never raises or
    logs that case as an error - scoped by `channel = 'slack'` too, purely
    for defense in depth (slack_channel_id/slack_message_ts are only ever
    populated on 'slack'-channel rows in the first place, so this can't
    actually change which rows match, but it keeps the WHERE clause
    self-documenting about which rows it's meant to touch).
    """
    is_disliked = event["type"] == "reaction_added"
    item = event.get("item", {})

    async with async_session_factory() as session:
        await session.execute(
            text(
                "UPDATE chat_messages SET "
                "disliked = :is_disliked, "
                "disliked_at = CASE WHEN :is_disliked THEN now() ELSE NULL END "
                "WHERE channel = :channel "
                "AND slack_channel_id = :slack_channel_id "
                "AND slack_message_ts = :slack_message_ts"
            ),
            {
                "is_disliked": is_disliked,
                "channel": str(ChatChannel.SLACK),
                "slack_channel_id": item.get("channel"),
                "slack_message_ts": item.get("ts"),
            },
        )
        await session.commit()
