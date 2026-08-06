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

        await session.execute(
            text(
                "INSERT INTO chat_messages "
                "(role, content, question_id, no_answer_found, channel, external_identity) "
                "VALUES (:role, :content, :question_id, :no_answer_found, :channel, :external_identity)"
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
        await session.commit()

    await _post_reply(channel, reply_text)


async def _post_reply(channel: str, text: str) -> None:
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        await client.post(
            _SLACK_POST_MESSAGE_URL,
            headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
            json={"channel": channel, "text": text},
        )
