import asyncio
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import require_session
from app.config import get_settings
from app.dashboard_events.constants import DashboardEventType
from app.dashboard_events.recording import record_event_async
from app.db.session import get_session
from app.documents.constants import (
    DOCUMENT_NOT_FOUND_ERROR,
    DOCUMENT_PROCESSING_ERROR,
    DocumentStatus,
    SUPPORTED_DOCUMENT_EXTENSIONS,
)
from app.documents.deps import get_storage
from app.documents.formatting import build_document_event_detail
from app.documents.schemas import DocumentSummary
from app.documents.storage import StorageAdapter, StorageKeyNotFoundError
from app.documents.tasks import run_document_pipeline

router = APIRouter()

# Detail code unique to this router (DOCUMENT_PROCESSING_ERROR and
# DOCUMENT_NOT_FOUND_ERROR - shared with chunks/router.py's sibling
# endpoints - now live in app/documents/constants.py instead of being
# copy-pasted per file; see also app/dashboard_events/constants.py for
# DashboardEventType, which this router also uses).
_FILE_TOO_LARGE_ERROR = "file_too_large"

# Read in bounded chunks rather than a single file.read() - the client's
# stated Content-Length can't be trusted, so the only reliable cap is one
# enforced while streaming the body in, aborting as soon as the running
# total crosses the configured limit instead of buffering an oversized
# upload in full before rejecting it.
_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024


async def _read_upload_within_limit(file: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_UPLOAD_READ_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=_FILE_TOO_LARGE_ERROR)
        chunks.append(chunk)
    return b"".join(chunks)


def _document_summary(row) -> DocumentSummary:
    return DocumentSummary(
        id=str(row.id),
        filename=row.filename,
        status=row.status,
        fileSizeBytes=row.file_size_bytes,
        uploadedAt=row.uploaded_at.isoformat(),
    )


@router.post("/documents")
async def upload_document(
    file: UploadFile,
    overwrite: bool = Form(False),
    session: AsyncSession = Depends(get_session),
    storage: StorageAdapter = Depends(get_storage),
    user_email: str = Depends(require_session),
) -> DocumentSummary:
    """Validates the filename's extension before touching storage/DB, then
    branches on whether a document with this filename already exists. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 6 for the
    full contract."""
    filename = file.filename or ""
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_DOCUMENT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="unsupported_file_type")

    data = await _read_upload_within_limit(file, get_settings().max_upload_size_bytes)
    file_size = len(data)

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
        raise HTTPException(status_code=409, detail=DOCUMENT_PROCESSING_ERROR)

    if existing is not None and not overwrite:
        raise HTTPException(status_code=409, detail="duplicate_filename")

    if existing is None:
        # Storage key is generated server-side (UUID + the already-validated
        # extension), never derived from the client-supplied filename - a
        # filename like "../../../etc/cron.d/x.txt" must not be able to
        # steer where on disk this gets written. `filename` itself is kept
        # only as display/lookup metadata in the `documents` row.
        storage_key = f"docs/{uuid4()}{extension}"
        try:
            row = (
                await session.execute(
                    text(
                        "INSERT INTO documents (filename, storage_key, status, file_size_bytes) "
                        "VALUES (:filename, :storage_key, :status, :file_size_bytes) "
                        "RETURNING id, filename, status, uploaded_at, file_size_bytes"
                    ),
                    {
                        "filename": filename,
                        "storage_key": storage_key,
                        "status": str(DocumentStatus.UPLOADED),
                        "file_size_bytes": file_size,
                    },
                )
            ).one()
        except IntegrityError:
            # Lost a race against a concurrent upload of the same brand-new
            # filename between the SELECT above and this INSERT - the
            # unique constraint on documents.filename is what actually
            # prevents the duplicate row; this just turns the resulting
            # constraint violation into the same 409 a sequential second
            # upload would get, instead of a raw 500.
            await session.rollback()
            raise HTTPException(status_code=409, detail="duplicate_filename")
        storage.save(storage_key, data)
    else:
        # Reuse the existing row's own storage_key so an overwrite replaces
        # the same on-disk file in place, rather than minting a new key and
        # orphaning the old one.
        storage.save(existing.storage_key, data)
        row = (
            await session.execute(
                text(
                    "UPDATE documents SET status = :status, file_size_bytes = :file_size_bytes "
                    "WHERE id = :id "
                    "RETURNING id, filename, status, uploaded_at, file_size_bytes"
                ),
                {
                    "status": str(DocumentStatus.UPLOADED),
                    "file_size_bytes": file_size,
                    "id": existing.id,
                },
            )
        ).one()

    # Both branches above reach here with the same row shape - one shared
    # event/commit instead of a copy in each branch (the previous shape of
    # this function duplicated this exact call site by branch).
    await record_event_async(
        session,
        DashboardEventType.DOCUMENT_UPLOADED,
        build_document_event_detail(filename, file_size),
        user_email=user_email,
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
    await asyncio.to_thread(
        run_document_pipeline.delay, str(row.id), user_email=user_email
    )

    return _document_summary(row)


@router.get("/documents")
async def list_documents(session: AsyncSession = Depends(get_session)) -> list[DocumentSummary]:
    """Returns every document as a DocumentSummary dict, ordered by
    uploaded_at."""
    rows = (
        await session.execute(
            text(
                "SELECT id, filename, status, uploaded_at, file_size_bytes FROM documents "
                "ORDER BY uploaded_at"
            )
        )
    ).all()
    return [_document_summary(row) for row in rows]


@router.delete("/documents/{document_id}", status_code=204)
async def delete_document(
    document_id: UUID,
    session: AsyncSession = Depends(get_session),
    storage: StorageAdapter = Depends(get_storage),
    user_email: str = Depends(require_session),
) -> None:
    """Deletes a document's stored file and its `documents` row. Its
    `chunks` rows are removed automatically by Postgres via the
    `chunks.document_id REFERENCES documents(id) ON DELETE CASCADE` FK
    from the 0003 migration - not deleted explicitly here.

    Blocked (409) while a pipeline run is actively writing to the
    document (status == 'chunking'), mirroring the same busy-guard
    reasoning used for Save/overwrite elsewhere in this router.

    `document_id` is typed as UUID (not str) so a malformed id 422s via
    FastAPI's own path-param validation before ever reaching the DB -
    passing a non-UUID string straight into the raw SQL below would
    otherwise fail as an unhandled Postgres error (500) instead of a
    clean 404/422."""
    row = (
        await session.execute(
            text(
                "SELECT filename, storage_key, status, file_size_bytes FROM documents "
                "WHERE id = :document_id"
            ),
            {"document_id": str(document_id)},
        )
    ).one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND_ERROR)

    if row.status == DocumentStatus.CHUNKING:
        raise HTTPException(status_code=409, detail=DOCUMENT_PROCESSING_ERROR)

    try:
        storage.delete(row.storage_key)
    except StorageKeyNotFoundError:
        # The file is already missing from disk (e.g. manually removed, or
        # an orphaned row from some prior partial failure) - don't let that
        # block cleaning up the DB row.
        pass

    await session.execute(
        text("DELETE FROM documents WHERE id = :document_id"),
        {"document_id": str(document_id)},
    )
    await record_event_async(
        session,
        DashboardEventType.DOCUMENT_DELETED,
        build_document_event_detail(row.filename, row.file_size_bytes),
        user_email=user_email,
    )
    await session.commit()
