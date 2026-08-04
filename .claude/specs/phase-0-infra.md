# Phase 0: Local Infrastructure Foundation

## Goal
Stand up a local, Docker-composed foundation for the RAG documentation app —
independently deployable backend, worker, and frontend services backed by
Postgres — structured so each service maps 1:1 onto an AWS deployment unit
later without rework.

## Requirements
- `docker compose up` brings up the full local stack: Postgres (pgvector
  extension enabled), a message broker for background jobs, a backend API
  service, a background worker service, and a frontend service.
- Backend, worker, and frontend are separate services with their own
  Dockerfiles/images, buildable and deployable independently (backend:
  FastAPI, worker: Celery, frontend: React + Mantine, per prior architecture
  decisions).
- All persistent application data (documents, chunks, embeddings, chat
  history, dislike feedback, event logs) lives in one Postgres instance.
- Background jobs (document parsing, chunking, embedding generation) run in
  the worker service, never inline in API request handlers.
- Workers do not depend on the broker for storing task outcomes — task
  status/results are persisted directly to Postgres. The broker is a pure
  message-transport concern, nothing else.
- The message broker must be swappable (Redis now, RabbitMQ later if needed)
  via configuration and infrastructure changes only — no changes to
  worker/task business logic.
- Uploaded document files sit behind a storage abstraction so the backing
  store (local disk now, object storage later) can change without touching
  business logic.

## Acceptance Criteria
- [ ] `docker compose up` starts postgres, broker, backend, worker, and
      frontend, and all report healthy.
- [ ] Postgres has the pgvector extension enabled via migration.
- [ ] A round-trip smoke job (enqueued by backend, processed by worker, status
      visible in Postgres) succeeds without ever querying the broker for
      status.
- [ ] Swapping the broker (Redis → RabbitMQ) requires only a connection-string
      change plus a docker-compose service swap — verified by following
      `.claude/docs/broker-migration.md` against a disposable local stack with
      zero diffs to backend/worker application code.
- [ ] Swapping the file storage backend (local disk → S3-compatible) requires
      changes only inside the storage-adapter implementation, never its
      callers.

## Non-Goals
- Actually migrating the broker to RabbitMQ — deferred until after Phases 1-3
  ship on Redis. Tracked as a runbook (`.claude/docs/broker-migration.md`),
  not executed in Phase 0.
- Provisioning real AWS infrastructure — Phase 0 only shapes the local Docker
  foundation to map cleanly onto AWS later.
- Authentication/authorization — specified separately in
  `.claude/specs/auth.md` (session-based, own feature branch); Phase 0 only
  needs to avoid precluding it, not implement it.
- Field-level schema for documents/chunks/chat/feedback — that's a planning
  concern for the phases that introduce them (Phase 1: upload/chunks, Phase
  2: chat), not Phase 0.

## Open Questions
- None blocking Phase 0 start. DB schema details, API routes, and UI layout
  are deferred to their respective phase plans.
