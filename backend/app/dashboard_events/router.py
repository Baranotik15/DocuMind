from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dashboard_events.schemas import DashboardEventSummary
from app.db.session import get_session

router = APIRouter()


def _event_summary(row) -> DashboardEventSummary:
    return DashboardEventSummary(
        id=str(row.id),
        type=row.type,
        timestamp=row.created_at.isoformat(),
        detail=row.detail,
        userEmail=row.user_email,
    )


@router.get("/dashboard/events")
async def get_dashboard_events(
    session: AsyncSession = Depends(get_session),
) -> list[DashboardEventSummary]:
    """Returns all dashboard_events as {id, type, timestamp, detail,
    userEmail}, ordered by created_at descending (newest first) - the
    opposite order from chat's list_messages endpoint, which is ascending.
    See `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 9.
    `userEmail` is nullable at the response-shape level, but every event
    type this app currently records populates it (see
    dashboard_events/recording.py's docstring)."""
    rows = (
        await session.execute(
            text(
                "SELECT id, type, detail, user_email, created_at FROM dashboard_events "
                "ORDER BY created_at DESC"
            )
        )
    ).all()
    return [_event_summary(row) for row in rows]
