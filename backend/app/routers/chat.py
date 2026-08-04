from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.constants import ChatRole, DashboardEventType
from app.db.session import get_session
from app.services.events import record_event_async
from app.services.llm import LLMError, embed_texts, generate_reply
from app.services.retrieval import fetch_similar_chunks

router = APIRouter()


class SendMessageRequest(BaseModel):
    content: str


class TopChunksRequest(BaseModel):
    content: str


TOP_CHUNKS_LIMIT = 5

# Shared by both LLM-call try/except blocks below (send_message's embed +
# chat-completion step, top_chunks's embed step) - same error contract
# either way: any LLMError becomes a 502 with this detail.
_CHAT_COMPLETION_FAILED_ERROR = "chat_completion_failed"


def _message_summary(row) -> dict:
    return {
        "id": str(row.id),
        "role": row.role,
        "content": row.content,
        "disliked": row.disliked,
    }


@router.post("/chat/messages")
async def send_message(
    body: SendMessageRequest, session: AsyncSession = Depends(get_session)
) -> dict:
    """Persists the user's message, retrieves relevant chunks across the
    corpus of `ready` documents via pgvector similarity search, and calls
    the OpenAI chat completion API for a reply. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 8 for
    the full contract."""
    # 1. Insert + commit the user message immediately, so it's persisted
    # even if everything below fails.
    await session.execute(
        text(
            f"INSERT INTO chat_messages (role, content) VALUES ('{ChatRole.USER}', :content)"
        ),
        {"content": body.content},
    )
    await session.commit()

    # 2-4. Embed the incoming message, run similarity search, and generate
    # the assistant reply. The user message inserted above stays committed
    # even if any of this fails - no assistant row gets written. Both the
    # embedding call (2) and the chat completion call (4) hit the OpenAI
    # client and can raise LLMError, so both are covered by the same
    # handler.
    try:
        # 2. Embed the incoming message (single-text batch call).
        [query_embedding] = await embed_texts([body.content])

        # 3. Similarity search across ready documents' chunks. Empty result
        # is valid (no ready documents yet) - passed through as an empty
        # context list, not special-cased.
        rows = await fetch_similar_chunks(
            session, query_embedding, get_settings().chat_retrieval_top_k
        )
        context_chunks = [row.edited_content for row in rows]

        # 4. Generate the assistant reply.
        reply = await generate_reply(body.content, context_chunks)
    except LLMError:
        raise HTTPException(status_code=502, detail=_CHAT_COMPLETION_FAILED_ERROR)

    # 5. Insert + commit the assistant message, then record + commit the
    # dashboard event.
    assistant_row = (
        await session.execute(
            text(
                "INSERT INTO chat_messages (role, content) "
                f"VALUES ('{ChatRole.ASSISTANT}', :content) "
                "RETURNING id, role, content, disliked"
            ),
            {"content": reply},
        )
    ).one()
    await session.commit()
    await record_event_async(
        session, DashboardEventType.CHAT_MESSAGE_SENT, f"message_id={assistant_row.id}"
    )
    await session.commit()

    # 6. Return the assistant message - not the user message (deliberate
    # contract change from the mock, per spec).
    return _message_summary(assistant_row)


@router.get("/chat/messages")
async def list_messages(session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns all chat_messages ordered by created_at ascending."""
    rows = (
        await session.execute(
            text(
                "SELECT id, role, content, disliked FROM chat_messages "
                "ORDER BY created_at"
            )
        )
    ).all()
    return [_message_summary(row) for row in rows]


@router.post("/chat/messages/{message_id}/dislike", status_code=204)
async def dislike_message(
    message_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    """UPDATE chat_messages SET disliked = NOT disliked WHERE id=:id - a
    toggle, not a one-way flag: each call flips the current value, so a
    second call on the same message undoes the first (guards against
    accidental double-clicks on the frontend's dislike button). Still 204
    with no body either way, and still a no-op (not a 404), if the id
    doesn't exist - deliberately not a 404, unlike other "not found" cases
    elsewhere in this codebase."""
    await session.execute(
        text("UPDATE chat_messages SET disliked = NOT disliked WHERE id = :id"),
        {"id": message_id},
    )
    await session.commit()


def _top_chunk_summary(row, match_percent: float) -> dict:
    return {
        "chunkId": str(row.id),
        "documentId": str(row.document_id),
        "filename": row.filename,
        "content": row.edited_content,
        "matchPercent": match_percent,
    }


@router.post("/chat/top-chunks")
async def top_chunks(
    body: TopChunksRequest, session: AsyncSession = Depends(get_session)
) -> list[dict]:
    """Read-only diagnostic endpoint for previewing retrieval quality
    without sending a chat message: embeds `body.content` and returns the
    top TOP_CHUNKS_LIMIT chunks (across `ready` documents) most similar to
    it, each annotated with a 0-100 match percentage. Never writes
    anything - no chat_messages row, no dashboard event, no commit.

    Uses a hardcoded TOP_CHUNKS_LIMIT rather than
    `get_settings().chat_retrieval_top_k` deliberately: this is a
    conceptually separate "top 5 preview" feature from chat's own
    retrieval step, and shouldn't silently change if that setting is
    ever tuned differently later, even though both happen to be 5 today.
    """
    try:
        # Same embed-failure error contract as send_message: any LLMError
        # from the OpenAI call becomes a 502.
        [query_embedding] = await embed_texts([body.content])
    except LLMError:
        raise HTTPException(status_code=502, detail=_CHAT_COMPLETION_FAILED_ERROR)

    # Same similarity search as send_message's retrieval step, but also
    # projecting the raw cosine distance so a match percentage can be
    # computed per row. Empty result (no ready documents, or none match)
    # is valid - passed straight through as an empty list, not an error.
    rows = await fetch_similar_chunks(
        session, query_embedding, TOP_CHUNKS_LIMIT, with_distance=True
    )

    return [
        _top_chunk_summary(
            row, round(max(0.0, min(1.0, 1 - row.distance)) * 100, 1)
        )
        for row in rows
    ]
