from pathlib import Path

from openai import AsyncOpenAI

from app.chunks.embedding import LLMError, get_client
from app.config import get_settings

_PROMPTS_DIR = Path(__file__).parent / "prompts"
CHAT_SYSTEM_PROMPT = (_PROMPTS_DIR / "chat_system_prompt.txt").read_text().strip()


async def generate_reply(
    user_message: str, context_chunks: list[str], client: AsyncOpenAI | None = None
) -> str:
    """Calls get_settings().openai_chat_model with `context_chunks`
    included as context (e.g. a system message listing them) plus
    `user_message`, returns the completion text. Raises LLMError on any
    SDK failure. Empty `context_chunks` is valid (empty-corpus case) - the
    call proceeds without retrieved context."""
    messages = [
        {"role": "system", "content": _build_system_prompt(context_chunks)},
        {"role": "user", "content": user_message},
    ]
    try:
        active_client = client if client is not None else get_client()
        response = await active_client.chat.completions.create(
            model=get_settings().openai_chat_model,
            messages=messages,
        )
        # Both read inside the try: an empty `choices` (IndexError) or a
        # `None` content (a real OpenAI response shape, e.g. a content-
        # filter refusal) must become the same LLMError/502 contract as an
        # outright SDK failure, not an unhandled 500 or a `None` silently
        # flowing into chat_messages.content, a NOT NULL column.
        content = response.choices[0].message.content
        if content is None:
            raise LLMError("Chat completion returned no content")
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(f"Failed to generate reply: {exc}") from exc
    return content


def _build_system_prompt(context_chunks: list[str]) -> str:
    if not context_chunks:
        return f"{CHAT_SYSTEM_PROMPT}\n\nNo document context is available for this question."
    joined = "\n\n".join(context_chunks)
    return f"{CHAT_SYSTEM_PROMPT}\n\nDocument context:\n\n{joined}"
