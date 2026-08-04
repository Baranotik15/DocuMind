import asyncio

import pytest
from fastapi.testclient import TestClient

from app.db.session import engine
from app.main import app


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _dispose_engine_after_test():
    # Each TestClient(app) context runs its own event loop. The async
    # engine's connection pool is a module-level singleton bound to
    # whichever loop first used it, so it must be disposed after every
    # test - otherwise the next test's loop inherits stale, closed
    # connections from the previous one.
    yield
    asyncio.run(engine.dispose())
