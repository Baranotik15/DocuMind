import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.deps import get_storage
from app.services.events import record_event_async
from app.services.storage import StorageAdapter, StorageKeyNotFoundError
from app.worker.tasks import run_document_pipeline

router = APIRouter()


class ChunkIn(BaseModel):
    editedContent: str
    # id/originalContent/isDirty are accepted-but-ignored on the frontend
    # side of this contract - the request may include them, but a
    # full re-chunk discards prior chunk identity/boundaries per the spec,
    # so nothing here reads them.


class SaveChunksRequest(BaseModel):
    chunks: list[ChunkIn]
    manualBoundaries: bool = False
    # True when the operator manually dragged at least one chunk boundary
    # during the current editing session (see
    # .claude/specs/manual-chunk-boundaries.md) - `chunks` is then treated
    # as the final, authoritative chunk list and the algorithmic re-split
    # is skipped entirely; every chunk is embedded exactly as given.
    # Defaults to False, which is exactly today's behavior: full text
    # reconstruction (`"".join(...)`) followed by a full algorithmic
    # re-chunk.

# Mirrors app.services.documents.extract_text's supported extension set - kept as a
# local constant (rather than importing that module's private set) so this
# router only ever validates the *extension*, never triggers extraction
# itself. Actual parsing (and its failure handling) stays entirely on the
# async pipeline, per the spec's "corrupt file -> failed status, not a
# synchronous 400" requirement.
_SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".md", ".txt"}


def _document_summary(row) -> dict:
    return {
        "id": str(row.id),
        "filename": row.filename,
        "status": row.status,
        "uploadedAt": row.uploaded_at.isoformat(),
    }


@router.post("/documents")
async def upload_document(
    file: UploadFile,
    overwrite: bool = Form(False),
    session: AsyncSession = Depends(get_session),
    storage: StorageAdapter = Depends(get_storage),
) -> dict:
    """Validates the filename's extension before touching storage/DB, then
    branches on whether a document with this filename already exists. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 6 for the
    full contract."""
    filename = file.filename or ""
    extension = Path(filename).suffix.lower()
    if extension not in _SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="unsupported_file_type")

    data = await file.read()
    storage_key = f"docs/{filename}"

    existing = (
        await session.execute(
            text("SELECT id, status FROM documents WHERE filename = :filename"),
            {"filename": filename},
        )
    ).one_or_none()

    if existing is not None and existing.status == "chunking":
        raise HTTPException(status_code=409, detail="document_processing")

    if existing is not None and not overwrite:
        raise HTTPException(status_code=409, detail="duplicate_filename")

    if existing is None:
        row = (
            await session.execute(
                text(
                    "INSERT INTO documents (filename, storage_key, status) "
                    "VALUES (:filename, :storage_key, 'uploaded') "
                    "RETURNING id, filename, status, uploaded_at"
                ),
                {"filename": filename, "storage_key": storage_key},
            )
        ).one()
        storage.save(storage_key, data)
        await record_event_async(session, "document.uploaded", f"document_id={row.id}")
        await session.commit()
    else:
        storage.save(storage_key, data)
        row = (
            await session.execute(
                text(
                    "UPDATE documents SET status = 'uploaded' WHERE id = :id "
                    "RETURNING id, filename, status, uploaded_at"
                ),
                {"id": existing.id},
            )
        ).one()
        await record_event_async(session, "document.uploaded", f"document_id={row.id}")
        await session.commit()

    # .delay() is a plain synchronous call (it blocks on a broker round trip
    # even outside of eager mode, and - under the test suite's eager mode -
    # runs the task fully inline, including run_pipeline's own
    # asyncio.run() call). Running it via asyncio.to_thread keeps it off
    # this coroutine's event loop thread, which is required for eager mode
    # specifically: asyncio.run() cannot be called from a thread that
    # already has a running loop, which this request-handling coroutine's
    # thread does.
    await asyncio.to_thread(run_document_pipeline.delay, str(row.id))

    return _document_summary(row)


@router.get("/documents")
async def list_documents(session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns every document as a DocumentSummary dict, ordered by
    uploaded_at."""
    rows = (
        await session.execute(
            text(
                "SELECT id, filename, status, uploaded_at FROM documents "
                "ORDER BY uploaded_at"
            )
        )
    ).all()
    return [_document_summary(row) for row in rows]


@router.delete("/documents/{document_id}", status_code=204)
async def delete_document(
    document_id: str,
    session: AsyncSession = Depends(get_session),
    storage: StorageAdapter = Depends(get_storage),
) -> None:
    """Deletes a document's stored file and its `documents` row. Its
    `chunks` rows are removed automatically by Postgres via the
    `chunks.document_id REFERENCES documents(id) ON DELETE CASCADE` FK
    from the 0003 migration - not deleted explicitly here.

    Blocked (409) while a pipeline run is actively writing to the
    document (status == 'chunking'), mirroring the same busy-guard
    reasoning used for Save/overwrite elsewhere in this router."""
    row = (
        await session.execute(
            text(
                "SELECT filename, storage_key, status FROM documents "
                "WHERE id = :document_id"
            ),
            {"document_id": document_id},
        )
    ).one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail="document_not_found")

    if row.status == "chunking":
        raise HTTPException(status_code=409, detail="document_processing")

    try:
        storage.delete(row.storage_key)
    except StorageKeyNotFoundError:
        # The file is already missing from disk (e.g. manually removed, or
        # an orphaned row from some prior partial failure) - don't let that
        # block cleaning up the DB row.
        pass

    await session.execute(
        text("DELETE FROM documents WHERE id = :document_id"),
        {"document_id": document_id},
    )
    await record_event_async(
        session,
        "document.deleted",
        f"document_id={document_id}, filename={row.filename}",
    )
    await session.commit()


def _chunk_summary(row) -> dict:
    return {
        "id": str(row.id),
        "documentId": str(row.document_id),
        "originalContent": row.original_content,
        "editedContent": row.edited_content,
        "isDirty": False,
    }


@router.get("/documents/{document_id}/chunks")
async def get_chunks(
    document_id: str, session: AsyncSession = Depends(get_session)
) -> list[dict]:
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
            "UPDATE documents SET status = 'chunking' "
            "WHERE id = :document_id AND status IN ('ready', 'failed') "
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
            raise HTTPException(status_code=404, detail="document_not_found")
        raise HTTPException(status_code=409, detail="document_processing")

    await session.commit()

    # See upload_document's comment above on why .delay() must be run via
    # asyncio.to_thread under Celery-eager test mode: run_document_pipeline
    # internally does asyncio.run(embed_texts(...)), which cannot be called
    # from a thread whose event loop is already running - which this
    # coroutine's thread's is.
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
