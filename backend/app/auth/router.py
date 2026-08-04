import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.auth.constants import SESSION_COOKIE_NAME
from app.auth.dependencies import require_session
from app.auth.hashing import hash_password, verify_password
from app.auth.schemas import LoginRequest, LoginResponse
from app.config import get_settings
from app.db.session import get_session

router = APIRouter()

_INVALID_CREDENTIALS_ERROR = "invalid_credentials"

# Computed once at import time (not a real user's hash) so an unknown-email
# or deactivated-user login still pays the same ~100ms bcrypt cost as a
# genuine wrong-password check below - closes the timing side-channel that
# would otherwise let a caller distinguish "no such email"/"deactivated"
# from "wrong password" purely by response latency.
_DUMMY_PASSWORD_HASH = hash_password("dummy-password-for-timing-comparison")


@router.post("/auth/login")
async def login(
    body: LoginRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> LoginResponse:
    """Looks up `body.email`, verifies `body.password` against its bcrypt
    hash, and - on success - creates a `sessions` row and sets the
    `session` cookie to the raw token (only its sha256 digest is stored).

    Unknown email, wrong password, and a correctly-authenticated but
    `is_active = false` user all return the exact same 401
    `invalid_credentials` body - never revealing which part was wrong or
    whether the account exists/is deactivated (see .claude/specs/auth.md's
    acceptance criteria). bcrypt.checkpw (inside verify_password) is a
    deliberately slow, blocking, CPU-bound call, so it's always run via
    run_in_threadpool to avoid blocking the event loop.
    """
    row = (
        await session.execute(
            text("SELECT id, password_hash, is_active FROM users WHERE email = :email"),
            {"email": body.email},
        )
    ).one_or_none()

    # Always check against *some* bcrypt hash, even when there's no row (or
    # the row is inactive), so the response-time profile is the same as a
    # real password check - see _DUMMY_PASSWORD_HASH above.
    password_hash = row.password_hash if (row is not None and row.is_active) else _DUMMY_PASSWORD_HASH
    password_ok = await run_in_threadpool(verify_password, body.password, password_hash)

    if row is None or not row.is_active or not password_ok:
        raise HTTPException(status_code=401, detail=_INVALID_CREDENTIALS_ERROR)

    settings = get_settings()
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(hours=settings.session_ttl_hours)

    await session.execute(
        text(
            "INSERT INTO sessions (token_hash, user_id, expires_at) "
            "VALUES (:token_hash, :user_id, :expires_at)"
        ),
        {"token_hash": token_hash, "user_id": row.id, "expires_at": expires_at},
    )
    await session.commit()

    response.set_cookie(
        SESSION_COOKIE_NAME,
        raw_token,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
        max_age=settings.session_ttl_hours * 3600,
    )

    return LoginResponse(email=body.email)


@router.post("/auth/logout", status_code=204)
async def logout(
    response: Response,
    session: AsyncSession = Depends(get_session),
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> None:
    """Deletes the `sessions` row matching the `session` cookie (if any) and
    always clears the cookie on the response.

    Idempotent: a missing cookie, or one that no longer matches any
    `sessions` row (already logged out / expired / revoked elsewhere), is
    not an error - this always returns 204.
    """
    if session_token is not None:
        token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
        await session.execute(
            text("DELETE FROM sessions WHERE token_hash = :token_hash"),
            {"token_hash": token_hash},
        )
        await session.commit()

    response.delete_cookie(SESSION_COOKIE_NAME, path="/")


@router.get("/auth/me")
async def me(email: str = Depends(require_session)) -> LoginResponse:
    """Returns the authenticated caller's email - the frontend calls this
    once per page-load to check "am I logged in" and get the display email.
    All the actual session validation lives in require_session; a missing,
    unknown, expired, or deactivated-user session raises 401 there before
    this body ever runs."""
    return LoginResponse(email=email)
