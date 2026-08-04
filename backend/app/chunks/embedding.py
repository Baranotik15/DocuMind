from functools import lru_cache

from openai import AsyncOpenAI

from app.config import get_settings


class LLMError(Exception):
    """Wraps any OpenAI SDK failure from embed_texts (chunks/embedding.py)
    or generate_reply (chat/completion.py) so callers never need to catch
    the SDK's own exception types."""


@lru_cache
def get_client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def embed_texts(
    texts: list[str], client: AsyncOpenAI | None = None
) -> list[list[float]]:
    """Embeds `texts` via get_settings().openai_embedding_model, in one
    batched API call, returning vectors in the same order as `texts`.
    Raises LLMError on any SDK failure. `client` defaults to get_client()
    - tests inject a fake."""
    try:
        active_client = client if client is not None else get_client()
        response = await active_client.embeddings.create(
            model=get_settings().openai_embedding_model,
            input=texts,
        )
    except Exception as exc:
        raise LLMError(f"Failed to embed texts: {exc}") from exc
    return [item.embedding for item in response.data]
