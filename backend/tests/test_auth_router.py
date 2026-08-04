import hashlib
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.auth.cli import create_user
from app.db.sync_session import SyncSessionLocal


def _unique_email() -> str:
    return f"auth-router-{uuid.uuid4()}@example.com"


def _cleanup(email: str) -> None:
    with SyncSessionLocal() as session:
        # ON DELETE CASCADE on sessions.user_id takes care of any session
        # row created by a successful login in these tests.
        session.execute(text("DELETE FROM users WHERE email = :email"), {"email": email})
        session.commit()


def _deactivate(email: str) -> None:
    with SyncSessionLocal() as session:
        session.execute(
            text("UPDATE users SET is_active = false WHERE email = :email"),
            {"email": email},
        )
        session.commit()


def _insert_expired_session(email: str) -> str:
    """Inserts a `sessions` row for `email` whose `expires_at` is already
    in the past, and returns the raw (unhashed) token for it - a session
    that require_session must reject the same way it rejects an unknown
    token, per its docstring."""
    raw_token = f"expired-token-{uuid.uuid4()}"
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    with SyncSessionLocal() as session:
        user_id = session.execute(
            text("SELECT id FROM users WHERE email = :email"), {"email": email}
        ).scalar_one()
        session.execute(
            text(
                "INSERT INTO sessions (token_hash, user_id, expires_at) "
                "VALUES (:token_hash, :user_id, now() - interval '1 hour')"
            ),
            {"token_hash": token_hash, "user_id": user_id},
        )
        session.commit()
    return raw_token


def _session_row_for_user(email: str):
    with SyncSessionLocal() as session:
        return session.execute(
            text(
                "SELECT s.token_hash, s.user_id, s.expires_at, u.id AS expected_user_id "
                "FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE u.email = :email"
            ),
            {"email": email},
        ).one_or_none()


def test_login_correct_credentials_returns_200_sets_cookie_and_creates_session_row(
    client: TestClient,
) -> None:
    email = _unique_email()
    password = "correct horse battery staple"
    try:
        create_user(email, password)

        response = client.post(
            "/internal/auth/login", json={"email": email, "password": password}
        )

        assert response.status_code == 200
        assert response.json() == {"email": email}

        raw_token = response.cookies.get("session")
        assert raw_token is not None

        row = _session_row_for_user(email)
        assert row is not None
        assert str(row.user_id) == str(row.expected_user_id)
        assert row.expires_at is not None

        # The stored token_hash must be sha256(raw_token), never the raw
        # token itself.
        assert row.token_hash == hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        assert row.token_hash != raw_token
    finally:
        _cleanup(email)


def test_login_wrong_password_returns_401_invalid_credentials(client: TestClient) -> None:
    email = _unique_email()
    try:
        create_user(email, "the-real-password")

        response = client.post(
            "/internal/auth/login", json={"email": email, "password": "wrong-password"}
        )

        assert response.status_code == 401
        assert response.json() == {"detail": "invalid_credentials"}
        assert "session" not in response.cookies
    finally:
        _cleanup(email)


def test_login_unknown_email_returns_401_invalid_credentials(client: TestClient) -> None:
    email = _unique_email()

    response = client.post(
        "/internal/auth/login", json={"email": email, "password": "does-not-matter"}
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "invalid_credentials"}
    assert "session" not in response.cookies


def test_login_deactivated_user_with_correct_password_returns_401_invalid_credentials(
    client: TestClient,
) -> None:
    email = _unique_email()
    password = "correct horse battery staple"
    try:
        create_user(email, password)
        _deactivate(email)

        response = client.post(
            "/internal/auth/login", json={"email": email, "password": password}
        )

        assert response.status_code == 401
        assert response.json() == {"detail": "invalid_credentials"}
        assert "session" not in response.cookies
    finally:
        _cleanup(email)


def test_logout_with_valid_session_cookie_returns_204_and_deletes_session_row(
    client: TestClient,
) -> None:
    email = _unique_email()
    password = "correct horse battery staple"
    try:
        create_user(email, password)

        login_response = client.post(
            "/internal/auth/login", json={"email": email, "password": password}
        )
        assert login_response.status_code == 200
        raw_token = login_response.cookies.get("session")
        assert raw_token is not None

        # TestClient persists cookies across requests on the same instance,
        # so this logout call automatically sends the cookie set above.
        logout_response = client.post("/internal/auth/logout")

        assert logout_response.status_code == 204
        assert not logout_response.content

        row = _session_row_for_user(email)
        assert row is None

        # The cookie must actually be cleared on the response, not just
        # left as-is.
        assert client.cookies.get("session") is None
    finally:
        _cleanup(email)


def test_logout_with_no_cookie_returns_204_without_error(client: TestClient) -> None:
    response = client.post("/internal/auth/logout")

    assert response.status_code == 204
    assert not response.content


def test_logout_with_bogus_cookie_returns_204_without_error(client: TestClient) -> None:
    # Sent as a raw Cookie header (rather than client.cookies.set(...) or
    # the request-level cookies= kwarg) to sidestep httpx's cookie-jar
    # domain matching entirely and its cookies= deprecation warning - this
    # is just "a request arrives with a session cookie no session row
    # matches".
    response = client.post(
        "/internal/auth/logout",
        headers={"Cookie": "session=this-token-does-not-exist"},
    )

    assert response.status_code == 204
    assert not response.content

    # The response must still clear the cookie even though nothing was
    # deleted server-side.
    set_cookie_header = response.headers.get("set-cookie", "")
    assert "Max-Age=0" in set_cookie_header


def test_me_with_valid_session_cookie_returns_200_and_email(client: TestClient) -> None:
    email = _unique_email()
    password = "correct horse battery staple"
    try:
        create_user(email, password)
        login_response = client.post(
            "/internal/auth/login", json={"email": email, "password": password}
        )
        assert login_response.status_code == 200

        response = client.get("/internal/auth/me")

        assert response.status_code == 200
        assert response.json() == {"email": email}
    finally:
        _cleanup(email)


def test_me_with_no_cookie_returns_401(client: TestClient) -> None:
    response = client.get("/internal/auth/me")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


def test_me_with_bogus_cookie_returns_401(client: TestClient) -> None:
    # Same raw-Cookie-header technique test_logout_with_bogus_cookie_...
    # uses above, to sidestep httpx's cookie-jar domain matching.
    response = client.get(
        "/internal/auth/me",
        headers={"Cookie": "session=this-token-does-not-exist"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}


def test_me_with_expired_session_cookie_returns_401(client: TestClient) -> None:
    email = _unique_email()
    try:
        create_user(email, "correct horse battery staple")
        raw_token = _insert_expired_session(email)

        response = client.get(
            "/internal/auth/me", headers={"Cookie": f"session={raw_token}"}
        )

        assert response.status_code == 401
        assert response.json() == {"detail": "not_authenticated"}
    finally:
        _cleanup(email)


def test_me_with_deactivated_user_session_returns_401(client: TestClient) -> None:
    email = _unique_email()
    password = "correct horse battery staple"
    try:
        create_user(email, password)
        login_response = client.post(
            "/internal/auth/login", json={"email": email, "password": password}
        )
        assert login_response.status_code == 200

        # The session row created by login above is still valid - only the
        # user is deactivated after the fact (e.g. via `revoke_user`
        # elsewhere), so this proves require_session checks is_active
        # itself rather than trusting an already-issued session forever.
        _deactivate(email)

        response = client.get("/internal/auth/me")

        assert response.status_code == 401
        assert response.json() == {"detail": "not_authenticated"}
    finally:
        _cleanup(email)
