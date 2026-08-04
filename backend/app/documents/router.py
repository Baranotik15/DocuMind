import asyncio
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dashboard_events.constants import DashboardEventType
from app.dashboard_events.recording import record_event_async
from app.db.session import get_session
from app.documents.constants import DocumentStatus, SUPPORTED_DOCUMENT_EXTENSIONS
from app.documents.deps import get_storage
from app.documents.schemas import DocumentSummary
from app.documents.storage import StorageAdapter, StorageKeyNotFoundError
from app.documents.tasks import run_document_pipeline

router = APIRouter()

# Detail codes shared across more than one endpoint below - kept as
# constants so all raise sites for the same condition stay in sync (see
# app/documents/constants.py for the DocumentStatus registry, and
# app/dashboard_events/constants.py for DashboardEventType, these
# endpoints also use).
_DOCUMENT_PROCESSING_ERROR = "document_processing"
_DOCUMENT_NOT_FOUND_ERROR = "document_not_found"


def _document_summary(row) -> DocumentSummary:
    return DocumentSummary(
        id=str(row.id),
        filename=row.filename,
        status=row.status,
        uploadedAt=row.uploaded_at.isoformat(),
    )


@router.post("/documents")
async def upload_document(
    file: UploadFile,
    overwrite: bool = Form(False),
    session: AsyncSession = Depends(get_session),
    storage: StorageAdapter = Depends(get_storage),
) -> DocumentSummary:
    """Validates the filename's extension before touching storage/DB, then
    branches on whether a document with this filename already exists. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 6 for the
    full contract."""
    filename = file.filename or ""
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_DOCUMENT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="unsupported_file_type")

    data = await file.read()

    existing = (
        await session.execute(
            text(
                "SELECT id, status, storage_key FROM documents "
                "WHERE filename = :filename"
            ),
            {"filename": filename},
        )
    ).one_or_none()

    if existing is not None and existing.status == DocumentStatus.CHUNKING:
        raise HTTPException(status_code=409, detail=_DOCUMENT_PROCESSING_ERROR)

    if existing is not None and not overwrite:
        raise HTTPException(status_code=409, detail="duplicate_filename")

    if existing is None:
        # Storage key is generated server-side (UUID + the already-validated
        # extension), never derived from the client-supplied filename - a
        # filename like "../../../etc/cron.d/x.txt" must not be able to
        # steer where on disk this gets written. `filename` itself is kept
        # only as display/lookup metadata in the `documents` row.
        storage_key = f"docs/{uuid4()}{extension}"
        row = (
            await session.execute(
                text(
                    "INSERT INTO documents (filename, storage_key, status) "
                    f"VALUES (:filename, :storage_key, '{DocumentStatus.UPLOADED}') "
                    "RETURNING id, filename, status, uploaded_at"
                ),
                {"filename": filename, "storage_key": storage_key},
            )
        ).one()
        storage.save(storage_key, data)
        await record_event_async(
            session, DashboardEventType.DOCUMENT_UPLOADED, f"document_id={row.id}"
        )
        await session.commit()
    else:
        # Reuse the existing row's own storage_key so an overwrite replaces
        # the same on-disk file in place, rather than minting a new key and
        # orphaning the old one.
        storage.save(existing.storage_key, data)
        row = (
            await session.execute(
                text(
                    f"UPDATE documents SET status = '{DocumentStatus.UPLOADED}' "
                    "WHERE id = :id "
                    "RETURNING id, filename, status, uploaded_at"
                ),
                {"id": existing.id},
            )
        ).one()
        await record_event_async(
            session, DashboardEventType.DOCUMENT_UPLOADED, f"document_id={row.id}"
        )
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
async def list_documents(session: AsyncSession = Depends(get_session)) -> list[DocumentSummary]:
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
        raise HTTPException(status_code=404, detail=_DOCUMENT_NOT_FOUND_ERROR)

    if row.status == DocumentStatus.CHUNKING:
        raise HTTPException(status_code=409, detail=_DOCUMENT_PROCESSING_ERROR)

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
        DashboardEventType.DOCUMENT_DELETED,
        f"document_id={document_id}, filename={row.filename}",
    )
    await session.commit()
