"""Admin-user management for the (small, closed) admin panel.

There is no HTTP path for creating or revoking a user - both are reachable
only by running this script inside the backend container, e.g.:

    docker compose exec backend python -m app.auth.cli create-user \
        --email admin@example.com --password <password>
    docker compose exec backend python -m app.auth.cli revoke-user \
        --email admin@example.com
"""
import argparse
import sys

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.auth.hashing import hash_password
from app.db.sync_session import SyncSessionLocal


class UserNotFoundError(Exception):
    pass


def create_user(email: str, password: str) -> str:
    """Hashes `password` and inserts a new `users` row. Returns the new
    user's id as a str. Raises sqlalchemy.exc.IntegrityError, uncaught, if
    `email` is already taken (the unique constraint on users.email) - the
    CLI entrypoint below is what turns that into a clean one-line error."""
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


def _cmd_create_user(args: argparse.Namespace) -> int:
    try:
        user_id = create_user(args.email, args.password)
    except IntegrityError:
        print(f"error: a user with email {args.email!r} already exists", file=sys.stderr)
        return 1
    print(f"created user {args.email} (id={user_id})")
    return 0


def _cmd_revoke_user(args: argparse.Namespace) -> int:
    try:
        message = revoke_user(args.email)
    except UserNotFoundError:
        print(f"error: no user with email {args.email!r}", file=sys.stderr)
        return 1
    print(message)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.auth.cli",
        description=(
            "Create or revoke admin-panel users. Closed off from any HTTP "
            "path on purpose - this script is the only way to do either."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_parser = subparsers.add_parser("create-user", help="Create a new admin user")
    create_parser.add_argument("--email", required=True)
    create_parser.add_argument("--password", required=True)
    create_parser.set_defaults(func=_cmd_create_user)

    revoke_parser = subparsers.add_parser(
        "revoke-user", help="Deactivate a user and kill their active sessions"
    )
    revoke_parser.add_argument("--email", required=True)
    revoke_parser.set_defaults(func=_cmd_revoke_user)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
