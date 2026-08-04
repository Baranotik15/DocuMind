from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.router import router as chat_router
from app.chunks.router import router as chunks_router
from app.dashboard.router import router as dashboard_router
from app.dashboard_events.router import router as dashboard_events_router
from app.db.session import get_session
from app.documents.router import router as documents_router
from app.smoke_jobs.router import router as smoke_jobs_router


def create_app() -> FastAPI:
    app = FastAPI(title="DocuMind")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(documents_router, prefix="/internal")
    app.include_router(chunks_router, prefix="/internal")
    app.include_router(chat_router, prefix="/internal")
    app.include_router(dashboard_router, prefix="/internal")
    app.include_router(dashboard_events_router, prefix="/internal")
    app.include_router(smoke_jobs_router, prefix="/internal")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/internal/db-check")
    async def db_check(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
        await session.execute(text("SELECT 1"))
        return {"db": "ok"}

    return app


app = create_app()
