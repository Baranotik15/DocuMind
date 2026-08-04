<table width="100%">
<tr>
<td valign="top">

# DocuMind

*Self-hosted RAG (Retrieval-Augmented Generation) documentation assistant*

</td>
<td align="right" valign="top">

**Lang:**<br>
<img alt="ENG" src="https://img.shields.io/badge/ENG-2ea44f?style=for-the-badge">
<a href="README.ru.md"><img alt="RUS" src="https://img.shields.io/badge/RUS-0366d6?style=for-the-badge"></a>

</td>
</tr>
</table>

<p align="center">
  <img alt="Python" src="https://img.shields.io/badge/Python_3.12-3776AB?style=for-the-badge&logo=python&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL_16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white">
  <img alt="Celery" src="https://img.shields.io/badge/Celery-37814A?style=for-the-badge&logo=celery&logoColor=white">
  <br>
  <img alt="React" src="https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white">
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white">
</p>

Upload PDF/DOCX documents, let them be automatically parsed and chunked,
review or edit the resulting chunks, then chat with an LLM that answers
using retrieved context from your own documents. A built-in dashboard
shows pipeline event logs, usage stats, and a 3D visualization of chunk
embeddings.

<p align="center">
  <a href="#-preview">Preview</a> ·
  <a href="#-tech-stack">Tech stack</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-api-endpoints">API endpoints</a> ·
  <a href="#-project-structure">Project structure</a> ·
  <a href="#-getting-started">Getting started</a>
</p>

---

<a id="-preview"></a>

## 🖼️ Preview

| Upload | Chunk review |
|---|---|
| ![Upload page](docs/images/upload.png) | ![Chunk review page](docs/images/chunks.png) |

| Chat | Dashboard |
|---|---|
| ![Chat page](docs/images/chat.png) | ![Dashboard](docs/images/dashboard.png) |

---

<a id="-tech-stack"></a>

## 🛠️ Tech stack

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

---

<a id="-architecture"></a>

## 🏗️ Architecture

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

> **Note:** there is no authentication layer yet — the app is intended for
> local/internal use as-is.

---

<a id="-api-endpoints"></a>

## 🔌 API endpoints

Interactive docs (Swagger UI) are on by default at
**http://localhost:8000/docs** (ReDoc at `/redoc`, raw OpenAPI schema at
`/openapi.json`) - the full, always-current source of truth. Summary
below, grouped by module; all paths are prefixed with `/internal` except
`/health`.

**Documents**
| Method | Path | Description |
|---|---|---|
| `POST` | `/documents` | Upload a document (multipart; `overwrite` form field to replace an existing one) |
| `GET` | `/documents` | List all documents |
| `DELETE` | `/documents/{id}` | Delete a document and its stored file |

**Chunks**
| Method | Path | Description |
|---|---|---|
| `GET` | `/documents/{id}/chunks` | Get a document's chunks |
| `POST` | `/documents/{id}/chunks` | Save edited chunks, triggering a re-chunk/re-embed (202) |

**Chat**
| Method | Path | Description |
|---|---|---|
| `POST` | `/chat/messages` | Send a message, get an LLM reply |
| `GET` | `/chat/messages` | List chat history |
| `POST` | `/chat/messages/{id}/dislike` | Toggle dislike on a message |
| `POST` | `/chat/top-chunks` | Relevance preview - top-5 matching chunks, no LLM call |

**Dashboard**
| Method | Path | Description |
|---|---|---|
| `GET` | `/dashboard/events` | Pipeline/chat event log |
| `GET` | `/dashboard/stats` | Usage stats (query: `range`, `tz`) |
| `GET` | `/dashboard/chunk-graph` | 3D UMAP projection of all chunk embeddings |
| `GET` | `/dashboard/openai-spend` | OpenAI organization spend/token usage |

**Other**
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/internal/db-check` | Database connectivity check |
| `POST` | `/internal/smoke-job` | Create an internal smoke-test job |
| `GET` | `/internal/smoke-job/{id}` | Smoke-test job status |

---

<a id="-project-structure"></a>

## 📁 Project structure

Backend code is organized as one self-contained module per database
table (router + schemas + business logic together), not by horizontal
layer - see each module below.

```
DocuMind/
├── backend/
│   ├── app/
│   │   ├── documents/     upload/list/delete, extraction, storage,
│   │   │                  the parse->chunk->embed pipeline, its Celery task
│   │   ├── chunks/        chunk router, splitting, embedding, vectors,
│   │   │                  similarity retrieval
│   │   ├── chat/          messages, dislike, top-chunks, reply generation
│   │   ├── dashboard_events/  dashboard_events table CRUD
│   │   ├── dashboard/     stats/chunk-graph/openai-spend (no single
│   │   │                  owning table - kept separate from the above)
│   │   ├── smoke_jobs/    internal health-check job
│   │   ├── db/            session (async), sync_session (Alembic/Celery)
│   │   ├── worker/        celery_app (shared Celery instance)
│   │   ├── main.py        FastAPI app factory, wires up every module's router
│   │   └── config.py      Settings (env-driven)
│   ├── alembic/           schema migrations
│   └── tests/
├── frontend/
│   └── src/
│       ├── pages/         Upload, Chunk review, Chat, Relevance, Dashboard
│       └── api/           ApiClient (real HTTP client + offline mock)
├── docker-compose.yml
└── .github/workflows/     CI (backend-ci.yml, frontend-ci.yml)
```

---

<a id="-getting-started"></a>

## 🚀 Getting started

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
