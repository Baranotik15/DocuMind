import asyncio

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.chunks.schemas import ChunkSummary, SaveChunksRequest
from app.db.session import get_session

# The one necessary exception to chunks/ otherwise being import-leaf:
# accepting a Save is inherently a write against the owning document's
# status, and triggering a re-chunk means enqueueing the Celery task that
# owns the document pipeline (see app.documents.pipeline's own docstring).
from app.documents.constants import DocumentStatus
from app.documents.tasks import run_document_pipeline

router = APIRouter()

# Detail codes shared across both endpoints below - kept as constants so
# both raise sites for the same condition stay in sync (see
# app/documents/router.py for its own copy of the same two literals, used
# for the same conditions on the sibling document-level endpoints).
_DOCUMENT_PROCESSING_ERROR = "document_processing"
_DOCUMENT_NOT_FOUND_ERROR = "document_not_found"


def _chunk_summary(row) -> ChunkSummary:
    return ChunkSummary(
        id=str(row.id),
        documentId=str(row.document_id),
        originalContent=row.original_content,
        editedContent=row.edited_content,
        isDirty=False,
    )


@router.get("/documents/{document_id}/chunks")
async def get_chunks(
    document_id: str, session: AsyncSession = Depends(get_session)
) -> list[ChunkSummary]:
    """Returns chunks for document_id ordered by position. `isDirty` is
    always False from the server - it's a purely client-side concept while
    unsaved edits haven't been sent yet."""
    rows = (
        await session.execute(
            text(
                "SELECT id, document_id, original_content, edited_content "
                "FROM chunks WHERE document_id = :document_id ORDER BY position"
            ),
            {"document_id": document_id},
        )
    ).all()
    return [_chunk_summary(row) for row in rows]


@router.post("/documents/{document_id}/chunks", status_code=202)
async def save_chunks(
    document_id: str,
    body: SaveChunksRequest,
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Atomic compare-and-swap re-chunk trigger. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 7 for the
    full contract. The single guarded UPDATE below is what closes the race
    between two concurrent Saves (or a Save on a not-yet-ready document) -
    it must stay a single statement, not a SELECT-then-UPDATE."""
    result = await session.execute(
        text(
            f"UPDATE documents SET status = '{DocumentStatus.CHUNKING}' "
            "WHERE id = :document_id AND status IN "
            f"('{DocumentStatus.READY}', '{DocumentStatus.FAILED}') "
            "RETURNING id"
        ),
        {"document_id": document_id},
    )
    row = result.one_or_none()

    if row is None:
        # The CAS above already closed the race for the "own the
        # transition" decision. This follow-up SELECT only distinguishes
        # which error to report (404 vs 409) for a request that lost -
        # it never decides whether to update, so it doesn't reopen the
        # race the CAS guards against.
        exists = (
            await session.execute(
                text("SELECT 1 FROM documents WHERE id = :document_id"),
                {"document_id": document_id},
            )
        ).one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail=_DOCUMENT_NOT_FOUND_ERROR)
        raise HTTPException(status_code=409, detail=_DOCUMENT_PROCESSING_ERROR)

    await session.commit()

    # See documents/router.py's upload_document comment on why .delay()
    # must be run via asyncio.to_thread under Celery-eager test mode:
    # run_document_pipeline internally does asyncio.run(embed_texts(...)),
    # which cannot be called from a thread whose event loop is already
    # running - which this coroutine's thread's is.
    if body.manualBoundaries:
        # The operator manually dragged at least one chunk boundary this
        # session - `body.chunks` IS the final chunk list, in order; skip
        # the algorithmic re-split entirely and embed each chunk exactly
        # as given, none re-split, none merged.
        manual_chunks = [chunk.editedContent for chunk in body.chunks]
        await asyncio.to_thread(
            run_document_pipeline.delay, document_id, manual_chunks=manual_chunks
        )
    else:
        # Request array order IS document order, as sent by the frontend -
        # not re-sorted here.
        source_text = "".join(chunk.editedContent for chunk in body.chunks)
        await asyncio.to_thread(run_document_pipeline.delay, document_id, source_text)

    # Returned as a bare Response (rather than `None`) so the body is
    # truly empty, per the spec's "return 202 with no body" - FastAPI would
    # otherwise serialize a `None` return value as a `null` JSON body,
    # since (unlike 204) 202 doesn't forbid a response body by itself.
    return Response(status_code=202)
