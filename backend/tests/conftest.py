import asyncio
import os
import uuid
from pathlib import Path

# --- Test-database isolation --------------------------------------------
# The test suite used to run against the SAME Postgres database the live
# dev app reads from (docker-compose.yml provisions exactly one `documind`
# database - no separate test DB, a Phase-0-era shortcut). Nothing here
# rolls back its writes, and some cleanup (e.g. test_chat_router.py's
# per-message `_cleanup_messages`) only deletes rows whose id it managed to
# record before an assertion failed - a real, unrelated `ready` document
# already sitting in the shared dev DB is exactly what made some of those
# assertions fail (unexpected extra retrieval context), which skipped the
# id-recording step for that row and left it behind for good. That's how
# fixture content like "question <uuid>"/"lonely question <uuid>" started
# showing up as real entries in the live Chat page.
#
# The fix: point every DB connection this test process ever opens at a
# separate `<name>_test` database on the same Postgres server instead.
# This MUST run before any `from app...` import below - app.db.session/
# app.db.sync_session create their SQLAlchemy engines from
# app.config.get_settings() at MODULE IMPORT TIME, so DATABASE_URL/
# DATABASE_URL_SYNC have to be the test values before that first import,
# not just before individual tests run. Matches app.config.Settings' own
# defaults (localhost, for host/venv runs) - but also correctly picks up
# whatever docker-compose.yml's `env_file: .env` already injected as a
# real process env var when running inside the backend/worker containers
# (host `postgres`, not `localhost`), since os.environ.get sees that
# before ever falling back to the hardcoded default.
_DEFAULT_DATABASE_URL = "postgresql+asyncpg://documind:documind@localhost:5434/documind"
_DEFAULT_DATABASE_URL_SYNC = "postgresql+psycopg://documind:documind@localhost:5434/documind"


def _as_test_db_url(url: str) -> str:
    base, _, db_name = url.rpartition("/")
    return f"{base}/{db_name}_test"


os.environ["DATABASE_URL"] = _as_test_db_url(os.environ.get("DATABASE_URL", _DEFAULT_DATABASE_URL))
os.environ["DATABASE_URL_SYNC"] = _as_test_db_url(
    os.environ.get("DATABASE_URL_SYNC", _DEFAULT_DATABASE_URL_SYNC)
)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from app.auth.service import create_user  # noqa: E402
from app.db.session import engine  # noqa: E402
from app.db.sync_session import SyncSessionLocal  # noqa: E402
from app.main import app  # noqa: E402


def _ensure_test_database_ready() -> None:
    """Creates the `_test`-suffixed database (see _as_test_db_url above) if
    it doesn't already exist, then runs every migration against it -
    idempotent, safe to call at the start of every test session. CREATE
    DATABASE can't run inside a transaction block, so this opens its own
    autocommit connection to Postgres's always-present `postgres`
    maintenance database rather than reusing SyncSessionLocal (which points
    at the not-yet-guaranteed-to-exist test database itself)."""
    import psycopg
    from alembic import command
    from alembic.config import Config

    test_url = make_url(os.environ["DATABASE_URL_SYNC"].replace("postgresql+psycopg", "postgresql"))
    test_db_name = test_url.database
    maintenance_dsn = test_url.set(database="postgres").render_as_string(hide_password=False)

    with psycopg.connect(maintenance_dsn, autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (test_db_name,)
        ).fetchone()
        if exists is None:
            conn.execute(f'CREATE DATABASE "{test_db_name}"')

    backend_dir = Path(__file__).resolve().parent.parent
    alembic_cfg = Config(str(backend_dir / "alembic.ini"))
    command.upgrade(alembic_cfg, "head")


@pytest.fixture(scope="session", autouse=True)
def _isolated_test_database() -> None:
    _ensure_test_database_ready()


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def authenticated_client() -> TestClient:
    """A TestClient whose cookie jar already carries a valid `session`
    cookie - obtained by CLI-provisioning a fresh throwaway user (via
    app.auth.service.create_user) and logging in as them through the real
    POST /internal/auth/login, exactly like test_auth_router.py's own
    logout test does. Every /internal/* route other than auth's own now
    requires a session, so test files for those routers override `client`
    with this fixture (see the per-file `client(authenticated_client)`
    override near the top of each) instead of using the plain,
    unauthenticated `client` fixture above.

    Deliberately does NOT depend on the `client` fixture above - it opens
    its own TestClient - so that a test module overriding `client` to
    resolve to this fixture can't create a resolution cycle (this fixture
    never asks for a fixture literally named `client`).

    The throwaway user (and, via `sessions.user_id`'s ON DELETE CASCADE,
    its session row) is deleted again after the test.
    """
    email = f"authenticated-fixture-{uuid.uuid4()}@example.com"
    password = "authenticated-fixture-password-1"
    create_user(email, password)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/internal/auth/login", json={"email": email, "password": password}
            )
            assert response.status_code == 200
            yield test_client
    finally:
        with SyncSessionLocal() as session:
            session.execute(
                text("DELETE FROM users WHERE email = :email"), {"email": email}
            )
            session.commit()


@pytest.fixture(autouse=True)
def _dispose_engine_after_test():
    # Each TestClient(app) context runs its own event loop. The async
    # engine's connection pool is a module-level singleton bound to
    # whichever loop first used it, so it must be disposed after every
    # test - otherwise the next test's loop inherits stale, closed
    # connections from the previous one.
    yield
    asyncio.run(engine.dispose())
