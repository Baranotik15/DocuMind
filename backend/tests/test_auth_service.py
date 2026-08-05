import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.auth.service import UserNotFoundError, create_user, revoke_user
from app.db.sync_session import SyncSessionLocal


def _unique_email() -> str:
    return f"auth-service-{uuid.uuid4()}@example.com"


def _user_row(session, email: str):
    return session.execute(
        text("SELECT id, password_hash, is_active FROM users WHERE email = :email"),
        {"email": email},
    ).one()


def _insert_session(session, user_id) -> str:
    session_id = session.execute(
        text(
            "INSERT INTO sessions (token_hash, user_id, expires_at) "
            "VALUES (:token_hash, :user_id, now() + interval '1 day') "
            "RETURNING id"
        ),
        {"token_hash": f"token-{uuid.uuid4()}", "user_id": user_id},
    ).scalar_one()
    session.commit()
    return str(session_id)


def _cleanup(email: str) -> None:
    with SyncSessionLocal() as session:
        # ON DELETE CASCADE on sessions.user_id takes care of any leftover
        # session rows for this user.
        session.execute(text("DELETE FROM users WHERE email = :email"), {"email": email})
        session.commit()


def test_create_user_stores_bcrypt_hash_not_plaintext() -> None:
    email = _unique_email()
    password = "correct horse battery staple"

    try:
        user_id = create_user(email, password)
        assert user_id

        with SyncSessionLocal() as session:
            row = _user_row(session, email)
            assert row.password_hash != password
            assert row.password_hash.startswith("$2b$")
            assert row.is_active is True
    finally:
        _cleanup(email)


def test_create_user_duplicate_email_raises_integrity_error() -> None:
    email = _unique_email()

    try:
        create_user(email, "first-password")

        with pytest.raises(IntegrityError):
            create_user(email, "second-password")
    finally:
        _cleanup(email)


def test_revoke_user_sets_is_active_false() -> None:
    email = _unique_email()

    try:
        create_user(email, "some-password")

        message = revoke_user(email)
        assert message == f"revoked {email}"

        with SyncSessionLocal() as session:
            row = _user_row(session, email)
            assert row.is_active is False
    finally:
        _cleanup(email)


def test_revoke_user_deletes_that_users_sessions() -> None:
    email = _unique_email()

    try:
        user_id = create_user(email, "some-password")
        with SyncSessionLocal() as session:
            session_id = _insert_session(session, user_id)

        revoke_user(email)

        with SyncSessionLocal() as session:
            remaining = session.execute(
                text("SELECT COUNT(*) FROM sessions WHERE id = :id"),
                {"id": session_id},
            ).scalar_one()
            assert remaining == 0
    finally:
        _cleanup(email)


def test_revoke_user_already_revoked_is_idempotent() -> None:
    email = _unique_email()

    try:
        create_user(email, "some-password")

        first = revoke_user(email)
        assert first == f"revoked {email}"

        second = revoke_user(email)
        assert second == f"user {email} is already revoked"

        with SyncSessionLocal() as session:
            row = _user_row(session, email)
            assert row.is_active is False
    finally:
        _cleanup(email)


def test_revoke_user_nonexistent_email_raises_user_not_found_error() -> None:
    email = _unique_email()

    with pytest.raises(UserNotFoundError):
        revoke_user(email)
