import asyncio
import uuid

from sqlalchemy import text

from app.db.session import async_session_factory
from app.db.sync_session import SyncSessionLocal
from app.services.events import record_event_async, record_event_sync


def test_record_event_sync_insert_read_round_trip() -> None:
    detail = f"sync detail {uuid.uuid4()}"

    with SyncSessionLocal() as session:
        record_event_sync(session, "document.uploaded", detail)
        session.commit()

        row = session.execute(
            text(
                "SELECT type, detail FROM dashboard_events "
                "WHERE detail = :detail"
            ),
            {"detail": detail},
        ).one()

        assert row.type == "document.uploaded"
        assert row.detail == detail

        session.execute(
            text("DELETE FROM dashboard_events WHERE detail = :detail"),
            {"detail": detail},
        )
        session.commit()


def test_record_event_sync_does_not_commit() -> None:
    detail = f"sync-no-commit {uuid.uuid4()}"

    with SyncSessionLocal() as session:
        record_event_sync(session, "document.uploaded", detail)
        session.rollback()

    with SyncSessionLocal() as verify_session:
        row = verify_session.execute(
            text("SELECT COUNT(*) FROM dashboard_events WHERE detail = :detail"),
            {"detail": detail},
        ).scalar_one()
        assert row == 0


def test_record_event_async_insert_read_round_trip() -> None:
    detail = f"async detail {uuid.uuid4()}"

    async def _run() -> None:
        async with async_session_factory() as session:
            await record_event_async(session, "chat.message_sent", detail)
            await session.commit()

            row = (
                await session.execute(
                    text(
                        "SELECT type, detail FROM dashboard_events "
                        "WHERE detail = :detail"
                    ),
                    {"detail": detail},
                )
            ).one()

            assert row.type == "chat.message_sent"
            assert row.detail == detail

            await session.execute(
                text("DELETE FROM dashboard_events WHERE detail = :detail"),
                {"detail": detail},
            )
            await session.commit()

    asyncio.run(_run())
