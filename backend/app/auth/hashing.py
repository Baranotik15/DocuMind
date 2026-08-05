import hashlib

import bcrypt


def hash_session_token(raw: str) -> str:
    """Hashes a raw session token (already a high-entropy secrets.token_urlsafe
    value, not a user-chosen secret) via sha256 - fast and unsalted,
    appropriate here unlike bcrypt's deliberate slowness for passwords below.
    Used to derive what's actually stored in `sessions.token_hash`; the raw
    token itself only ever lives in the cookie, never in the database."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def hash_password(plain: str) -> str:
    """Hashes a plaintext password with bcrypt (its own random salt is
    generated per call via bcrypt.gensalt()), returning a str suitable for
    storing directly in the `users.password_hash` column."""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Checks a plaintext password against a bcrypt hash produced by
    hash_password. Used by POST /auth/login (see router.py)."""
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
