from dataclasses import dataclass
from pathlib import Path

from openai import AsyncOpenAI

from app.chunks.embedding import LLMError, get_client
from app.config import get_settings

_PROMPTS_DIR = Path(__file__).parent / "prompts"
CHAT_SYSTEM_PROMPT = (_PROMPTS_DIR / "chat_system_prompt.txt").read_text().strip()

# Hidden signal only - never shown to a user, always stripped before the
# reply text is persisted or returned. Must be something a normal answer
# would never start with by coincidence.
NO_ANSWER_MARKER = "[[NO_ANSWER]]"


@dataclass(frozen=True)
class GeneratedReply:
    content: str
    no_answer_found: bool


async def generate_reply(
    user_message: str, context_chunks: list[str], client: AsyncOpenAI | None = None
) -> GeneratedReply:
    """Calls get_settings().openai_chat_model with `context_chunks`
    included as context (e.g. a system message listing them) plus
    `user_message`, returns a GeneratedReply built from the completion
    text (see _parse_reply for how the NO_ANSWER_MARKER prefix is
    detected/stripped). Raises LLMError on any SDK failure. Empty
    `context_chunks` is valid (empty-corpus case) - the call proceeds
    without retrieved context. Same call/error contract as before (LLMError
    on any SDK failure or empty/None content)."""
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
    return _parse_reply(content)


def _parse_reply(raw_content: str) -> GeneratedReply:
    """If raw_content starts with NO_ANSWER_MARKER, strips it (and any
    leading whitespace/newline right after it) and returns
    GeneratedReply(content=<stripped>, no_answer_found=True). Otherwise
    returns GeneratedReply(content=raw_content, no_answer_found=False)
    unchanged. Only a literal prefix counts - a reply that merely mentions
    the marker somewhere in the middle is passed through unchanged."""
    if raw_content.startswith(NO_ANSWER_MARKER):
        stripped = raw_content[len(NO_ANSWER_MARKER) :].lstrip()
        return GeneratedReply(content=stripped, no_answer_found=True)
    return GeneratedReply(content=raw_content, no_answer_found=False)


def _build_system_prompt(context_chunks: list[str]) -> str:
    if not context_chunks:
        return f"{CHAT_SYSTEM_PROMPT}\n\nNo document context is available for this question."
    joined = "\n\n".join(context_chunks)
    return f"{CHAT_SYSTEM_PROMPT}\n\nDocument context:\n\n{joined}"
