from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session


def create_app() -> FastAPI:
    app = FastAPI(title="DocuMind")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/internal/db-check")
    async def db_check(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
        await session.execute(text("SELECT 1"))
        return {"db": "ok"}

    return app


app = create_app()
