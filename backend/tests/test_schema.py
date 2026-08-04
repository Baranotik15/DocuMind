import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.db.sync_session import SyncSessionLocal

# column_name -> (expected data_type or udt_name for USER-DEFINED types, is_nullable)
EXPECTED_COLUMNS: dict[str, dict[str, tuple[str, str]]] = {
    "documents": {
        "id": ("uuid", "NO"),
        "filename": ("text", "NO"),
        "storage_key": ("text", "NO"),
        "status": ("text", "NO"),
        "uploaded_at": ("timestamp with time zone", "NO"),
    },
    "chunks": {
        "id": ("uuid", "NO"),
        "document_id": ("uuid", "NO"),
        "position": ("integer", "NO"),
        "original_content": ("text", "NO"),
        "edited_content": ("text", "NO"),
        "embedding": ("vector", "NO"),
    },
    "chat_messages": {
        "id": ("uuid", "NO"),
        "role": ("text", "NO"),
        "content": ("text", "NO"),
        "disliked": ("boolean", "NO"),
        "created_at": ("timestamp with time zone", "NO"),
    },
    "dashboard_events": {
        "id": ("uuid", "NO"),
        "type": ("text", "NO"),
        "detail": ("text", "NO"),
        "created_at": ("timestamp with time zone", "NO"),
    },
}

ZERO_VECTOR_1536 = "[" + ",".join(["0"] * 1536) + "]"


def _actual_columns(session, table_name: str) -> dict[str, tuple[str, str]]:
    result = session.execute(
        text(
            "SELECT column_name, data_type, udt_name, is_nullable "
            "FROM information_schema.columns WHERE table_name = :table_name"
        ),
        {"table_name": table_name},
    )
    columns = {}
    for row in result:
        data_type = row.udt_name if row.data_type == "USER-DEFINED" else row.data_type
        columns[row.column_name] = (data_type, row.is_nullable)
    return columns


@pytest.mark.parametrize("table_name", list(EXPECTED_COLUMNS.keys()))
def test_table_has_expected_columns(table_name: str) -> None:
    with SyncSessionLocal() as session:
        actual = _actual_columns(session, table_name)
        assert actual, f"table {table_name!r} does not exist"

        for column_name, expected in EXPECTED_COLUMNS[table_name].items():
            assert column_name in actual, f"{table_name}.{column_name} is missing"
            assert actual[column_name] == expected, (
                f"{table_name}.{column_name}: expected {expected}, got {actual[column_name]}"
            )


def test_duplicate_filename_raises_integrity_error() -> None:
    filename = f"dup-{uuid.uuid4()}.txt"

    with SyncSessionLocal() as session:
        session.execute(
            text(
                "INSERT INTO documents (filename, storage_key) "
                "VALUES (:filename, :storage_key)"
            ),
            {"filename": filename, "storage_key": f"docs/{filename}"},
        )
        session.commit()

        try:
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO documents (filename, storage_key) "
                        "VALUES (:filename, :storage_key)"
                    ),
                    {"filename": filename, "storage_key": f"docs/other-{filename}"},
                )
                session.commit()
        finally:
            session.rollback()
            session.execute(
                text("DELETE FROM documents WHERE filename = :filename"),
                {"filename": filename},
            )
            session.commit()


def test_duplicate_document_position_raises_integrity_error() -> None:
    filename = f"positions-{uuid.uuid4()}.txt"

    with SyncSessionLocal() as session:
        document_id = session.execute(
            text(
                "INSERT INTO documents (filename, storage_key) "
                "VALUES (:filename, :storage_key) RETURNING id"
            ),
            {"filename": filename, "storage_key": f"docs/{filename}"},
        ).scalar_one()
        session.commit()

        try:
            session.execute(
                text(
                    "INSERT INTO chunks "
                    "(document_id, position, original_content, edited_content, embedding) "
                    "VALUES (:document_id, :position, :content, :content, :embedding ::vector)"
                ),
                {
                    "document_id": document_id,
                    "position": 0,
                    "content": "first chunk",
                    "embedding": ZERO_VECTOR_1536,
                },
            )
            session.commit()

            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO chunks "
                        "(document_id, position, original_content, edited_content, embedding) "
                        "VALUES (:document_id, :position, :content, :content, :embedding ::vector)"
                    ),
                    {
                        "document_id": document_id,
                        "position": 0,
                        "content": "duplicate position chunk",
                        "embedding": ZERO_VECTOR_1536,
                    },
                )
                session.commit()
        finally:
            session.rollback()
            session.execute(
                text("DELETE FROM documents WHERE id = :document_id"),
                {"document_id": document_id},
            )
            session.commit()


def test_chunk_cascades_on_document_delete() -> None:
    filename = f"cascade-{uuid.uuid4()}.txt"

    with SyncSessionLocal() as session:
        document_id = session.execute(
            text(
                "INSERT INTO documents (filename, storage_key) "
                "VALUES (:filename, :storage_key) RETURNING id"
            ),
            {"filename": filename, "storage_key": f"docs/{filename}"},
        ).scalar_one()
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, 0, 'chunk', 'chunk', :embedding ::vector)"
            ),
            {"document_id": document_id, "embedding": ZERO_VECTOR_1536},
        )
        session.commit()

        session.execute(
            text("DELETE FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        )
        session.commit()

        remaining = session.execute(
            text("SELECT COUNT(*) FROM chunks WHERE document_id = :document_id"),
            {"document_id": document_id},
        ).scalar_one()
        assert remaining == 0


def test_chat_message_and_dashboard_event_round_trip() -> None:
    with SyncSessionLocal() as session:
        message_id = session.execute(
            text(
                "INSERT INTO chat_messages (role, content) "
                "VALUES ('user', 'hello') RETURNING id"
            )
        ).scalar_one()
        session.commit()

        row = session.execute(
            text("SELECT role, content, disliked FROM chat_messages WHERE id = :id"),
            {"id": message_id},
        ).one()
        assert row.role == "user"
        assert row.content == "hello"
        assert row.disliked is False

        event_id = session.execute(
            text(
                "INSERT INTO dashboard_events (type, detail) "
                "VALUES ('document.uploaded', 'test detail') RETURNING id"
            )
        ).scalar_one()
        session.commit()

        event_row = session.execute(
            text("SELECT type, detail FROM dashboard_events WHERE id = :id"),
            {"id": event_id},
        ).one()
        assert event_row.type == "document.uploaded"
        assert event_row.detail == "test detail"

        session.execute(text("DELETE FROM chat_messages WHERE id = :id"), {"id": message_id})
        session.execute(text("DELETE FROM dashboard_events WHERE id = :id"), {"id": event_id})
        session.commit()
