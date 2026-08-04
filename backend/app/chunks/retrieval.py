from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

from app.chunks.vectors import format_vector

# Only cross-entity import chunks/ makes - DocumentStatus is a plain data
# enum (see app.documents.constants), not documents business logic, needed
# here purely to filter the JOIN to ready documents' chunks.
from app.documents.constants import DocumentStatus

# Shared by both callers below - the pgvector cosine-similarity ORDER
# BY/LIMIT and the ready-documents JOIN/WHERE are identical either way;
# only the SELECT column list (see fetch_similar_chunks) differs.
_SIMILAR_CHUNKS_FROM_CLAUSE = (
    "FROM chunks "
    "JOIN documents ON documents.id = chunks.document_id "
    f"WHERE documents.status = '{DocumentStatus.READY}' "
    "ORDER BY chunks.embedding <=> :query_embedding ::vector "
    "LIMIT :top_k"
)


async def fetch_similar_chunks(
    session: AsyncSession,
    query_embedding: list[float],
    top_k: int,
    *,
    with_distance: bool = False,
) -> list[Row]:
    """Runs the pgvector cosine-similarity search shared by
    chat.router.send_message (context retrieval) and chat.router.top_chunks
    (retrieval-quality preview): the `top_k` chunks.edited_content across
    `ready` documents' chunks, nearest `query_embedding` first.

    `with_distance=False` (send_message's case) only selects
    chunks.edited_content. `with_distance=True` (top_chunks's case)
    additionally selects chunks.id/document_id/documents.filename and the
    raw cosine distance (aliased `distance`), which top_chunks turns into a
    0-100 match percentage per row.

    `top_k` is caller-supplied, not read from settings here - send_message
    and top_chunks deliberately source it from different places (see
    top_chunks's own docstring), and that distinction is preserved by
    leaving it a parameter rather than baking either source into this
    helper.
    """
    columns = (
        "chunks.id, chunks.document_id, documents.filename, chunks.edited_content, "
        "chunks.embedding <=> :query_embedding ::vector AS distance"
        if with_distance
        else "chunks.edited_content"
    )
    return (
        await session.execute(
            text(f"SELECT {columns} {_SIMILAR_CHUNKS_FROM_CLAUSE}"),
            {
                "query_embedding": format_vector(query_embedding),
                "top_k": top_k,
            },
        )
    ).all()
