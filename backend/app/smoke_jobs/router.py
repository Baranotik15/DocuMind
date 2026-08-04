import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.smoke_jobs.tasks import run_smoke_job

router = APIRouter()


@router.post("/smoke-job")
async def create_smoke_job(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    job_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO smoke_jobs (id) VALUES (:job_id)"), {"job_id": job_id}
    )
    await session.commit()
    run_smoke_job.delay(str(job_id))
    return {"job_id": str(job_id)}


@router.get("/smoke-job/{job_id}")
async def get_smoke_job(
    job_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, str]:
    result = await session.execute(
        text("SELECT status FROM smoke_jobs WHERE id = :job_id"), {"job_id": job_id}
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="smoke job not found")
    return {"status": row.status}
