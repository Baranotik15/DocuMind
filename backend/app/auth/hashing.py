import bcrypt


def hash_password(plain: str) -> str:
    """Hashes a plaintext password with bcrypt (its own random salt is
    generated per call via bcrypt.gensalt()), returning a str suitable for
    storing directly in the `users.password_hash` column."""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Checks a plaintext password against a bcrypt hash produced by
    hash_password. Not used by this slice's CLI scripts - kept alongside
    hash_password for the login endpoint a later slice will add."""
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
