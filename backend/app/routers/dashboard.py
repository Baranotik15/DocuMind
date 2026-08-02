from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session

router = APIRouter()


def _event_summary(row) -> dict:
    return {
        "id": str(row.id),
        "type": row.type,
        "timestamp": row.created_at.isoformat(),
        "detail": row.detail,
    }


@router.get("/dashboard/events")
async def get_dashboard_events(session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns all dashboard_events as {id, type, timestamp, detail},
    ordered by created_at descending (newest first) - the opposite order
    from chat's list_messages endpoint, which is ascending. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 9."""
    rows = (
        await session.execute(
            text(
                "SELECT id, type, detail, created_at FROM dashboard_events "
                "ORDER BY created_at DESC"
            )
        )
    ).all()
    return [_event_summary(row) for row in rows]
