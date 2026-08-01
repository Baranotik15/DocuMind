from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://documind:documind@localhost:5432/documind"
    database_url_sync: str = "postgresql+psycopg://documind:documind@localhost:5432/documind"
    celery_broker_url: str = "redis://localhost:6379/0"

    openai_api_key: str = ""
    openai_embedding_model: str = "text-embedding-3-small"
    openai_chat_model: str = "gpt-4o-mini"
    chat_retrieval_top_k: int = 5

    storage_base_dir: str = "./data/documents"


@lru_cache
def get_settings() -> Settings:
    return Settings()
