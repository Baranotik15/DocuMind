import asyncio
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.analysis.schemas import AnalysisConflict, AnalysisReportDetail, AnalysisReportSummary
from app.analysis.tasks import run_documentation_analysis
from app.auth.dependencies import require_session
from app.db.session import get_session

router = APIRouter()

_ANALYSIS_REPORT_NOT_FOUND_ERROR = "analysis_report_not_found"

_SUMMARY_COLUMNS = "id, status, started_at, completed_at, started_by_email"
_DETAIL_COLUMNS = (
    f"{_SUMMARY_COLUMNS}, gap_analysis, conflicts, total_tokens, error_detail"
)


def _report_summary(row) -> AnalysisReportSummary:
    return AnalysisReportSummary(
        id=str(row.id),
        status=row.status,
        startedAt=row.started_at.isoformat(),
        completedAt=row.completed_at.isoformat() if row.completed_at is not None else None,
        startedByEmail=row.started_by_email,
    )


def _report_detail(row) -> AnalysisReportDetail:
    return AnalysisReportDetail(
        **_report_summary(row).model_dump(),
        gapAnalysis=row.gap_analysis,
        # `row.conflicts` is already a native Python list of dicts (the
        # asyncpg driver deserializes jsonb columns automatically) - None
        # only while the run is still 'running' (see the 0008 migration's
        # column comment), never an empty-but-unparsed string.
        conflicts=(
            [AnalysisConflict(**conflict) for conflict in row.conflicts]
            if row.conflicts is not None
            else None
        ),
        totalTokens=row.total_tokens,
        errorDetail=row.error_detail,
    )


@router.post("/analysis/reports", status_code=201)
async def start_analysis_run(
    user_email: str = Depends(require_session), session: AsyncSession = Depends(get_session)
) -> AnalysisReportSummary:
    """INSERTs a new analysis_reports row (status='running',
    started_by_email=user_email), commits, then dispatches
    run_documentation_analysis.delay(str(row.id)) via asyncio.to_thread -
    same eager-mode-safe pattern documents/router.py's upload_document
    already uses (see its own comment: .delay() itself is a plain
    synchronous call, and - under the test suite's Celery eager mode -
    asyncio.run() inside run_full_analysis can't be called from a thread
    that already has a running event loop, which this request-handling
    coroutine's thread does, hence asyncio.to_thread rather than a direct/
    awaited call). Returns immediately with status='running' - the
    frontend polls GET /analysis/reports/{id} (or re-fetches the list)
    until it isn't."""
    row = (
        await session.execute(
            text(
                "INSERT INTO analysis_reports (status, started_by_email) "
                f"VALUES (:status, :started_by_email) RETURNING {_SUMMARY_COLUMNS}"
            ),
            {"status": "running", "started_by_email": user_email},
        )
    ).one()
    await session.commit()

    await asyncio.to_thread(run_documentation_analysis.delay, str(row.id))

    return _report_summary(row)


@router.get("/analysis/reports")
async def list_analysis_reports(
    session: AsyncSession = Depends(get_session),
) -> list[AnalysisReportSummary]:
    """Every analysis_reports row, newest started_at first - powers the
    Analysis sub-tab's history sidebar."""
    rows = (
        await session.execute(
            text(f"SELECT {_SUMMARY_COLUMNS} FROM analysis_reports ORDER BY started_at DESC")
        )
    ).all()
    return [_report_summary(row) for row in rows]


@router.get("/analysis/reports/{report_id}")
async def get_analysis_report(
    report_id: UUID, session: AsyncSession = Depends(get_session)
) -> AnalysisReportDetail:
    """One report's full detail. 404 if report_id doesn't exist.

    `report_id` is typed as UUID (not str) so a malformed id 422s via
    FastAPI's own path-param validation before ever reaching the DB, same
    convention as documents/router.py's delete_document."""
    row = (
        await session.execute(
            text(f"SELECT {_DETAIL_COLUMNS} FROM analysis_reports WHERE id = :report_id"),
            {"report_id": str(report_id)},
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=_ANALYSIS_REPORT_NOT_FOUND_ERROR)
    return _report_detail(row)


@router.delete("/analysis/reports/{report_id}", status_code=204)
async def delete_analysis_report(
    report_id: UUID, session: AsyncSession = Depends(get_session)
) -> None:
    """Permanently deletes one analysis_reports row. 404 if report_id
    doesn't exist.

    No busy-guard on status == 'running', unlike documents/router.py's
    delete_document (which blocks while status == 'chunking'): a report
    mid-run has nothing else writing to related tables that deleting it
    would corrupt - the Celery task's own later UPDATE on a since-deleted
    row is just a harmless no-op.

    `report_id` is typed as UUID (not str) so a malformed id 422s via
    FastAPI's own path-param validation before ever reaching the DB, same
    convention as get_analysis_report/delete_document."""
    row = (
        await session.execute(
            text("DELETE FROM analysis_reports WHERE id = :report_id RETURNING id"),
            {"report_id": str(report_id)},
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=_ANALYSIS_REPORT_NOT_FOUND_ERROR)
    await session.commit()
