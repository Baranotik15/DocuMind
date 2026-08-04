import uuid

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.routers import chat, dashboard, documents
from app.worker.tasks import run_smoke_job


def create_app() -> FastAPI:
    app = FastAPI(title="DocuMind")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(documents.router, prefix="/internal")
    app.include_router(chat.router, prefix="/internal")
    app.include_router(dashboard.router, prefix="/internal")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/internal/db-check")
    async def db_check(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
        await session.execute(text("SELECT 1"))
        return {"db": "ok"}

    @app.post("/internal/smoke-job")
    async def create_smoke_job(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
        job_id = uuid.uuid4()
        await session.execute(
            text("INSERT INTO smoke_jobs (id) VALUES (:job_id)"), {"job_id": job_id}
        )
        await session.commit()
        run_smoke_job.delay(str(job_id))
        return {"job_id": str(job_id)}

    @app.get("/internal/smoke-job/{job_id}")
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

    return app


app = create_app()
