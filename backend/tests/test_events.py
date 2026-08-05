import asyncio
import uuid

from sqlalchemy import text

from app.db.session import async_session_factory
from app.db.sync_session import SyncSessionLocal
from app.dashboard_events.recording import record_event_async, record_event_sync


def test_record_event_sync_insert_read_round_trip() -> None:
    detail = f"sync detail {uuid.uuid4()}"

    with SyncSessionLocal() as session:
        record_event_sync(session, "document.uploaded", detail)
        session.commit()

        row = session.execute(
            text(
                "SELECT type, detail, user_email FROM dashboard_events "
                "WHERE detail = :detail"
            ),
            {"detail": detail},
        ).one()

        assert row.type == "document.uploaded"
        assert row.detail == detail
        # user_email defaults to None when the caller omits it - this test
        # calls record_event_sync directly with no user_email given.
        assert row.user_email is None

        session.execute(
            text("DELETE FROM dashboard_events WHERE detail = :detail"),
            {"detail": detail},
        )
        session.commit()


def test_record_event_sync_persists_user_email_when_given() -> None:
    detail = f"sync detail with email {uuid.uuid4()}"
    user_email = "sync-event-user@example.com"

    with SyncSessionLocal() as session:
        record_event_sync(session, "document.uploaded", detail, user_email=user_email)
        session.commit()

        row = session.execute(
            text(
                "SELECT user_email FROM dashboard_events WHERE detail = :detail"
            ),
            {"detail": detail},
        ).one()

        assert row.user_email == user_email

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
                        "SELECT type, detail, user_email FROM dashboard_events "
                        "WHERE detail = :detail"
                    ),
                    {"detail": detail},
                )
            ).one()

            assert row.type == "chat.message_sent"
            assert row.detail == detail
            assert row.user_email is None

            await session.execute(
                text("DELETE FROM dashboard_events WHERE detail = :detail"),
                {"detail": detail},
            )
            await session.commit()

    asyncio.run(_run())


def test_record_event_async_persists_user_email_when_given() -> None:
    detail = f"async detail with email {uuid.uuid4()}"
    user_email = "async-event-user@example.com"

    async def _run() -> None:
        async with async_session_factory() as session:
            await record_event_async(
                session, "chat.message_sent", detail, user_email=user_email
            )
            await session.commit()

            row = (
                await session.execute(
                    text(
                        "SELECT user_email FROM dashboard_events WHERE detail = :detail"
                    ),
                    {"detail": detail},
                )
            ).one()

            assert row.user_email == user_email

            await session.execute(
                text("DELETE FROM dashboard_events WHERE detail = :detail"),
                {"detail": detail},
            )
            await session.commit()

    asyncio.run(_run())
