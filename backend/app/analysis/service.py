from dataclasses import dataclass
from pathlib import Path

from openai import AsyncOpenAI

# Reused, not duplicated - see app.chunks.embedding's own docstring for why
# LLMError/get_client live there rather than being copy-pasted per module
# that talks to the OpenAI SDK.
from app.chunks.embedding import LLMError, get_client
from app.config import get_settings

_PROMPTS_DIR = Path(__file__).parent / "prompts"
GAP_ANALYSIS_PROMPT = (_PROMPTS_DIR / "gap_analysis_prompt.txt").read_text().strip()
CONFLICT_CHECK_PROMPT = (_PROMPTS_DIR / "conflict_check_prompt.txt").read_text().strip()

# The exact first-line marker check_conflict's prompt instructs the model to
# use - see conflict_check_prompt.txt. Any first line other than this one
# (including "NO_CONFLICT" or anything else) is treated as "no conflict",
# matching the prompt's own fixed-shape contract.
_CONFLICT_MARKER = "CONFLICT"


@dataclass(frozen=True)
class GapAnalysisResult:
    content: str
    tokens_used: int


@dataclass(frozen=True)
class ConflictCheckResult:
    is_conflict: bool
    description: str | None  # None when is_conflict is False
    tokens_used: int


def _build_gap_analysis_user_content(questions: list[str]) -> str:
    """The dynamic half of run_gap_analysis's prompt - the static
    instructions live in GAP_ANALYSIS_PROMPT (sent as the system message);
    this is the user message carrying the actual question data. Empty
    `questions` produces a plain "no questions" line rather than an empty
    string, so the model (and this function's own docstring/tests) always
    has explicit text to react to instead of silently sending nothing."""
    if not questions:
        return "There are no questions to analyze for this run - no Dislikes or No Answer entries were recorded."
    return "\n".join(f"- {question}" for question in questions)


def _build_conflict_check_user_content(chunk_a_content: str, chunk_b_content: str) -> str:
    return (
        "Passage from document A:\n"
        f"{chunk_a_content}\n\n"
        "Passage from document B:\n"
        f"{chunk_b_content}"
    )


async def run_gap_analysis(
    questions: list[str], client: AsyncOpenAI | None = None
) -> GapAnalysisResult:
    """Sends `questions` (every Dislikes + No Answer question's text, see
    service.py's run_full_analysis for the caller) to
    get_settings().openai_chat_model with the prompt in
    prompts/gap_analysis_prompt.txt, asking it to identify recurring
    themes/topics worth adding to the documentation. Reads
    response.usage.total_tokens for tokens_used. Raises LLMError on any
    SDK failure, same contract as chat/completion.py's generate_reply.
    Empty `questions` is valid - the prompt must handle "no data" and
    produce a plain report saying so (see the prompt file and
    .claude/specs/documentation-analysis.md's zero-entries acceptance
    criterion), not an error - so this always calls the LLM, never
    short-circuits locally for an empty list."""
    messages = [
        {"role": "system", "content": GAP_ANALYSIS_PROMPT},
        {"role": "user", "content": _build_gap_analysis_user_content(questions)},
    ]
    try:
        active_client = client if client is not None else get_client()
        response = await active_client.chat.completions.create(
            model=get_settings().openai_chat_model,
            messages=messages,
        )
        content = response.choices[0].message.content
        if content is None:
            raise LLMError("Gap analysis completion returned no content")
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(f"Failed to run gap analysis: {exc}") from exc
    return GapAnalysisResult(content=content, tokens_used=response.usage.total_tokens)


async def check_conflict(
    chunk_a_content: str, chunk_b_content: str, client: AsyncOpenAI | None = None
) -> ConflictCheckResult:
    """Sends both chunks' text to get_settings().openai_chat_model with the
    prompt in prompts/conflict_check_prompt.txt, asking whether they state
    a factual contradiction. The prompt instructs the model to answer in
    one fixed, reliably parseable shape - a first line that's exactly
    "CONFLICT" or "NO_CONFLICT", followed by a description only in the
    CONFLICT case - parsed into is_conflict/description here (see
    _CONFLICT_MARKER). Reads response.usage.total_tokens for tokens_used.
    Raises LLMError on any SDK failure."""
    messages = [
        {"role": "system", "content": CONFLICT_CHECK_PROMPT},
        {
            "role": "user",
            "content": _build_conflict_check_user_content(chunk_a_content, chunk_b_content),
        },
    ]
    try:
        active_client = client if client is not None else get_client()
        response = await active_client.chat.completions.create(
            model=get_settings().openai_chat_model,
            messages=messages,
        )
        content = response.choices[0].message.content
        if content is None:
            raise LLMError("Conflict check completion returned no content")
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(f"Failed to check conflict: {exc}") from exc

    first_line, _, rest = content.partition("\n")
    tokens_used = response.usage.total_tokens
    if first_line.strip() == _CONFLICT_MARKER:
        return ConflictCheckResult(
            is_conflict=True, description=rest.strip(), tokens_used=tokens_used
        )
    return ConflictCheckResult(is_conflict=False, description=None, tokens_used=tokens_used)
