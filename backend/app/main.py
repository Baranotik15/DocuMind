from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.analysis.router import router as analysis_router
from app.auth.dependencies import require_session
from app.auth.router import router as auth_router
from app.chat.router import router as chat_router
from app.chunks.router import router as chunks_router
from app.dashboard.router import router as dashboard_router
from app.dashboard_events.router import router as dashboard_events_router
from app.db.session import get_session
from app.documents.router import router as documents_router
from app.slack.router import router as slack_router
from app.smoke_jobs.router import router as smoke_jobs_router


def create_app() -> FastAPI:
    app = FastAPI(title="DocuMind")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth_router, prefix="/internal")
    # Slack calls this endpoint directly (webhook), with no admin session
    # cookie - it authenticates via its own request-signature scheme
    # instead (see app/slack/signature.py), so it's mounted the same way as
    # auth_router above: outside/before the require_session loop below.
    app.include_router(slack_router, prefix="/internal")
    # Every other router requires a session - looped rather than six
    # near-identical include_router(..., prefix="/internal",
    # dependencies=[Depends(require_session)]) calls, so a router added
    # here later can't accidentally be pasted in without the guard.
    for router in (
        documents_router,
        chunks_router,
        chat_router,
        dashboard_router,
        dashboard_events_router,
        smoke_jobs_router,
        analysis_router,
    ):
        app.include_router(router, prefix="/internal", dependencies=[Depends(require_session)])

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/internal/db-check")
    async def db_check(
        session: AsyncSession = Depends(get_session),
        _email: str = Depends(require_session),
    ) -> dict[str, str]:
        await session.execute(text("SELECT 1"))
        return {"db": "ok"}

    return app


app = create_app()
