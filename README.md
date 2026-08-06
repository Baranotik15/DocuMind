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
  <a href="#-features">Features</a> ·
  <a href="#-preview">Preview</a> ·
  <a href="#-tech-stack">Tech stack</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-authentication">Authentication</a> ·
  <a href="#-api-endpoints">API endpoints</a> ·
  <a href="#-project-structure">Project structure</a> ·
  <a href="#-getting-started">Getting started</a>
</p>

---

<a id="-features"></a>

## ✨ Features

- **📥 Ingest, don't just store** — drop in a PDF, DOCX, or Markdown file and it's parsed, split into paragraph-sized chunks, and embedded automatically in the background — no manual formatting step first.
- **✂️ Nothing ships blind** — every chunk is human-reviewable and editable, with draggable boundaries between chunks, before any of it ever reaches the vector index. A bad split gets fixed before it can become a bad answer.
- **💬 Answers grounded in your own words** — chat retrieves context straight from the documents you uploaded via pgvector similarity search, not from the model's imagination.
- **🎯 See the retrieval before you trust it** — the Relevance Preview page runs the same retrieval step the chat uses and shows exactly which chunks a question would pull back and how closely each one scores, no LLM call required.
- **📊 A dashboard that actually watches the pipeline** — a full event log, calendar-aligned usage charts, a live 3D map of how your chunks cluster in embedding space, and OpenAI spend broken down to the token.
- **🔎 Turns failure into a to-do list** — the Improvements tab quietly tracks every disliked reply and every "I don't know" the bot gives, then an AI-powered pass reads that history and writes a plain-language gap analysis of what your documentation is missing, plus flags places where two documents flatly contradict each other.

---

<a id="-preview"></a>

## 🖼️ Preview

| Login | Upload |
|---|---|
| ![Login page](docs/images/login.png) | ![Upload page](docs/images/upload.png) |

| Chunk review | Chat |
|---|---|
| ![Chunk review page](docs/images/chunks.png) | ![Chat page](docs/images/chat.png) |

| Dashboard | Logs |
|---|---|
| ![Dashboard](docs/images/dashboard.png) | ![Logs page](docs/images/logs.png) |

| Chunk Relevance Preview |
|---|
| ![Chunk Relevance Preview page](docs/images/relevance.png) |

| Improvements — Lists | Improvements — AI Analysis |
|---|---|
| ![Improvements page, Lists tab](docs/images/improvements-list.png) | ![Improvements page, Analysis tab](docs/images/improvements-analysis.png) |

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
- bcrypt for password hashing
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

Every disliked chat reply and every reply where the model reports the
answer isn't in the documentation is tracked (`chat_messages.disliked` /
`no_answer_found`) and surfaced on the Improvements page. From there, an
analysis run (`analysis_reports`, dispatched through the same Celery/Redis
path as ingestion) sends the accumulated failing questions to the LLM for
a plain-language **documentation gap analysis**, and separately runs a
**conflict-detection** pass over candidate chunk pairs (typically across
two different documents) to flag ones whose content actually contradicts
each other.

**Slack bot (a second front-end to the same chat pipeline):**
```
Slack -> POST /internal/slack/events (HMAC-SHA256 request-signature
verified, NOT session auth - see Authentication below) -> ack 200
immediately, RAG lookup deferred to a BackgroundTasks callback (Slack
requires a response within 3s, well under an LLM round trip)
                                                          |
                                                          v
app_mention (channel, only when @-mentioned) or message.im (DM, every
message) -> same embed -> retrieve -> generate pipeline as
POST /chat/messages -> reply posted back via chat.postMessage AND
persisted into chat_messages, tagged channel='slack',
external_identity=<Slack user id>
                                                          |
                                                          v
reaction_added/reaction_removed (thumbsdown) on a bot reply -> matched
back to its chat_messages row via a stored slack_channel_id/
slack_message_ts -> toggles disliked, same as the Chat page's own
dislike button
```
Slack-channel rows count toward Dashboard stats and the Improvements
page's dislike/no-answer lists (surfacing real Slack-sourced gaps is the
point), but are filtered OUT of `GET /chat/messages` - the admin Chat
page's own transcript only ever shows `channel='admin'` rows, so
conversations from Slack users don't interleave into that single-threaded
view. See [Setting up a Slack bot](#-setting-up-a-slack-bot) for how to
configure one.

> **Note:** the admin panel requires logging in — see
> [Authentication](#-authentication) below. Session-based, not
> token-based; accounts are provisioned only via a CLI script, never a
> public sign-up path.

---

<a id="-authentication"></a>

## 🔐 Authentication

Logging in uses email + password and issues a server-side session: an
opaque, `httpOnly` cookie the browser handles automatically (never a
JWT/token the frontend reads or stores itself). Sessions have a fixed
24-hour lifetime from creation — no sliding renewal on activity — and
logging out invalidates one immediately rather than waiting for that TTL.
Every `/internal/*` endpoint outside of `/auth/*` requires a valid
session (see the Auth table below for `login`/`logout`/`me`'s own,
individually-appropriate rules), with one further exception:
`/internal/slack/events` - Slack itself calls this one directly, with no
session cookie of its own, so it authenticates the request a different
way entirely: an HMAC-SHA256 signature over the raw request body, keyed
by `SLACK_SIGNING_SECRET` (plus a 5-minute replay window) - see
`app/slack/signature.py` and [Setting up a Slack
bot](#-setting-up-a-slack-bot). `/health` stays open as the standard
unauthenticated liveness check.

There's no self-registration and no in-app "create user" screen —
accounts are created and revoked only by running a script inside the
backend container:

```bash
# Creates an admin account - prompts for email, then a password (masked
# with * as you type, confirmed by re-entering it; rejected if under 8
# characters or missing a letter/digit). Run from the repository root
# (where docker-compose.yml lives), with -it so the password prompt works.
docker compose exec -it backend python -m app.auth.cli create-user

# Revokes an account - deactivates it and immediately invalidates any of
# its active sessions, rather than waiting for the 24h TTL to expire.
docker compose exec backend python -m app.auth.cli revoke-user --email you@example.com
```

---

<a id="-api-endpoints"></a>

## 🔌 API endpoints

Interactive docs (Swagger UI) are on by default at
**http://localhost:8000/docs** (ReDoc at `/redoc`, raw OpenAPI schema at
`/openapi.json`) - the full, always-current source of truth. Summary
below, grouped by module; all paths are prefixed with `/internal` except
`/health`.

**Auth**
| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/login` | Log in with email + password; sets the session cookie |
| `POST` | `/auth/logout` | Log out; invalidates the session immediately |
| `GET` | `/auth/me` | Whether the caller is logged in, plus their email |

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
| `GET` | `/chat/dislikes` | Every currently-disliked message (query: `range`) |
| `GET` | `/chat/no-answer-messages` | Every message where the model reported no answer was found (query: `range`) |
| `POST` | `/chat/messages/{id}/dismiss-no-answer` | Clear the no-answer flag on a message |

**Analysis**
| Method | Path | Description |
|---|---|---|
| `POST` | `/analysis/reports` | Start a documentation gap-analysis + conflict-detection run |
| `GET` | `/analysis/reports` | List all analysis runs |
| `GET` | `/analysis/reports/{id}` | One run's full detail (gap analysis text, conflicts, token count) |
| `DELETE` | `/analysis/reports/{id}` | Delete a run |

**Dashboard**
| Method | Path | Description |
|---|---|---|
| `GET` | `/dashboard/events` | Pipeline/chat event log |
| `GET` | `/dashboard/stats` | Usage stats (query: `range`, `tz`) |
| `GET` | `/dashboard/chunk-graph` | 3D UMAP projection of all chunk embeddings |
| `GET` | `/dashboard/openai-spend` | OpenAI organization spend/token usage |

**Slack** (signature-verified, not session-authenticated - see [Authentication](#-authentication))
| Method | Path | Description |
|---|---|---|
| `POST` | `/internal/slack/events` | Slack Events API webhook - `url_verification` challenge, `app_mention`/`message.im` (answered via the RAG pipeline), `reaction_added`/`reaction_removed` (thumbsdown toggles dislike) |

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
│   │   ├── auth/          login/logout/me, CLI-only user create/revoke,
│   │   │                  password hashing, session cookies
│   │   ├── documents/     upload/list/delete, extraction, storage,
│   │   │                  the parse->chunk->embed pipeline, its Celery task
│   │   ├── chunks/        chunk router, splitting, embedding, vectors,
│   │   │                  similarity retrieval
│   │   ├── chat/          messages, dislike + no-answer tracking,
│   │   │                  top-chunks, reply generation
│   │   ├── analysis/      AI documentation gap analysis + cross-document
│   │   │                  conflict detection, its Celery task
│   │   ├── slack/         Slack Events API webhook - signature
│   │   │                  verification, app_mention/message.im/
│   │   │                  reaction_added/removed handling
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
│       ├── pages/         Upload, Chunk review, Chat, Relevance, Dashboard,
│       │                  Improvements
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
docker compose exec -it backend python -m app.auth.cli create-user   # first run only - creates your admin login
```

All `docker compose exec` commands must be run from the repository root
(where `docker-compose.yml` lives) — including the `create-user`/
`revoke-user` commands later, any time you run them, not just on first
setup. See [Authentication](#-authentication) for details.

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

<a id="-setting-up-a-slack-bot"></a>

### 🤖 Setting up a Slack bot

DocuMind can sit behind a Slack bot as a second front-end to the same RAG
chat pipeline the in-app Chat page uses - users @-mention it in a channel
or message it directly, and a 👎 reaction on any of its replies feeds the
same dislike-tracking the Improvements page already reads. None of this
needs a public server up front; it can be wired up entirely against a
local `docker compose` stack via the ngrok tunnel described in the next
section.

**1. Create the app** - [api.slack.com/apps](https://api.slack.com/apps)
-> **Create New App** -> **Blank app** (labeled "From scratch" in older
Slack UI versions) -> name it, pick your workspace. Not **AI agent**
(Slack's own hosted-agent framework, unrelated) or **Starter app**
(scaffolds slash commands/features this integration doesn't use).

**2. Bot Token Scopes** - **OAuth & Permissions** -> **Bot Token Scopes**
-> **Add an OAuth Scope**, one at a time:

| Scope | Why |
|---|---|
| `app_mentions:read` | Receive an `app_mention` event when someone @-mentions the bot in a channel |
| `chat:write` | Post replies back (`chat.postMessage`) |
| `im:history` | Receive `message.im` events - required for DM support |
| `reactions:read` | Receive `reaction_added`/`reaction_removed` events - required for the 👎-to-dislike integration |

**3. Event Subscriptions** - **Event Subscriptions** -> **Enable
Events**:
- **Request URL**: your public endpoint + `/internal/slack/events` (the
  ngrok URL from the next section, or a real public URL in production).
  The backend must already be reachable at that URL *before* you enter
  it here - Slack sends a one-time `url_verification` challenge the
  moment you save the field, and the endpoint has to answer it live.
- ⚠️ **Socket Mode must stay OFF** (**Settings** -> **Socket Mode** in the
  left menu). If it's enabled, Slack silently delivers events over a
  WebSocket connection instead of this Request URL - the Request URL
  still shows "Verified", but no real event ever arrives, and nothing
  in the app logs tells you why. This integration only implements the
  HTTP Request URL path, not Socket Mode.
- **Subscribe to bot events** -> **Add Bot User Event**, one at a time:
  `app_mention`, `message.im`, `reaction_added`, `reaction_removed`.
- **Save Changes**.

**4. App Home** (DM support only) - **App Home** -> **Show Tabs** ->
**Messages Tab** -> check **Allow users to send Slash commands and
messages from the messages tab**. Without this, Slack blocks anyone from
DMing the bot at all ("Sending messages to this app has been turned
off"), even though `message.im` is subscribed.

**5. Install and collect credentials** - **Install App** -> **Install to
Workspace** -> **Allow**. Copy the **Bot User OAuth Token** (`xoxb-...`)
into `SLACK_BOT_TOKEN`, and (**Basic Information** -> **App
Credentials**) the **Signing Secret** into `SLACK_SIGNING_SECRET` - both
in `.env` (see `.env.example`). The signing secret is what
`/internal/slack/events` uses to verify a request genuinely came from
Slack (see [Authentication](#-authentication)); the bot token is what
lets it post replies back. **Any time a scope or event subscription
changes afterward, Slack requires reinstalling the app** for the change
to take effect - a banner prompts for this, easy to miss if you're not
watching for it.

**6. Invite the bot** - in a channel: `/invite @YourBotName`, or channel
name -> **Integrations** -> **Add an App**. DMs need no invite - once
step 4 is done, any workspace member can message the bot directly, so
who can *see*/install the app in your workspace is the actual access
boundary here (there's no separate per-user allowlist inside this
integration).

**Behavior recap once configured:** in a channel, only an explicit
`@mention` triggers a reply (plain channel chatter is ignored); in a DM,
every message triggers one (no @ needed); a 👎 on a bot reply toggles
its dislike flag, a 👎 on anything else (a human's own message, an
admin-Chat-page message) is a harmless no-op. An app-authored message
(the bot's own reply landing back in a DM as a new `message.im` event)
is always ignored too - otherwise it would answer its own answers in a
loop.

### 🔗 Exposing your local backend for webhook testing (ngrok)

If you want to test bot integrations (e.g. a Slack bot front-end) locally
without deploying any infrastructure to the cloud, use
[ngrok](https://ngrok.com/) to get a public HTTPS URL pointed at your
local backend:

```bash
# 1. Install ngrok (pick one)
winget install ngrok.ngrok        # Windows
choco install ngrok               # Windows, via Chocolatey
brew install ngrok/ngrok/ngrok    # macOS

# 2. Sign up at https://dashboard.ngrok.com/signup (free tier is enough),
#    then grab your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken
ngrok config add-authtoken <your-authtoken>

# 3. With the backend already running (docker compose up -d), start a tunnel to it
ngrok http 8000
```

ngrok prints a forwarding URL like `https://xxxx.ngrok-free.app -> http://localhost:8000`.
Use that HTTPS URL as the callback/Request URL when configuring the
external service (e.g. Slack's Event Subscriptions). On the free tier the
URL changes every time you restart `ngrok http`, so keep the tunnel
running for the duration of your test and update the callback URL again
if you restart it.
