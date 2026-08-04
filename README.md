# DocuMind

<p align="center">
  <b>Lang:</b>
  <img alt="ENG" src="https://img.shields.io/badge/ENG-2ea44f?style=for-the-badge">
  <a href="README.ru.md"><img alt="RUS" src="https://img.shields.io/badge/RUS-0366d6?style=for-the-badge"></a>
</p>

DocuMind is a self-hosted RAG (Retrieval-Augmented Generation) documentation
assistant. Upload PDF/DOCX documents, let them be automatically parsed and
chunked, review or edit the resulting chunks, then chat with an LLM that
answers using retrieved context from your own documents. A built-in
dashboard shows pipeline event logs, usage stats, and a 3D visualization of
chunk embeddings.

## Screenshots

| Upload | Chunk review |
|---|---|
| ![Upload page](docs/images/upload.png) | ![Chunk review page](docs/images/chunks.png) |

| Chat | Dashboard |
|---|---|
| ![Chat page](docs/images/chat.png) | ![Dashboard](docs/images/dashboard.png) |

## Tech stack

**Backend**
- Python 3.12, FastAPI + Uvicorn
- SQLAlchemy — async (asyncpg) for the API, sync (psycopg) for Alembic and the Celery worker
- PostgreSQL 16 + pgvector — single datastore for documents, chunks, embeddings, chat history, and event logs
- Celery + Redis (broker only, no result backend — task outcomes are written straight to Postgres)
- OpenAI API — embeddings and chat completions (models configurable, see `.env.example`)
- pypdf / python-docx for text extraction, numpy + umap-learn for the 3D embedding projection
- Alembic for schema migrations
- pytest + pytest-cov for testing

**Frontend**
- React 19 + TypeScript, built with Vite
- Mantine UI (core / dates / dropzone / hooks) component library
- react-router-dom for routing
- 3d-force-graph + three.js for the 3D chunk-embedding graph
- Vitest + Testing Library for tests, oxlint for linting

**Infrastructure**
- Docker Compose for local orchestration (postgres, redis, backend, worker, frontend)
- GitHub Actions CI — separate backend/frontend pipelines, gated on ≥75% test coverage

## Architecture

```
Upload (frontend) -> POST /internal/documents -> StorageAdapter (local disk)
                                                -> documents row (status: uploaded)
                                                -> Celery job enqueued via Redis
                                                          |
                                                          v
                                              Redis (Celery broker)
                                                          |
                                                          v
Celery worker: extract text (pypdf/docx) -> split into paragraph-based
chunks (~1500 chars, sentence-level hard-split fallback for oversized
paragraphs) -> embed each chunk (OpenAI Embeddings API) -> write chunks +
vectors to Postgres -> status: chunking -> ready (or failed, recorded as
an event)
                                                          |
                                                          v
Chat: POST /internal/chat/messages -> top-K similar chunks retrieved via
pgvector cosine similarity across all "ready" documents -> fed to the
OpenAI chat model as context -> reply persisted alongside the user message
```

Redis sits between the API and the Celery worker purely as the task
**broker** (transport for enqueued jobs) - there is no Celery result
backend configured. Task outcomes (status transitions, chunk/vector
writes) are written straight to Postgres, never read back from Redis, so
the broker itself stays swappable (e.g. to RabbitMQ) via configuration
alone if that's ever needed.

Every pipeline/chat event is recorded to a `dashboard_events` table. The
built-in Dashboard reads directly from Postgres to show an event log,
calendar-aligned usage charts (messages/dislikes by day/week/month/year), a
3D UMAP projection of all chunk embeddings (grouped/linked by source
document), and — if an OpenAI **Admin** API key is configured — an
organization-level spend/token usage panel.

A `getTopMatchingChunks`/`top-chunks` endpoint exposes the same retrieval
step directly (a "Relevance Preview" page) for inspecting semantic search
results without going through the LLM.

There is no authentication layer yet — the app is intended for local/
internal use as-is.

## Project structure

```
DocuMind/
├── backend/
│   ├── app/
│   │   ├── routers/       documents, chat, dashboard (API endpoints)
│   │   ├── services/      documents (parse), pipeline (chunk+embed),
│   │   │                  llm (OpenAI client), vectors, events, storage
│   │   ├── worker/        celery_app, tasks (Celery entry points)
│   │   ├── db/            session (async), sync_session (Alembic/Celery)
│   │   ├── prompts/       chat system prompt
│   │   ├── main.py        FastAPI app factory
│   │   ├── config.py      Settings (env-driven)
│   │   └── deps.py        dependency providers (e.g. get_storage)
│   ├── alembic/           schema migrations
│   └── tests/
├── frontend/
│   └── src/
│       ├── pages/         Upload, Chunk review, Chat, Relevance, Dashboard
│       └── api/           ApiClient (real HTTP client + offline mock)
├── docker-compose.yml
└── .github/workflows/     CI (backend-ci.yml, frontend-ci.yml)
```

## Getting started

**Prerequisites:** Docker + Docker Compose, an OpenAI API key (optional —
without it, document chunking fails gracefully and chat replies with a
502, but everything else still runs).

```bash
git clone <repo-url>
cd DocuMind
cp .env.example .env        # fill in OPENAI_API_KEY (and OPENAI_ADMIN_API_KEY, optional)
docker compose up -d --build
docker compose exec backend alembic upgrade head   # first run only
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8000 (health check: `GET /health`)

The frontend hot-reloads via Vite. The backend and worker do **not** —
after backend code changes, rebuild with:

```bash
docker compose up -d --build backend worker
```

**Running tests locally**

```bash
# Backend (needs a Postgres+pgvector and Redis instance reachable via
# DATABASE_URL / DATABASE_URL_SYNC / CELERY_BROKER_URL)
cd backend && pytest tests/ --cov=app --cov-fail-under=75

# Frontend
cd frontend && npm ci && npm test -- --coverage
```

CI runs both suites on every pull request and push to `main`, and fails the
build if coverage drops below 75%.
