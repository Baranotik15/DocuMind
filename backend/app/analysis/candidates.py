from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

# Only cross-entity import app/analysis/ makes - DocumentStatus is a plain
# data enum (see app.documents.constants), not documents business logic,
# needed here purely to filter the self-join to ready documents' chunks
# (same reasoning as app/chunks/retrieval.py's own DocumentStatus import).
from app.documents.constants import DocumentStatus

# How close two chunks' embeddings must be (pgvector cosine DISTANCE via the
# `<=>` operator - 0.0 = identical direction, 2.0 = opposite) to be
# considered "about the same topic" and worth an LLM contradiction check. A
# low distance is a NECESSARY but not SUFFICIENT condition for a
# contradiction - two chunks this close might simply agree, or one might be
# a superset of the other; this threshold only bounds what's worth asking
# the LLM about, it never itself claims a contradiction exists.
SIMILAR_CHUNK_DISTANCE_THRESHOLD: float = 0.35

# Hard cap on how many candidate pairs ever reach the LLM check stage in one
# run, regardless of how many fall under the threshold above - bounds
# worst-case LLM cost/latency per run even against a large, highly
# self-similar corpus.
MAX_CONFLICT_CANDIDATES: int = 30

# c1.id < c2.id (a plain UUID comparison, carrying no semantic meaning -
# just a total order to de-duplicate against) drops symmetric duplicates:
# since cosine distance is symmetric, (chunk A, chunk B) and (chunk B,
# chunk A) would otherwise both appear as separate rows.
_FIND_CANDIDATES_QUERY = text(
    "SELECT "
    "c1.id AS chunk_a_id, c1.document_id AS document_a_id, "
    "d1.filename AS document_a_filename, c1.edited_content AS chunk_a_content, "
    "c2.id AS chunk_b_id, c2.document_id AS document_b_id, "
    "d2.filename AS document_b_filename, c2.edited_content AS chunk_b_content, "
    "c1.embedding <=> c2.embedding AS distance "
    "FROM chunks AS c1 "
    "JOIN chunks AS c2 ON c1.id < c2.id AND c1.document_id != c2.document_id "
    "JOIN documents AS d1 ON d1.id = c1.document_id "
    "JOIN documents AS d2 ON d2.id = c2.document_id "
    "WHERE d1.status = :ready_status AND d2.status = :ready_status "
    "AND c1.embedding <=> c2.embedding < :threshold "
    "ORDER BY distance ASC "
    "LIMIT :max_candidates"
)


async def find_conflict_candidates(session: AsyncSession) -> list[Row]:
    """Stage 1 of conflict detection (see service.py's check_conflict for
    stage 2, the actual LLM judgment) - a pure-SQL, zero-LLM-calls pass
    that finds which pairs of chunks are even worth asking an LLM about.

    Self-joins `chunks` against itself via pgvector's `<=>` cosine-distance
    operator (the same operator app/chunks/retrieval.py already uses for
    text-query retrieval), comparing every chunk's embedding against every
    other chunk's embedding. A pair survives only if ALL of:
    - the two chunks belong to DIFFERENT documents (`c1.document_id !=
      c2.document_id`) - conflict detection is explicitly cross-document
      only (.claude/specs/documentation-analysis.md's Requirements): two
      passages disagreeing within the same document is a different
      problem this feature does not address.
    - both chunks' documents have status='ready' (the same corpus already
      used for chat retrieval/Relevance Preview).
    - their cosine distance is below SIMILAR_CHUNK_DISTANCE_THRESHOLD.

    `c1.id < c2.id` (a plain UUID comparison, carrying no semantic meaning
    - just a total order to de-duplicate against) drops symmetric
    duplicates: since cosine distance is symmetric, (chunk A, chunk B) and
    (chunk B, chunk A) would otherwise both appear as separate rows.

    Returns at most MAX_CONFLICT_CANDIDATES rows - id/document_id/filename
    /edited_content for both chunks in each pair, nearest (most similar)
    first - the caller (service.py) never re-fetches chunk content
    separately.
    """
    return (
        await session.execute(
            _FIND_CANDIDATES_QUERY,
            {
                "ready_status": str(DocumentStatus.READY),
                "threshold": SIMILAR_CHUNK_DISTANCE_THRESHOLD,
                "max_candidates": MAX_CONFLICT_CANDIDATES,
            },
        )
    ).all()
