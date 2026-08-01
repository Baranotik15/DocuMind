import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_storage
from app.events import record_event_async
from app.storage import StorageAdapter
from app.tasks import run_document_pipeline

router = APIRouter()

# Mirrors app.documents.extract_text's supported extension set - kept as a
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
