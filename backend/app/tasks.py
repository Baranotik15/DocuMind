from datetime import datetime, timezone

from sqlalchemy import text

from app.celery_app import celery_app
from app.db_sync import SyncSessionLocal


class SmokeJobNotFoundError(Exception):
    pass


@celery_app.task(name="run_smoke_job")
def run_smoke_job(job_id: str) -> None:
    with SyncSessionLocal() as session:
        result = session.execute(
            text(
                "UPDATE smoke_jobs SET status = 'done', completed_at = :completed_at "
                "WHERE id = :job_id"
            ),
            {"completed_at": datetime.now(timezone.utc), "job_id": job_id},
        )
        if result.rowcount == 0:
            raise SmokeJobNotFoundError(job_id)
        session.commit()
