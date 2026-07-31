from celery import Celery

from app.config import get_settings

celery_app = Celery("documind", broker=get_settings().celery_broker_url)
# Task outcomes are written to Postgres by the task itself (see app.tasks),
# never read back from the broker - keeps the broker swappable later
# (see .claude/docs/broker-migration.md).
celery_app.conf.task_ignore_result = True
