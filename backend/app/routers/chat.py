from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.events import record_event_async
from app.llm import LLMError, embed_texts, generate_reply
from app.vectors import format_vector

router = APIRouter()


class SendMessageRequest(BaseModel):
    content: str


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
        text("INSERT INTO chat_messages (role, content) VALUES ('user', :content)"),
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
        rows = (
            await session.execute(
                text(
                    "SELECT chunks.edited_content FROM chunks "
                    "JOIN documents ON documents.id = chunks.document_id "
                    "WHERE documents.status = 'ready' "
                    "ORDER BY chunks.embedding <=> :query_embedding ::vector "
                    "LIMIT :top_k"
                ),
                {
                    "query_embedding": format_vector(query_embedding),
                    "top_k": get_settings().chat_retrieval_top_k,
                },
            )
        ).all()
        context_chunks = [row.edited_content for row in rows]

        # 4. Generate the assistant reply.
        reply = await generate_reply(body.content, context_chunks)
    except LLMError:
        raise HTTPException(status_code=502, detail="chat_completion_failed")

    # 5. Insert + commit the assistant message, then record + commit the
    # dashboard event.
    assistant_row = (
        await session.execute(
            text(
                "INSERT INTO chat_messages (role, content) "
                "VALUES ('assistant', :content) "
                "RETURNING id, role, content, disliked"
            ),
            {"content": reply},
        )
    ).one()
    await session.commit()
    await record_event_async(
        session, "chat.message_sent", f"message_id={assistant_row.id}"
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
