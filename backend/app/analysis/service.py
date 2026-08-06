import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from openai import AsyncOpenAI
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.analysis.candidates import find_conflict_candidates

# Reused, not duplicated - see app.chunks.embedding's own docstring for why
# LLMError/get_client live there rather than being copy-pasted per module
# that talks to the OpenAI SDK.
from app.chunks.embedding import LLMError, get_client
from app.config import get_settings
from app.dashboard_events.constants import DashboardEventType
from app.dashboard_events.recording import record_event_sync
from app.db.session import async_session_factory, engine
from app.db.sync_session import SyncSessionLocal

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


class AnalysisReportNotFoundError(Exception):
    """Raised by run_full_analysis when `report_id` matches no
    analysis_reports row - should never happen in practice (Task 4's
    start_analysis_run INSERTs the row and commits before ever dispatching
    the Celery task that eventually calls this function), so this is
    deliberately NOT funneled through the "mark the row failed" handling
    the rest of this function uses below: there is no row left to update
    and no started_by_email to attribute a dashboard event to. Mirrors
    documents.tasks.run_document_pipeline's own DocumentNotFoundError,
    raised for the same "the row that should exist doesn't" reason."""


# Every distinct question (chat_messages.content) behind a disliked=true or
# no_answer_found=true assistant reply, via the same question_id JOIN
# chat/router.py's list_disliked_messages/list_no_answer_messages already
# run - the "range=all" equivalent (no lower-bound cutoff), since a run
# always analyzes the full current backlog, not a trailing window. A plain
# JOIN (not chat/router.py's LEFT JOIN) is deliberate here: a disliked/
# no-answer row with no resolvable question_id has no question text to feed
# the gap-analysis prompt, so it's correctly excluded rather than
# contributing a NULL/placeholder entry.
_GAP_ANALYSIS_QUESTIONS_QUERY = text(
    "SELECT DISTINCT questions.content "
    "FROM chat_messages AS messages "
    "JOIN chat_messages AS questions ON questions.id = messages.question_id "
    "WHERE messages.disliked = true OR messages.no_answer_found = true"
)


def _fetch_gap_analysis_questions(session: Session) -> list[str]:
    rows = session.execute(_GAP_ANALYSIS_QUESTIONS_QUERY).all()
    return [row.content for row in rows]


def _conflict_dict(row, result: ConflictCheckResult) -> dict:
    """One AnalysisConflict-shaped (see router.py's schemas.py) JSON object
    for a candidate pair check_conflict judged a genuine conflict -
    snapshotting both chunks' id/content/filename/document id exactly as
    find_conflict_candidates read them at analysis time, matching
    analysis_reports.conflicts' own "permanent historical snapshot"
    contract (see the 0008 migration's column comment) - these values are
    never re-read from `chunks` later, so a report stays readable even if
    the underlying chunks are since edited or deleted."""
    return {
        "documentAId": str(row.document_a_id),
        "documentAFilename": row.document_a_filename,
        "chunkAId": str(row.chunk_a_id),
        "chunkAContent": row.chunk_a_content,
        "documentBId": str(row.document_b_id),
        "documentBFilename": row.document_b_filename,
        "chunkBId": str(row.chunk_b_id),
        "chunkBContent": row.chunk_b_content,
        "description": result.description,
    }


def _build_analysis_run_detail(total_tokens: int) -> str:
    """The dashboard_events `detail` string for ANALYSIS_RUN_COMPLETED
    (ANALYSIS_RUN_FAILED uses str(exc) instead, not this). Same
    "tokens spend" key text as documents/formatting.py's
    build_document_event_detail - that one counts embedding tokens, this
    one counts LLM completion tokens, two different metrics that
    deliberately share a label; the event card's own type/heading is what
    tells them apart, not the detail line."""
    return f"tokens spend = {total_tokens}"


async def run_full_analysis(report_id: str) -> None:
    """The complete async analysis pipeline for one analysis_reports row,
    invoked from tasks.py's Celery task via asyncio.run() (same
    sync-task-wraps-async-work bridge documents/pipeline.py's run_pipeline
    already uses for its own embed_texts call). Uses SyncSessionLocal (this
    runs inside a Celery worker, same as documents/tasks.py) for every read/
    write of the analysis_reports/chat_messages rows - the one exception is
    find_conflict_candidates below, whose Task 2 contract fixes it to an
    AsyncSession (mirroring chunks/retrieval.py's own pgvector-search
    convention), so this function opens one short-lived AsyncSession
    (app.db.session.async_session_factory) just for that call.

    Steps:
    1. Read the report row's started_by_email (needed for the dashboard
       event either way below) - raises AnalysisReportNotFoundError if the
       row doesn't exist (see that exception's own docstring for why this
       one case is not funneled through step 2-6's failure handling).
    2. Fetch every Dislikes + No Answer question's text (the same
       disliked=true / no_answer_found=true / question_id-joined query
       chat/router.py's list_disliked_messages/list_no_answer_messages
       already run, range=all equivalent) and pass the combined question
       text to run_gap_analysis.
    3. Fetch conflict candidates via find_conflict_candidates, then call
       check_conflict on every candidate CONCURRENTLY (asyncio.gather) -
       bounded by MAX_CONFLICT_CANDIDATES from candidates.py, so this is
       never more than that many concurrent requests. Keep only the pairs
       where is_conflict is True.
    4. Sum every call's tokens_used (the gap-analysis call plus every
       conflict-check call, whether or not that pair turned out to
       conflict) into one total.
    5. UPDATE the analysis_reports row: status='completed',
       gap_analysis=<step 2's content>, conflicts=<step 3's kept pairs, as
       the JSON shape Task 4's AnalysisConflict schema defines - an empty
       JSON array, never NULL, if none were kept>, total_tokens=<step 4's
       sum>, completed_at=now(). Commit.
    6. record_event_sync(session, DashboardEventType.ANALYSIS_RUN_COMPLETED,
       <detail text including the token count>, user_email=<step 1's
       email>). Commit.

    Steps 2-6 all run inside one try/except Exception: ANY exception raised
    anywhere in that range (an LLM failure, a DB error on the final UPDATE,
    anything) is caught here, and this function still: UPDATEs the row to
    status='failed', error_detail=str(exception), completed_at=now(),
    commits, THEN records one DashboardEventType.ANALYSIS_RUN_FAILED
    dashboard_event (same "every run gets exactly one log entry" guarantee
    as documents/pipeline.py's mark_document_failed) before returning -
    this function must never let an exception escape to the Celery task
    that calls it."""
    with SyncSessionLocal() as session:
        report_row = session.execute(
            text("SELECT started_by_email FROM analysis_reports WHERE id = :report_id"),
            {"report_id": report_id},
        ).one_or_none()
    if report_row is None:
        raise AnalysisReportNotFoundError(report_id)
    user_email = report_row.started_by_email

    try:
        with SyncSessionLocal() as session:
            questions = _fetch_gap_analysis_questions(session)
        gap_result = await run_gap_analysis(questions)

        # Same root cause as tests/conftest.py's own _dispose_engine_after_test
        # fixture (see its comment): the async engine's connection pool is a
        # module-level singleton bound to whichever event loop first used it.
        # run_full_analysis runs inside a FRESH event loop every time (one
        # asyncio.run() per Celery task execution, see tasks.py) - without
        # disposing here, a connection pooled from THIS run's loop survives
        # into the pool and gets handed to the NEXT run's (different) loop,
        # which raises "got Future ... attached to a different loop" the
        # instant that stale connection is actually used (confirmed live:
        # reproduced in isolation with two bare asyncio.run() calls sharing
        # this same engine, fixed by disposing between them). The `finally`
        # covers a find_conflict_candidates failure too, not just the happy
        # path - any exception here still leaves a connection checked out
        # that must not survive into the next run's loop.
        try:
            async with async_session_factory() as async_session:
                candidate_rows = await find_conflict_candidates(async_session)
        finally:
            await engine.dispose()

        check_results = await asyncio.gather(
            *(
                check_conflict(row.chunk_a_content, row.chunk_b_content)
                for row in candidate_rows
            )
        )

        total_tokens = gap_result.tokens_used + sum(
            result.tokens_used for result in check_results
        )
        conflicts = [
            _conflict_dict(row, result)
            for row, result in zip(candidate_rows, check_results)
            if result.is_conflict
        ]

        with SyncSessionLocal() as session:
            session.execute(
                text(
                    "UPDATE analysis_reports SET status = :status, "
                    "gap_analysis = :gap_analysis, conflicts = :conflicts ::jsonb, "
                    "total_tokens = :total_tokens, completed_at = :completed_at "
                    "WHERE id = :report_id"
                ),
                {
                    "status": "completed",
                    "gap_analysis": gap_result.content,
                    "conflicts": json.dumps(conflicts),
                    "total_tokens": total_tokens,
                    "completed_at": datetime.now(timezone.utc),
                    "report_id": report_id,
                },
            )
            session.commit()

            record_event_sync(
                session,
                DashboardEventType.ANALYSIS_RUN_COMPLETED,
                _build_analysis_run_detail(total_tokens),
                user_email=user_email,
            )
            session.commit()
    except Exception as exc:
        with SyncSessionLocal() as session:
            session.execute(
                text(
                    "UPDATE analysis_reports SET status = :status, "
                    "error_detail = :error_detail, completed_at = :completed_at "
                    "WHERE id = :report_id"
                ),
                {
                    "status": "failed",
                    "error_detail": str(exc),
                    "completed_at": datetime.now(timezone.utc),
                    "report_id": report_id,
                },
            )
            session.commit()

            record_event_sync(
                session,
                DashboardEventType.ANALYSIS_RUN_FAILED,
                str(exc),
                user_email=user_email,
            )
            session.commit()
    finally:
        # Same class of bug as the engine.dispose() above, different
        # resource: get_client() is @lru_cache'd (app/chunks/embedding.py),
        # so the SAME AsyncOpenAI instance - and its underlying httpx
        # connection pool - survives across separate run_full_analysis
        # calls in this same worker process. httpx keeps idle keep-alive
        # connections open after a request, bound to the loop that made it;
        # a LATER asyncio.run() call (a fresh loop) reusing one of those
        # crashes with "RuntimeError: Event loop is closed" the moment
        # httpx tries to close/reuse it (confirmed live: reproduced in
        # isolation with a gap-analysis-call + concurrent-gather shape
        # matching this function's own steps 2-3, exactly what surfaced
        # this in production - a single simple call per run did NOT
        # reproduce it, only concurrent usage leaving multiple pooled
        # connections did). `.close()` makes the client permanently unusable
        # (per its own docstring), so cache_clear() is required too -
        # without it, get_client() would keep handing back the now-closed
        # instance forever instead of constructing a fresh one next call.
        # The cache_info().currsize guard matters for tests: this codebase's
        # tests mock run_gap_analysis/check_conflict directly rather than
        # get_client() itself, so get_client() is never actually called
        # (nothing cached, currsize == 0) when those are mocked - calling it
        # unconditionally here would construct a real AsyncOpenAI() and
        # crash on missing credentials in a test environment that has none.
        if get_client.cache_info().currsize > 0:
            await get_client().close()
            get_client.cache_clear()
