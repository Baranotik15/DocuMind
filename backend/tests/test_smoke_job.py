import pytest
from fastapi.testclient import TestClient

from app.worker.celery_app import celery_app


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
