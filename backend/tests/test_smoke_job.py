import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.worker.celery_app import celery_app


@pytest.fixture
def client(authenticated_client: TestClient) -> TestClient:
    # smoke_jobs_router now requires a session (see app/main.py) -
    # overrides conftest.py's plain, unauthenticated `client` fixture for
    # every test in this module.
    return authenticated_client


@pytest.fixture(autouse=True)
def _celery_eager() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


def test_smoke_job_completes_via_postgres_not_broker(client: TestClient) -> None:
    create_response = client.post("/internal/smoke-job")
    assert create_response.status_code == 200
    job_id = create_response.json()["job_id"]

    status_response = client.get(f"/internal/smoke-job/{job_id}")

    assert status_response.status_code == 200
    assert status_response.json() == {"status": "done"}


def test_create_smoke_job_without_session_cookie_returns_401() -> None:
    # A bare TestClient built directly (not via this module's `client`
    # fixture override, which is always pre-authenticated) so this request
    # genuinely carries no `session` cookie - proving require_session is
    # actually wired up on smoke_jobs_router's include_router(...) call
    # too, not just documents_router's (see test_documents_router.py's own
    # equivalent 401 test).
    with TestClient(app) as bare_client:
        response = bare_client.post("/internal/smoke-job")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}
