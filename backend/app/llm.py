from functools import lru_cache

from openai import AsyncOpenAI

from app.config import get_settings


class LLMError(Exception):
    """Wraps any OpenAI SDK failure from embed_texts/generate_reply so
    callers never need to catch the SDK's own exception types."""


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
    active_client = client if client is not None else get_client()
    try:
        response = await active_client.embeddings.create(
            model=get_settings().openai_embedding_model,
            input=texts,
        )
    except Exception as exc:
        raise LLMError(f"Failed to embed texts: {exc}") from exc
    return [item.embedding for item in response.data]


async def generate_reply(
    user_message: str, context_chunks: list[str], client: AsyncOpenAI | None = None
) -> str:
    """Calls get_settings().openai_chat_model with `context_chunks`
    included as context (e.g. a system message listing them) plus
    `user_message`, returns the completion text. Raises LLMError on any
    SDK failure. Empty `context_chunks` is valid (empty-corpus case) - the
    call proceeds without retrieved context."""
    active_client = client if client is not None else get_client()
    messages = [
        {"role": "system", "content": _build_system_prompt(context_chunks)},
        {"role": "user", "content": user_message},
    ]
    try:
        response = await active_client.chat.completions.create(
            model=get_settings().openai_chat_model,
            messages=messages,
        )
    except Exception as exc:
        raise LLMError(f"Failed to generate reply: {exc}") from exc
    return response.choices[0].message.content


def _build_system_prompt(context_chunks: list[str]) -> str:
    if not context_chunks:
        return "You are a helpful assistant. No document context is available."
    joined = "\n\n".join(context_chunks)
    return (
        "You are a helpful assistant. Use the following document excerpts "
        f"as context when answering the user's question:\n\n{joined}"
    )
