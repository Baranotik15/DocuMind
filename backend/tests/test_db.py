import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(authenticated_client: TestClient) -> TestClient:
    # GET /internal/db-check now requires a session too (see app/main.py's
    # inline db_check route, which got Depends(require_session) added
    # directly since it isn't reached via include_router) - overrides
    # conftest.py's plain, unauthenticated `client` fixture for the test
    # below.
    return authenticated_client


def test_db_check_returns_ok(client: TestClient) -> None:
    response = client.get("/internal/db-check")

    assert response.status_code == 200
    assert response.json() == {"db": "ok"}
