from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session


def record_event_sync(
    session: Session, event_type: str, detail: str, user_email: str | None = None
) -> None:
    """INSERTs one row into dashboard_events. Does not commit - caller
    controls the transaction boundary. `user_email` stays NULL only for
    events whose caller genuinely has none to give - there currently is no
    such caller in this app; even documents/pipeline.py's call sites run
    inside a Celery worker task, but every pipeline run traces back 1:1 to
    an authenticated HTTP request (upload or Save), so `user_email` is
    threaded all the way down from the originating `require_session` call.
    Callers inside an authenticated FastAPI endpoint (or anything that
    itself received a `user_email` from one) should pass that email
    through."""
    session.execute(
        text(
            "INSERT INTO dashboard_events (type, detail, user_email) "
            "VALUES (:type, :detail, :user_email)"
        ),
        {"type": event_type, "detail": detail, "user_email": user_email},
    )


async def record_event_async(
    session: AsyncSession, event_type: str, detail: str, user_email: str | None = None
) -> None:
    """Async counterpart, same contract, for FastAPI endpoints."""
    await session.execute(
        text(
            "INSERT INTO dashboard_events (type, detail, user_email) "
            "VALUES (:type, :detail, :user_email)"
        ),
        {"type": event_type, "detail": detail, "user_email": user_email},
    )
