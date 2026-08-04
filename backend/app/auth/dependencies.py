import hashlib
from datetime import datetime, timezone

from fastapi import Cookie, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.constants import SESSION_COOKIE_NAME
from app.db.session import get_session

_NOT_AUTHENTICATED_ERROR = "not_authenticated"


async def require_session(
    session: AsyncSession = Depends(get_session),
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> str:
    """FastAPI dependency guarding every non-auth `/internal/*` route.

    Returns the authenticated user's email on success. Raises
    HTTPException(401, "not_authenticated") when: the `session` cookie is
    missing; its hashed token matches no `sessions` row; the matching
    session has expired; or the joined user is deactivated
    (`is_active = false`) - never distinguishing which case applied, same
    "don't leak why" posture as login's invalid_credentials response.
    """
    if session_token is None:
        raise HTTPException(status_code=401, detail=_NOT_AUTHENTICATED_ERROR)

    token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
    row = (
        await session.execute(
            text(
                "SELECT users.email, users.is_active, sessions.expires_at "
                "FROM sessions JOIN users ON sessions.user_id = users.id "
                "WHERE sessions.token_hash = :token_hash"
            ),
            {"token_hash": token_hash},
        )
    ).one_or_none()

    if row is None or not row.is_active or row.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail=_NOT_AUTHENTICATED_ERROR)

    return row.email
