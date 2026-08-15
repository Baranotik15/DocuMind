from collections.abc import AsyncIterator
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


@dataclass
class StreamingReplyResult:
    """Mutable result populated by generate_reply_stream as it consumes the
    OpenAI stream - read AFTER the async generator it returns is fully
    exhausted (an async generator's yielded values are the only thing
    `async for` exposes; there's no ergonomic way to also get a return
    value out of one, hence this out-parameter style instead)."""

    content: str = ""
    no_answer_found: bool = False


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


async def generate_reply_stream(
    user_message: str,
    context_chunks: list[str],
    result: StreamingReplyResult,
    client: AsyncOpenAI | None = None,
) -> AsyncIterator[str]:
    """Streaming counterpart to generate_reply - same
    get_settings().openai_chat_model/messages construction via
    _build_system_prompt, same LLMError-on-any-SDK-failure contract
    (including a failure partway through iteration). Calls
    active_client.chat.completions.create(..., stream=True) and yields each
    chunk's delta content as it arrives.

    Buffers incoming deltas locally until it has at least
    len(NO_ANSWER_MARKER) characters (or the stream ends first - a valid
    short reply, not an error). Checks whether that buffered prefix EQUALS
    NO_ANSWER_MARKER: if so, sets result.no_answer_found = True, drops the
    marker plus any immediately-following whitespace (matching
    _parse_reply's .lstrip()) without ever yielding it, and streams
    everything after normally; if not, yields the buffered prefix as-is
    first, then continues streaming normally. Every piece actually yielded
    is also appended to result.content, so result.content holds the exact
    final reply text once exhausted - see this plan's design notes for why
    the caller relies on that instead of resending the full text later."""
    messages = [
        {"role": "system", "content": _build_system_prompt(context_chunks)},
        {"role": "user", "content": user_message},
    ]
    buffer = ""
    threshold_reached = False
    stripping_leading_whitespace = False
    try:
        active_client = client if client is not None else get_client()
        stream = await active_client.chat.completions.create(
            model=get_settings().openai_chat_model,
            messages=messages,
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if not delta:
                continue

            if not threshold_reached:
                buffer += delta
                if len(buffer) < len(NO_ANSWER_MARKER):
                    continue
                threshold_reached = True
                if buffer.startswith(NO_ANSWER_MARKER):
                    result.no_answer_found = True
                    remainder = buffer[len(NO_ANSWER_MARKER) :].lstrip()
                    buffer = ""
                    if remainder:
                        result.content += remainder
                        yield remainder
                    else:
                        stripping_leading_whitespace = True
                    continue
                piece = buffer
                buffer = ""
                result.content += piece
                yield piece
                continue

            if stripping_leading_whitespace:
                delta = delta.lstrip()
                if not delta:
                    continue
                stripping_leading_whitespace = False

            result.content += delta
            yield delta
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(f"Failed to generate reply: {exc}") from exc

    if not threshold_reached and buffer:
        result.content += buffer
        yield buffer


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
