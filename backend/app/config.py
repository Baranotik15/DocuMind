from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://documind:documind@localhost:5432/documind"
    database_url_sync: str = "postgresql+psycopg://documind:documind@localhost:5432/documind"
    celery_broker_url: str = "redis://localhost:6379/0"

    openai_api_key: str = ""
    # Separate from openai_api_key above - an org-level Admin key that can
    # read organization usage/billing (GET /organization/costs) but cannot
    # make chat/embeddings calls, and vice versa for openai_api_key. Optional:
    # only powers the Dashboard's OpenAI spend summary (see
    # routers/dashboard.py's get_openai_spend); empty means that panel just
    # reports {"configured": false}, same "gracefully does nothing without
    # it" convention as openai_api_key itself (see .env.example).
    openai_admin_api_key: str = ""
    openai_embedding_model: str = "text-embedding-3-small"
    openai_chat_model: str = "gpt-4o-mini"
    chat_retrieval_top_k: int = 5

    storage_base_dir: str = "./data/documents"
    # Rejected with 413 before the file is written anywhere - enforced by
    # reading the upload in bounded chunks (see documents/router.py), not
    # by trusting a client-supplied Content-Length.
    max_upload_size_bytes: int = 10 * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
