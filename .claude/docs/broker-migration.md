# Broker Migration Runbook: Redis → RabbitMQ

## Context

Phase 0 ships with **Redis** as the Celery broker — simplest service to run
locally, and it can double as a cache later if ever needed. This is a
deliberate deferral, not an open decision: migrate to **RabbitMQ** only after
Phases 1-3 are stable, and only if a concrete need shows up (stronger
delivery guarantees via ack/nack and dead-letter queues, priority queues
across multiple independent workers, or an operational reason to run Amazon
MQ on AWS).

## Why the swap stays cheap

Celery abstracts the broker through kombu; task code never talks to Redis or
RabbitMQ directly. Two disciplines enforced from Phase 0 keep the eventual
swap config-only:

1. The Celery result backend is unused (`task_ignore_result=True`). Tasks
   write their own outcome (status, results) directly to Postgres — e.g.
   `documents.status`, `chunks.embedding` — never through the broker.
2. No Redis-specific broker tuning (priority emulation,
   `broker_transport_options`) is relied on by task logic.

As long as both hold, Redis serves only as message transport and nothing
else, so removing it is a pure infra/config change.

## Migration steps

1. Add a `rabbitmq` service to `docker-compose.yml` (image
   `rabbitmq:3-management`).
2. Change `CELERY_BROKER_URL` for the `backend` and `worker` services from
   `redis://redis:6379/0` to `amqp://<user>:<pass>@rabbitmq:5672//`.
3. Rebuild/restart `backend` and `worker` — no application code changes
   expected.
4. Re-run the Phase 0 smoke job (enqueue → process → status lands in
   Postgres) to confirm parity.
5. Remove the `redis` service and its env vars/dependencies from compose and
   docs — unless Redis is independently kept for an unrelated purpose (e.g.
   caching or chat pub/sub), which is a separate decision from its broker
   role.

## AWS mapping

| Local (Docker) | AWS |
|---|---|
| `redis` service (current) | ElastiCache Redis |
| `rabbitmq` service (post-migration) | Amazon MQ (managed RabbitMQ) |

## Rollback

Revert steps 1-3 (env var + compose service swap). No data migration is
needed, since task outcomes never lived in the broker to begin with.
