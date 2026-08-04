# Phase 0: Local Infrastructure Foundation — Implementation Plan

> **For Claude:** This project does not use `superpowers:executing-plans`.
> Execute via the project's own `/work` command, one task at a time. Per
> standing project convention: implement exactly one task below, commit it,
> report, and **stop** — wait for explicit user go-ahead before starting the
> next task. Do not spawn a subagent per task and chain through them
> automatically.

**Goal:** Stand up a local Docker-composed foundation (Postgres+pgvector,
Redis, FastAPI backend, Celery worker, React+Mantine frontend) satisfying
`.claude/specs/phase-0-infra.md`.

**Architecture:** One Python package (`backend/app`) serves both the FastAPI
process and the Celery worker process (same image, different container
command) — no code duplication between "backend" and "worker". Celery uses a
synchronous SQLAlchemy engine for DB access (workers are sync-by-default);
FastAPI uses an async engine. Both point at the same Postgres instance via
different driver schemes in the connection URL. Celery has no result
backend — task outcomes are written to Postgres by the task itself.

**Tech Stack:** FastAPI, SQLAlchemy (async for API, sync for worker) +
Alembic, Celery + Redis (broker only), pytest/pytest-asyncio/httpx, React +
Vite + TypeScript + Mantine + Vitest, Docker Compose. Image:
`pgvector/pgvector:pg16` for Postgres, `redis:7-alpine` for Redis.

---

## Task 1: Backend project skeleton + health endpoint

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/app/__init__.py`
- Create: `backend/app/config.py`
- Create: `backend/app/main.py`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/conftest.py`
- Test: `backend/tests/test_health.py`

**Contracts:**

```python
# backend/app/config.py
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://documind:documind@localhost:5432/documind"
    database_url_sync: str = "postgresql+psycopg://documind:documind@localhost:5432/documind"
    celery_broker_url: str = "redis://localhost:6379/0"

    class Config:
        env_file = ".env"

def get_settings() -> Settings:
    """Returns a cached Settings instance (use functools.lru_cache)."""
    ...
```

```python
# backend/app/main.py
from fastapi import FastAPI

def create_app() -> FastAPI:
    """Builds and returns the FastAPI app, registers routes."""
    ...

app = create_app()

@app.get("/health")
def health() -> dict[str, str]:
    """Returns {"status": "ok"}. No DB/broker dependency — pure liveness check."""
    ...
```

**Integration:** None yet — this is the first file in the repo. Later tasks
import `get_settings` from `app.config` and extend `create_app()`.

**Step 1: Write the failing test**

`backend/tests/test_health.py`: using `fastapi.testclient.TestClient` (or
`httpx.AsyncClient` with `ASGITransport`), assert `GET /health` returns
status 200 and JSON `{"status": "ok"}`.

`backend/tests/conftest.py`: a `client` fixture constructing the test
client from `app.main.app`.

Run: `cd backend && pip install -r requirements.txt && pytest tests/test_health.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'app'` or similar —
nothing exists yet)

**Step 2: Implement**

Add to `requirements.txt`: `fastapi`, `uvicorn[standard]`,
`pydantic-settings`, `pytest`, `httpx`. Implement `config.py` and `main.py`
per the contracts above.

**Step 3: Verify**

Run: `pytest tests/test_health.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/requirements.txt backend/app backend/tests
git commit -m "feat: bootstrap FastAPI app skeleton with health endpoint"
```

---

## Task 2: Docker Compose — Postgres + Redis

*(Configuration task — no application code, verified by commands per the
`test-driven-development` skill's config-file exception, not pytest.)*

**Files:**
- Create: `docker-compose.yml` (repo root)
- Create: `.env.example` (repo root)

**Contracts (compose services):**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: documind
      POSTGRES_PASSWORD: documind
      POSTGRES_DB: documind
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U documind"]
      interval: 5s
      timeout: 3s
      retries: 5
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  postgres_data:
```

`.env.example` documents `DATABASE_URL`, `DATABASE_URL_SYNC`,
`CELERY_BROKER_URL` (matching the defaults in `app/config.py`, pointed at
`postgres`/`redis` service names instead of `localhost`).

**Step 1: Bring services up**

Run: `docker compose up -d postgres redis`
Expected: both containers start

**Step 2: Verify health**

Run: `docker compose ps`
Expected: both `postgres` and `redis` show `healthy`

**Step 3: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat: add postgres+pgvector and redis to docker-compose"
```

---

## Task 3: Async DB engine + Alembic + pgvector migration

**Files:**
- Create: `backend/app/db.py`
- Create: `backend/alembic.ini`
- Create: `backend/alembic/env.py`
- Create: `backend/alembic/versions/0001_enable_pgvector.py`
- Test: `backend/tests/test_db.py`
- Modify: `backend/requirements.txt` (add `sqlalchemy[asyncio]`, `asyncpg`,
  `alembic`)

**Contracts:**

```python
# backend/app/db.py
from collections.abc import AsyncIterator
from sqlalchemy.ext.asyncio import AsyncSession, AsyncEngine, async_sessionmaker

engine: AsyncEngine  # create_async_engine(get_settings().database_url)
async_session_factory: async_sessionmaker[AsyncSession]

async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: yields an AsyncSession, closes it after the request."""
    ...
```

`alembic/versions/0001_enable_pgvector.py`: single migration whose
`upgrade()` runs `op.execute("CREATE EXTENSION IF NOT EXISTS vector")` and
whose `downgrade()` runs `op.execute("DROP EXTENSION IF EXISTS vector")`.

**Integration:**
- `backend/app/main.py` gains a `GET /internal/db-check` route (temporary,
  kept through Phase 0 only) that runs `SELECT 1` via `get_session()` and
  returns `{"db": "ok"}` — this is what the test below exercises.

**Step 1: Write the failing test**

`backend/tests/test_db.py`: integration test (requires `docker compose up -d
postgres` running) — call `GET /internal/db-check`, assert 200 and
`{"db": "ok"}`. This is an integration test per
`.claude/docs/testing.md` ("query correctness ... real test DB"), not
mocked.

Run: `docker compose up -d postgres && cd backend && alembic upgrade head && pytest tests/test_db.py -v`
Expected: FAIL (route/module doesn't exist yet)

**Step 2: Implement**

Implement `db.py`, the Alembic setup (`alembic init` layout, `env.py`
reading `get_settings().database_url` synchronously via
`database_url_sync` for Alembic's own connection — Alembic doesn't need
async), the `0001_enable_pgvector` migration, and the `/internal/db-check`
route.

**Step 3: Verify**

Run: `alembic upgrade head && pytest tests/test_db.py -v`
Expected: PASS. Also run `docker compose exec postgres psql -U documind -c
"\dx"` and confirm `vector` is listed.

**Step 4: Commit**

```bash
git add backend/app/db.py backend/alembic.ini backend/alembic backend/tests/test_db.py backend/requirements.txt backend/app/main.py
git commit -m "feat: add async db engine, alembic, and pgvector migration"
```

---

## Task 4: Celery worker + Postgres-backed smoke job (no result backend)

**Files:**
- Create: `backend/app/db_sync.py`
- Create: `backend/app/celery_app.py`
- Create: `backend/app/tasks.py`
- Create: `backend/alembic/versions/0002_smoke_jobs.py`
- Modify: `backend/app/main.py` (add `/internal/smoke-job` routes)
- Test: `backend/tests/test_smoke_job.py`
- Modify: `backend/requirements.txt` (add `celery`, `redis`, `psycopg[binary]`)

**Contracts:**

```python
# backend/app/db_sync.py
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

sync_engine  # create_engine(get_settings().database_url_sync)
SyncSessionLocal: sessionmaker[Session]
```

`0002_smoke_jobs` migration creates table `smoke_jobs`: `id (uuid, pk)`,
`status (text, not null, default 'pending')`, `created_at (timestamptz, not
null, default now())`, `completed_at (timestamptz, nullable)`.

```python
# backend/app/celery_app.py
from celery import Celery

celery_app = Celery("documind", broker=get_settings().celery_broker_url)
celery_app.conf.task_ignore_result = True  # outcomes live in Postgres, not the broker
```

```python
# backend/app/tasks.py
@celery_app.task(name="run_smoke_job")
def run_smoke_job(job_id: str) -> None:
    """Uses SyncSessionLocal (not the async engine) to set smoke_jobs.status
    = 'done' and completed_at = now() for the given job_id.
    Raises SmokeJobNotFoundError if job_id doesn't exist."""
    ...
```

**Integration:**
- `POST /internal/smoke-job` in `main.py`: inserts a `smoke_jobs` row via
  `get_session()`, calls `run_smoke_job.delay(str(job_id))`, returns
  `{"job_id": job_id}`.
- `GET /internal/smoke-job/{job_id}` in `main.py`: reads the row via
  `get_session()`, returns `{"status": row.status}`.

**Step 1: Write the failing test**

`backend/tests/test_smoke_job.py`: set `celery_app.conf.task_always_eager =
True` in the test fixture (per `.claude/docs/testing.md`: "Prefer executing
tasks in a synchronous/eager mode so the real task body runs"). POST to
`/internal/smoke-job`, then GET `/internal/smoke-job/{job_id}` and assert
`status == "done"` — proving the outcome came from Postgres, with no Celery
result backend involved.

Run: `pytest tests/test_smoke_job.py -v`
Expected: FAIL (routes/task don't exist)

**Step 2: Implement**

Implement `db_sync.py`, the migration, `celery_app.py`, `tasks.py`, and the
two routes per the contracts above.

**Step 3: Verify**

Run: `alembic upgrade head && pytest tests/test_smoke_job.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/db_sync.py backend/app/celery_app.py backend/app/tasks.py backend/alembic/versions/0002_smoke_jobs.py backend/app/main.py backend/tests/test_smoke_job.py backend/requirements.txt
git commit -m "feat: add celery worker with postgres-backed smoke job, no result backend"
```

---

## Task 5: Storage adapter (local disk, S3-swappable seam)

**Files:**
- Create: `backend/app/storage.py`
- Test: `backend/tests/test_storage.py`

**Contracts:**

```python
# backend/app/storage.py
from typing import Protocol

class StorageKeyNotFoundError(Exception):
    """Raised when read()/delete() is called with a key that doesn't exist."""

class StorageAdapter(Protocol):
    def save(self, key: str, data: bytes) -> None: ...
    def read(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...

class LocalDiskStorage:
    """Concrete StorageAdapter backed by a local directory.
    S3 (or other) implementations later conform to the same Protocol —
    callers never import LocalDiskStorage directly, only StorageAdapter."""
    def __init__(self, base_dir: Path) -> None: ...
    def save(self, key: str, data: bytes) -> None: ...
    def read(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
```

**Integration:** Not wired into any route yet (no upload endpoint exists
until Phase 1) — this task only establishes the seam per
`.claude/specs/phase-0-infra.md`'s acceptance criterion on storage
swappability.

**Step 1: Write the failing test**

`backend/tests/test_storage.py` (uses pytest's built-in `tmp_path` fixture,
no infra dependency):
- `save()` then `read()` returns the same bytes.
- `read()` on a missing key raises `StorageKeyNotFoundError`.
- `delete()` then `read()` raises `StorageKeyNotFoundError`.

Run: `pytest tests/test_storage.py -v`
Expected: FAIL (module doesn't exist)

**Step 2: Implement**

Implement `LocalDiskStorage` per the contract.

**Step 3: Verify**

Run: `pytest tests/test_storage.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/storage.py backend/tests/test_storage.py
git commit -m "feat: add StorageAdapter protocol with local-disk implementation"
```

---

## Task 6: Backend Dockerfile + compose wiring (backend + worker)

*(Configuration task, verified by commands.)*

**Files:**
- Create: `backend/Dockerfile`
- Modify: `docker-compose.yml` (add `backend` and `worker` services)

**Contracts (Dockerfile, single image for both services):**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY alembic.ini .
COPY alembic ./alembic
```

**Compose additions:**

```yaml
  backend:
    build: ./backend
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000
    env_file: .env
    ports: ["8000:8000"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"]
      interval: 5s
      timeout: 3s
      retries: 5

  worker:
    build: ./backend
    command: celery -A app.celery_app worker --loglevel=info
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
```

**Step 1: Build and run**

Run: `docker compose build backend worker && docker compose up -d backend worker`
Expected: both containers start; `docker compose ps` shows `backend` healthy

**Step 2: Verify end-to-end through the container**

Run: `docker compose exec backend alembic upgrade head && curl http://localhost:8000/health`
Expected: `{"status":"ok"}`

**Step 3: Commit**

```bash
git add backend/Dockerfile docker-compose.yml
git commit -m "feat: containerize backend and worker services"
```

---

## Task 7: Frontend skeleton (React + Mantine)

**Files:**
- Create: `frontend/package.json`, `frontend/vite.config.ts`,
  `frontend/tsconfig.json`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Test: `frontend/src/App.test.tsx`
- Create: `frontend/Dockerfile`
- Modify: `docker-compose.yml` (add `frontend` service)

**Contracts:**

```tsx
// frontend/src/App.tsx
export function App(): JSX.Element {
  // Wraps children in Mantine's <MantineProvider>, renders a placeholder
  // heading ("DocuMind") — real pages come in later phases.
}
```

**Step 1: Write the failing test**

`frontend/src/App.test.tsx` (Vitest + `@testing-library/react`): render
`<App />`, assert the text "DocuMind" is present.

Run: `cd frontend && npm install && npm test`
Expected: FAIL (`App` doesn't exist)

**Step 2: Implement**

Scaffold via Vite React-TS template conventions; implement `App.tsx` per
contract, add `@mantine/core` + `@mantine/hooks` to `package.json`.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Dockerize + compose**

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev", "--", "--host"]
```

```yaml
  frontend:
    build: ./frontend
    ports: ["5173:5173"]
    depends_on: [backend]
```

Run: `docker compose up -d frontend && docker compose ps`
Expected: `frontend` running

**Step 5: Commit**

```bash
git add frontend docker-compose.yml
git commit -m "feat: add React+Mantine frontend skeleton"
```

---

## Task 8: Full-stack acceptance check

*(Verification task — no new code, confirms `.claude/specs/phase-0-infra.md`
Acceptance Criteria against the composed stack.)*

**Step 1**

Run: `docker compose up -d`
Expected: all 5 services (`postgres`, `redis`, `backend`, `worker`,
`frontend`) report healthy/running via `docker compose ps`

**Step 2**

Run: `docker compose exec postgres psql -U documind -c "\dx"`
Expected: `vector` extension listed

**Step 3**

Run:
```bash
JOB_ID=$(curl -s -X POST http://localhost:8000/internal/smoke-job | jq -r .job_id)
curl -s http://localhost:8000/internal/smoke-job/$JOB_ID
```
Expected: `{"status": "done"}` — processed by the `worker` container, status
read back from Postgres, no broker query involved.

**Step 4: Commit**

Only if Step 1-3 required fixes; otherwise this task is verification-only
and produces no diff.
