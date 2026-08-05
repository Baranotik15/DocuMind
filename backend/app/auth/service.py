"""Pure user-provisioning logic behind the CLI (see cli.py) - no terminal
I/O, no Unix-only imports, so this stays importable on any platform (e.g.
by conftest.py's test fixtures) without dragging in termios/tty just to
reuse create_user/revoke_user."""
from sqlalchemy import text

from app.auth.hashing import hash_password
from app.db.sync_session import SyncSessionLocal


class UserNotFoundError(Exception):
    pass


def create_user(email: str, password: str) -> str:
    """Hashes `password` and inserts a new `users` row. Returns the new
    user's id as a str. Raises sqlalchemy.exc.IntegrityError, uncaught, if
    `email` is already taken (the unique constraint on users.email) -
    cli.py's entrypoint is what turns that into a clean one-line error."""
    password_hash = hash_password(password)
    with SyncSessionLocal() as session:
        user_id = session.execute(
            text(
                "INSERT INTO users (email, password_hash) "
                "VALUES (:email, :password_hash) RETURNING id"
            ),
            {"email": email, "password_hash": password_hash},
        ).scalar_one()
        session.commit()
        return str(user_id)


def revoke_user(email: str) -> str:
    """Soft-deactivates the user with the given email (`is_active = false`)
    and, in the same transaction, deletes every `sessions` row for that
    user - killing any active session immediately rather than waiting for
    its TTL. Idempotent: revoking an already-inactive user is a clean
    no-op, not an error. Returns a short human-readable status message.
    Raises UserNotFoundError, uncaught, if no user has this email."""
    with SyncSessionLocal() as session:
        row = session.execute(
            text("SELECT id, is_active FROM users WHERE email = :email"),
            {"email": email},
        ).one_or_none()
        if row is None:
            raise UserNotFoundError(email)

        if not row.is_active:
            return f"user {email} is already revoked"

        session.execute(
            text("UPDATE users SET is_active = false WHERE id = :id"),
            {"id": row.id},
        )
        session.execute(
            text("DELETE FROM sessions WHERE user_id = :id"),
            {"id": row.id},
        )
        session.commit()
        return f"revoked {email}"
