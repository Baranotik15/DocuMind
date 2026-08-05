from celery import Celery

from app.config import get_settings

celery_app = Celery(
    "documind",
    broker=get_settings().celery_broker_url,
    include=["app.documents.tasks", "app.smoke_jobs.tasks", "app.analysis.tasks"],
)
# Task outcomes are written to Postgres by the task itself (see
# app.documents.tasks/app.smoke_jobs.tasks), never read back from the
# broker - keeps the broker swappable later (see
# .claude/docs/broker-migration.md).
celery_app.conf.task_ignore_result = True
