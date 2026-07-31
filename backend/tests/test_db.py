from fastapi.testclient import TestClient


def test_db_check_returns_ok(client: TestClient) -> None:
    response = client.get("/internal/db-check")

    assert response.status_code == 200
    assert response.json() == {"db": "ok"}
