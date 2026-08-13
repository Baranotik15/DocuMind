from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 5434, not Postgres's default 5432 - see docker-compose.yml's postgres
    # service comment: this dev machine also runs two native Windows
    # PostgreSQL services on 5432/5433, unrelated to this project, which
    # win those ports over Docker's forwarder for host-side connections
    # (inside containers this doesn't matter - backend/worker reach
    # Postgres via the compose network at postgres:5432 regardless of
    # this host mapping).
    database_url: str = "postgresql+asyncpg://documind:documind@localhost:5434/documind"
    database_url_sync: str = "postgresql+psycopg://documind:documind@localhost:5434/documind"
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

    # Fixed session lifetime in hours, measured from creation (see
    # app/auth/router.py) - no sliding/renewal-on-activity behavior.
    session_ttl_hours: int = 24
    # Whether the `session` cookie is marked Secure (HTTPS-only). False for
    # now: the dev stack runs over plain http on both localhost:5173 and
    # localhost:8000, and a Secure cookie would silently never be sent in
    # that setup. Flip this to True once the app runs behind real HTTPS.
    session_cookie_secure: bool = False

    # Slack bot integration (see app/slack/) - SLACK_SIGNING_SECRET verifies
    # incoming webhook requests are really from Slack (app/slack/signature.py),
    # SLACK_BOT_TOKEN authenticates the outbound chat.postMessage reply call
    # (app/slack/service.py). Both come from api.slack.com/apps - see
    # .env.example. Empty defaults mean an unconfigured deployment simply
    # fails signature verification (401) rather than crashing at import time.
    slack_bot_token: str = ""
    slack_signing_secret: str = ""

    # Absolute or CWD-relative path to an unzipped Vosk model directory (e.g.
    # "./data/vosk_models/vosk-model-small-ru-0.22") - operator-installed, never
    # bundled with the app (see backend/data/vosk_models/, .gitignore'd, and the
    # README's voice-recognition setup section). Empty (default) means voice
    # input is unconfigured - app/chat/voice.py's _get_model() is what actually
    # enforces "gracefully unavailable, not a crash" for that, same convention as
    # openai_api_key/slack_bot_token above.
    vosk_model_path: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
