from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session


def record_event_sync(session: Session, event_type: str, detail: str) -> None:
    """INSERTs one row into dashboard_events. Does not commit - caller
    controls the transaction boundary."""
    session.execute(
        text("INSERT INTO dashboard_events (type, detail) VALUES (:type, :detail)"),
        {"type": event_type, "detail": detail},
    )


async def record_event_async(session: AsyncSession, event_type: str, detail: str) -> None:
    """Async counterpart, same contract, for FastAPI endpoints."""
    await session.execute(
        text("INSERT INTO dashboard_events (type, detail) VALUES (:type, :detail)"),
        {"type": event_type, "detail": detail},
    )
