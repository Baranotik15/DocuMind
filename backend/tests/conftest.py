import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.auth.cli import create_user
from app.db.session import engine
from app.db.sync_session import SyncSessionLocal
from app.main import app


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def authenticated_client() -> TestClient:
    """A TestClient whose cookie jar already carries a valid `session`
    cookie - obtained by CLI-provisioning a fresh throwaway user (via
    app.auth.cli.create_user) and logging in as them through the real
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
