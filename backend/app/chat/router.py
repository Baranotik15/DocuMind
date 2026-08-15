import asyncio
import base64
import json
from datetime import datetime, timedelta, timezone
from uuid import UUID

import sqlalchemy
import vosk
from fastapi import APIRouter, Depends, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import require_session
from app.chat.completion import StreamingReplyResult, generate_reply, generate_reply_stream
from app.chat.constants import ChatChannel, ChatRole
from app.chat.schemas import (
    ChatMessageSummary,
    DislikedMessageSummary,
    ImprovementsRange,
    NoAnswerMessageSummary,
    SendMessageRequest,
    TopChunkSummary,
    TopChunksRequest,
    TranscriptionResult,
    VoiceAudioChunkEvent,
    VoiceErrorEvent,
    VoiceReplyDeltaEvent,
    VoiceReplyDoneEvent,
    VoiceUserMessageEvent,
)
from app.chat.sentence_buffer import SentenceBuffer
from app.chat.voice import (
    AudioConversionError,
    StreamingAudioDecoder,
    TARGET_SAMPLE_RATE_HZ,
    VoiceRecognitionUnavailableError,
    synthesize_speech,
    transcribe_audio,
)
from app.chat.voice import _get_model as get_voice_model  # reused, not duplicated
from app.chunks.embedding import LLMError, embed_texts
from app.chunks.retrieval import fetch_similar_chunks
from app.config import get_settings
from app.db.session import async_session_factory, get_session

router = APIRouter()

TOP_CHUNKS_LIMIT = 5

# Shared by both LLM-call try/except blocks below (send_message's embed +
# chat-completion step, top_chunks's embed step) - same error contract
# either way: any LLMError becomes a 502 with this detail.
_CHAT_COMPLETION_FAILED_ERROR = "chat_completion_failed"

_FILE_TOO_LARGE_ERROR = "file_too_large"
_VOICE_MODEL_NOT_CONFIGURED_ERROR = "voice_model_not_configured"
_AUDIO_PROCESSING_FAILED_ERROR = "audio_processing_failed"

# Local duplicate of documents/router.py's _read_upload_within_limit - see
# this plan's design notes for why this isn't a shared cross-router import.
_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024


async def _read_upload_within_limit(file: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_UPLOAD_READ_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=_FILE_TOO_LARGE_ERROR)
        chunks.append(chunk)
    return b"".join(chunks)

# Trailing-window durations for the Improvements page's `range` query param
# (GET /chat/dislikes, GET /chat/no-answer-messages) - "all" has no entry
# here since it needs no lower bound at all (see _range_cutoff below).
_IMPROVEMENTS_RANGE_WINDOWS: dict[str, timedelta] = {
    "day": timedelta(days=1),
    "7days": timedelta(days=7),
    "30days": timedelta(days=30),
}


def _range_cutoff(range_: ImprovementsRange) -> datetime | None:
    """The lower-bound timestamp for `range_`, or None for "all" (no lower
    bound at all - the caller must skip the WHERE clause's cutoff condition
    entirely in that case, not pass None as a bound param)."""
    window = _IMPROVEMENTS_RANGE_WINDOWS.get(range_)
    if window is None:
        return None
    return datetime.now(timezone.utc) - window


def _message_summary(row) -> ChatMessageSummary:
    return ChatMessageSummary(
        id=str(row.id),
        role=row.role,
        content=row.content,
        disliked=row.disliked,
    )


@router.post("/chat/messages")
async def send_message(
    body: SendMessageRequest, session: AsyncSession = Depends(get_session)
) -> ChatMessageSummary:
    """Persists the user's message, retrieves relevant chunks across the
    corpus of `ready` documents via pgvector similarity search, and calls
    the OpenAI chat completion API for a reply. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 8 for
    the full contract.

    The assistant INSERT below also writes `question_id` (this user row's
    own id) and `no_answer_found` (from generate_reply's returned
    GeneratedReply.no_answer_found). `reply.content` (not a bare string) is
    what gets persisted/returned - the NO_ANSWER_MARKER, if any, was
    already stripped by generate_reply before it ever got here."""
    # 1. Insert + commit the user message immediately, so it's persisted
    # even if everything below fails.
    user_row = (
        await session.execute(
            text(
                "INSERT INTO chat_messages (role, content) VALUES (:role, :content) "
                "RETURNING id"
            ),
            {"role": str(ChatRole.USER), "content": body.content},
        )
    ).one()
    await session.commit()

    # 2-4. Embed the incoming message, run similarity search, and generate
    # the assistant reply. The user message inserted above stays committed
    # even if any of this fails - no assistant row gets written. Both the
    # embedding call (2) and the chat completion call (4) hit the OpenAI
    # client and can raise LLMError, so both are covered by the same
    # handler.
    try:
        # 2. Embed the incoming message (single-text batch call).
        [query_embedding] = await embed_texts([body.content])

        # 3. Similarity search across ready documents' chunks. Empty result
        # is valid (no ready documents yet) - passed through as an empty
        # context list, not special-cased.
        rows = await fetch_similar_chunks(
            session, query_embedding, get_settings().chat_retrieval_top_k
        )
        context_chunks = [row.edited_content for row in rows]

        # 4. Generate the assistant reply.
        reply = await generate_reply(body.content, context_chunks)
    except LLMError:
        raise HTTPException(status_code=502, detail=_CHAT_COMPLETION_FAILED_ERROR)

    # 5. Insert + commit the assistant message. Deliberately NOT recorded
    # as a dashboard_events row - the Logs tab is scoped to actions that
    # change documents/chunks (upload, delete, (re)chunk), and a chat
    # message changes neither. question_id points back at the user row
    # inserted in step 1 above; no_answer_found comes straight from
    # generate_reply's GeneratedReply.
    assistant_row = (
        await session.execute(
            text(
                "INSERT INTO chat_messages (role, content, question_id, no_answer_found) "
                "VALUES (:role, :content, :question_id, :no_answer_found) "
                "RETURNING id, role, content, disliked"
            ),
            {
                "role": str(ChatRole.ASSISTANT),
                "content": reply.content,
                "question_id": str(user_row.id),
                "no_answer_found": reply.no_answer_found,
            },
        )
    ).one()
    await session.commit()

    # 6. Return the assistant message - not the user message (deliberate
    # contract change from the mock, per spec).
    return _message_summary(assistant_row)


@router.get("/chat/messages")
async def list_messages(session: AsyncSession = Depends(get_session)) -> list[ChatMessageSummary]:
    """Returns chat_messages ordered by created_at ascending, scoped to
    channel = 'admin' (the in-app Chat page's own single-threaded
    transcript) - Slack-sourced rows (channel='slack', potentially from
    several unrelated external Slack users) are deliberately excluded
    here, since this admin Chat page UI has no notion of multiple
    simultaneous conversations to interleave them into.

    This is the ONLY chat_messages query scoped by channel - every other
    reader of this table (dashboard stats, the Improvements page's
    dislikes/no-answer lists) deliberately keeps counting/showing across
    ALL channels, since surfacing real Slack-sourced documentation gaps is
    the whole point of the Improvements feature."""
    rows = (
        await session.execute(
            text(
                "SELECT id, role, content, disliked FROM chat_messages "
                "WHERE channel = :channel ORDER BY created_at"
            ),
            {"channel": str(ChatChannel.ADMIN)},
        )
    ).all()
    return [_message_summary(row) for row in rows]


@router.post("/chat/messages/{message_id}/dislike", status_code=204)
async def dislike_message(
    message_id: UUID, session: AsyncSession = Depends(get_session)
) -> None:
    """UPDATE chat_messages SET disliked = NOT disliked WHERE id=:id - a
    toggle, not a one-way flag: each call flips the current value, so a
    second call on the same message undoes the first (guards against
    accidental double-clicks on the frontend's dislike button). Still 204
    with no body either way, and still a no-op (not a 404), if the id
    doesn't exist - deliberately not a 404, unlike other "not found" cases
    elsewhere in this codebase.

    Also stamps `disliked_at = now()` when flipping to disliked=true, and
    clears it back to NULL when flipping to disliked=false - single UPDATE,
    both the toggle and the CASE branch read the OLD (pre-update) value of
    `disliked`, since Postgres evaluates every expression in a single
    UPDATE's SET list against the pre-update row. This is what gives the
    Improvements page's Dislikes list its own time axis, independent of
    when the underlying message was first sent.

    `message_id` is typed as UUID (not str) purely so a malformed id 422s
    via FastAPI's own path-param validation instead of reaching the DB as
    an unhandled 500 - this doesn't change the "well-formed but missing id
    still 204s" behavior described above, it only rejects garbage input
    earlier."""
    await session.execute(
        text(
            "UPDATE chat_messages SET "
            "disliked = NOT disliked, "
            "disliked_at = CASE WHEN disliked THEN NULL ELSE now() END "
            "WHERE id = :id"
        ),
        {"id": str(message_id)},
    )
    await session.commit()


def _disliked_message_summary(row) -> DislikedMessageSummary:
    return DislikedMessageSummary(
        id=str(row.id),
        content=row.content,
        questionContent=row.question_content,
        dislikedAt=row.disliked_at.isoformat(),
        createdAt=row.created_at.isoformat(),
    )


def _no_answer_message_summary(row) -> NoAnswerMessageSummary:
    return NoAnswerMessageSummary(
        id=str(row.id),
        content=row.content,
        questionContent=row.question_content,
        createdAt=row.created_at.isoformat(),
    )


@router.get("/chat/dislikes")
async def list_disliked_messages(
    range: ImprovementsRange, session: AsyncSession = Depends(get_session)
) -> list[DislikedMessageSummary]:
    """Every message with disliked=true and disliked_at within `range`
    (day/7days/30days back from now, or no lower bound at all for "all"),
    newest disliked_at first. LEFT JOINs each row's own question_id back to
    that user message's content for questionContent (NULL if question_id
    itself is NULL - the FK is nullable, though in practice every
    assistant row send_message writes always has one)."""
    cutoff = _range_cutoff(range)
    query = (
        "SELECT messages.id, messages.content, messages.disliked_at, messages.created_at, "
        "questions.content AS question_content "
        "FROM chat_messages AS messages "
        "LEFT JOIN chat_messages AS questions ON questions.id = messages.question_id "
        "WHERE messages.disliked = true"
    )
    params: dict = {}
    if cutoff is not None:
        query += " AND messages.disliked_at >= :cutoff"
        params["cutoff"] = cutoff
    query += " ORDER BY messages.disliked_at DESC"

    rows = (await session.execute(text(query), params)).all()
    return [_disliked_message_summary(row) for row in rows]


@router.get("/chat/no-answer-messages")
async def list_no_answer_messages(
    range: ImprovementsRange, session: AsyncSession = Depends(get_session)
) -> list[NoAnswerMessageSummary]:
    """Every message with no_answer_found=true and created_at within
    `range`, newest created_at first. Same question_id LEFT JOIN as
    list_disliked_messages above."""
    cutoff = _range_cutoff(range)
    query = (
        "SELECT messages.id, messages.content, messages.created_at, "
        "questions.content AS question_content "
        "FROM chat_messages AS messages "
        "LEFT JOIN chat_messages AS questions ON questions.id = messages.question_id "
        "WHERE messages.no_answer_found = true"
    )
    params: dict = {}
    if cutoff is not None:
        query += " AND messages.created_at >= :cutoff"
        params["cutoff"] = cutoff
    query += " ORDER BY messages.created_at DESC"

    rows = (await session.execute(text(query), params)).all()
    return [_no_answer_message_summary(row) for row in rows]


@router.post("/chat/messages/{message_id}/dismiss-no-answer", status_code=204)
async def dismiss_no_answer(
    message_id: UUID, session: AsyncSession = Depends(get_session)
) -> None:
    """UPDATE chat_messages SET no_answer_found = false WHERE id = :id -
    one-way (not a toggle, unlike dislike_message above): there's no UI
    path that re-flags a message as no_answer_found, only the assistant's
    own generation step ever sets it true. Same idempotent-204-even-if-
    missing-id contract as dislike_message - a malformed id still 422s via
    FastAPI's own UUID path-param validation."""
    await session.execute(
        text("UPDATE chat_messages SET no_answer_found = false WHERE id = :id"),
        {"id": str(message_id)},
    )
    await session.commit()


def _top_chunk_summary(row, match_percent: float) -> TopChunkSummary:
    return TopChunkSummary(
        chunkId=str(row.id),
        documentId=str(row.document_id),
        filename=row.filename,
        content=row.edited_content,
        matchPercent=match_percent,
    )


@router.post("/chat/top-chunks")
async def top_chunks(
    body: TopChunksRequest, session: AsyncSession = Depends(get_session)
) -> list[TopChunkSummary]:
    """Read-only diagnostic endpoint for previewing retrieval quality
    without sending a chat message: embeds `body.content` and returns the
    top TOP_CHUNKS_LIMIT chunks (across `ready` documents) most similar to
    it, each annotated with a 0-100 match percentage. Never writes
    anything - no chat_messages row, no dashboard event, no commit.

    Uses a hardcoded TOP_CHUNKS_LIMIT rather than
    `get_settings().chat_retrieval_top_k` deliberately: this is a
    conceptually separate "top 5 preview" feature from chat's own
    retrieval step, and shouldn't silently change if that setting is
    ever tuned differently later, even though both happen to be 5 today.
    """
    try:
        # Same embed-failure error contract as send_message: any LLMError
        # from the OpenAI call becomes a 502.
        [query_embedding] = await embed_texts([body.content])
    except LLMError:
        raise HTTPException(status_code=502, detail=_CHAT_COMPLETION_FAILED_ERROR)

    # Same similarity search as send_message's retrieval step, but also
    # projecting the raw cosine distance so a match percentage can be
    # computed per row. Empty result (no ready documents, or none match)
    # is valid - passed straight through as an empty list, not an error.
    rows = await fetch_similar_chunks(
        session, query_embedding, TOP_CHUNKS_LIMIT, with_distance=True
    )

    return [
        _top_chunk_summary(
            row, round(max(0.0, min(1.0, 1 - row.distance)) * 100, 1)
        )
        for row in rows
    ]


@router.post("/chat/transcribe")
async def transcribe_message(file: UploadFile) -> TranscriptionResult:
    """Accepts one recorded audio clip (any container/codec ffmpeg can
    decode - the browser's MediaRecorder output, in practice), bounded by
    get_settings().max_upload_size_bytes (413 over that, same contract as
    documents' upload endpoint). Runs voice.transcribe_audio in a worker
    thread via asyncio.to_thread (blocking subprocess + CPU-bound Kaldi
    work, not async I/O - would otherwise stall the event loop for the
    whole decode+recognize). No DB write, no dashboard event - see this
    plan's design notes on why this endpoint is stateless.

    Maps VoiceRecognitionUnavailableError -> 503
    _VOICE_MODEL_NOT_CONFIGURED_ERROR, AudioConversionError -> 400
    _AUDIO_PROCESSING_FAILED_ERROR. Session auth is enforced by
    app/main.py's existing router-level `Depends(require_session)` on all of
    chat_router - no per-endpoint user_email param needed since nothing here
    is attributed to a user."""
    data = await _read_upload_within_limit(file, get_settings().max_upload_size_bytes)

    try:
        text_result = await asyncio.to_thread(transcribe_audio, data)
    except VoiceRecognitionUnavailableError:
        raise HTTPException(status_code=503, detail=_VOICE_MODEL_NOT_CONFIGURED_ERROR)
    except AudioConversionError:
        raise HTTPException(status_code=400, detail=_AUDIO_PROCESSING_FAILED_ERROR)

    return TranscriptionResult(text=text_result)


@router.websocket("/chat/voice-session")
async def voice_session(
    websocket: WebSocket,
    user_email: str = Depends(require_session),
) -> None:
    """First WebSocket route in this app - see
    `.claude/plans/2026-08-14-voice-conversation-mode.md`'s "Key design
    decisions" section for the full rationale behind every choice below,
    and `.claude/plans/2026-08-15-voice-conversation-mode-phase-2.md`'s
    own "Key design decisions" section for the barge-in behavior described
    next.

    `Depends(require_session)` is reused as-is (same dependency every other
    `/internal/*` route relies on) - chat_router is ALSO wrapped with
    `dependencies=[Depends(require_session)]` at the app.include_router
    call in app/main.py, so auth is actually enforced twice over (FastAPI
    caches same-callable dependency results per connection, so this costs
    nothing extra); it's declared again here explicitly so `user_email` is
    available to this function, and so this route's own auth story is
    readable without cross-referencing app/main.py. A raised
    HTTPException(401) from this dependency happens BEFORE this function's
    body ever runs (dependencies are solved first) - FastAPI/Starlette
    convert that into a clean pre-accept WebSocket denial response, not a
    server-side crash (verified empirically for this app's exact FastAPI
    version by this route's own test, not just assumed).

    Flow: accepts the connection, resolves the configured Vosk model
    (VoiceErrorEvent + close if VoiceRecognitionUnavailableError - the
    ONLY event send that happens outside send_lock, since nothing else is
    running yet at that point), then runs a receive loop
    (`websocket.receive_bytes()` -> `decoder.write()`) and a decode/VAD
    loop (`decoder.read()` -> `recognizer.AcceptWaveform()`) concurrently
    via `asyncio.gather` for the connection's lifetime, inside one
    `async with StreamingAudioDecoder() as decoder:` block. These two loops
    MUST run concurrently, never sequentially - ffmpeg's stdout pipe has a
    bounded OS buffer, so nothing draining it stalls ffmpeg's own stdin
    reads, which stalls our writes (a classic pipe deadlock).

    ONE `vosk.KaldiRecognizer` is created here, once, for the whole
    connection (not per-chunk/per-turn) - Vosk's own pause/endpoint
    detection needs continuous audio context across the whole session;
    recreating it would reset that context and break turn detection.
    Whenever `AcceptWaveform` reports a finalized segment, its text (if
    non-empty - silence/noise finalizes to `""`, silently skipped) drives
    one turn. Each finalized turn now runs as its own `asyncio.Task`
    (`current_turn_task`, a local var closed over by `_decode_loop` below)
    instead of being awaited inline, so a NEW segment finalizing while a
    PREVIOUS turn's task is still running can simply cancel it outright
    (barge-in) - whenever `current_turn_task is not None and not
    current_turn_task.done()`, that previous task is cancelled
    (`current_turn_task.cancel()` - not awaited, not otherwise handled; see
    this plan's design notes for why a bare cancel() is sufficient and safe
    here, since `_handle_finalized_turn` owns its own DB session) BEFORE
    starting the new one via `asyncio.create_task(_handle_finalized_turn(...))`.
    `send_lock` is shared with that function too (and passed through, not
    created per-call) since a new turn can finalize and need to send its
    own `user_message` event while a PREVIOUS turn's `reply_delta`/
    `audio_chunk` events are still being sent - the mic never stops
    listening, so these `websocket.send_json` calls are never naturally
    serialized on their own.

    Either loop ending via WebSocketDisconnect (the client closing the
    connection) ends the `async with` block, tearing the decoder/ffmpeg
    process down cleanly - `asyncio.gather` cancels the sibling task the
    moment one raises, so this is caught once, here, rather than in each
    loop individually."""
    await websocket.accept()
    send_lock = asyncio.Lock()

    try:
        model = get_voice_model()
    except VoiceRecognitionUnavailableError:
        async with send_lock:
            await websocket.send_json(
                VoiceErrorEvent(detail=_VOICE_MODEL_NOT_CONFIGURED_ERROR).model_dump()
            )
        await websocket.close()
        return

    recognizer = vosk.KaldiRecognizer(model, TARGET_SAMPLE_RATE_HZ)
    current_turn_task: asyncio.Task | None = None

    async with StreamingAudioDecoder() as decoder:

        async def _receive_loop() -> None:
            while True:
                chunk = await websocket.receive_bytes()
                await decoder.write(chunk)

        async def _decode_loop() -> None:
            nonlocal current_turn_task
            async for pcm_chunk in decoder.read():
                if recognizer.AcceptWaveform(pcm_chunk):
                    finalized_text = json.loads(recognizer.Result())["text"]
                    if finalized_text:
                        if current_turn_task is not None and not current_turn_task.done():
                            current_turn_task.cancel()
                        current_turn_task = asyncio.create_task(
                            _handle_finalized_turn(websocket, send_lock, finalized_text)
                        )

        try:
            await asyncio.gather(_receive_loop(), _decode_loop())
        except WebSocketDisconnect:
            pass


async def _handle_finalized_turn(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    text: str,
) -> None:
    """One full voice-triggered turn (called from voice_session's decode
    loop above once VAD finalizes a non-empty speech segment, as its own
    `asyncio.Task` - see voice_session's docstring for the barge-in
    behavior this enables) - mirrors send_message's own steps but streams
    the reply instead of blocking on the whole thing, and is triggered by
    VAD instead of an HTTP POST body.

    This function's own `text` parameter (the recognized speech, per this
    plan's Task 4 contract) deliberately shadows the module-level
    `sqlalchemy.text` imported above for the rest of this file's raw-SQL
    statements - every INSERT below therefore goes through the fully
    qualified `sqlalchemy.text(...)` instead of the bare `text(...)` every
    other function here uses, to avoid calling the string parameter as if
    it were that function.

    0. Opens ITS OWN session for the whole function body:
       `async with async_session_factory() as session:` - NOT a session
       passed in from the caller. This is what makes cancelling this task
       safe: nothing outside this function's own `async with` block is
       ever touched, so a CancelledError at any point just unwinds this
       block, rolling back/closing this turn's own session, with zero
       effect on any other turn's task or on the connection itself (see
       `.claude/plans/2026-08-15-voice-conversation-mode-phase-2.md`'s
       design notes).
    1. Inserts + commits the user chat_messages row (role='user',
       content=text), then sends VoiceUserMessageEvent under send_lock -
       same "persisted even if everything below fails" resilience as
       send_message's own step 1.
    2. embed_texts([text]) -> fetch_similar_chunks -> context_chunks,
       identical to send_message's own retrieval step. Any LLMError here
       sends VoiceErrorEvent(detail=_CHAT_COMPLETION_FAILED_ERROR) under
       send_lock and returns - this turn ends, no assistant row, the
       session keeps running (one failed turn shouldn't kill the whole
       voice conversation).
    3. Streams the reply via generate_reply_stream, sending a
       VoiceReplyDeltaEvent under send_lock for each yielded piece
       (unchanged from Phase 1) AND feeding a SentenceBuffer with that same
       delta. Whenever the buffer returns one or more newly-completed
       sentences, each is synthesized and sent, in order, via
       _synthesize_and_send_sentence below, awaited sequentially, BEFORE
       resuming consumption of more deltas (see this plan's design notes
       on why sequential, not concurrent). Once the stream is exhausted,
       the buffer's own flush() is synthesized and sent the same way,
       covering whatever trailing text never ended in a terminator. An
       LLMError raised mid-stream (from generate_reply_stream itself, NOT
       from synthesis - see _synthesize_and_send_sentence) gets the exact
       same VoiceErrorEvent-then-return treatment as step 2 - a partial,
       silently-truncated reply must never be persisted as if it were
       complete.
    4. Once the generator is exhausted, inserts + commits the assistant
       row (role='assistant', content=result.content, question_id=step 1's
       row id, no_answer_found=result.no_answer_found - identical column
       set to send_message's own assistant INSERT), then sends
       VoiceReplyDoneEvent under send_lock.
    """
    async with async_session_factory() as session:
        # 1. Insert + commit the user message, then announce it immediately.
        user_row = (
            await session.execute(
                sqlalchemy.text(
                    "INSERT INTO chat_messages (role, content) VALUES (:role, :content) "
                    "RETURNING id"
                ),
                {"role": str(ChatRole.USER), "content": text},
            )
        ).one()
        await session.commit()
        async with send_lock:
            await websocket.send_json(
                VoiceUserMessageEvent(id=str(user_row.id), content=text).model_dump()
            )

        # 2. Embed the recognized text and run the same pgvector similarity
        # search send_message's own retrieval step relies on.
        try:
            [query_embedding] = await embed_texts([text])
            rows = await fetch_similar_chunks(
                session, query_embedding, get_settings().chat_retrieval_top_k
            )
            context_chunks = [row.edited_content for row in rows]
        except LLMError:
            async with send_lock:
                await websocket.send_json(
                    VoiceErrorEvent(detail=_CHAT_COMPLETION_FAILED_ERROR).model_dump()
                )
            return

        # 3. Stream the reply, forwarding each piece as its own event as it
        # arrives, and sentence-buffering the same deltas for TTS. A
        # mid-stream LLMError ends the turn without ever inserting an
        # assistant row for the (necessarily incomplete) reply.
        result = StreamingReplyResult()
        sentence_buffer = SentenceBuffer()
        try:
            async for delta in generate_reply_stream(text, context_chunks, result):
                async with send_lock:
                    await websocket.send_json(VoiceReplyDeltaEvent(content=delta).model_dump())
                for sentence in sentence_buffer.add(delta):
                    await _synthesize_and_send_sentence(websocket, send_lock, sentence)
        except LLMError:
            async with send_lock:
                await websocket.send_json(
                    VoiceErrorEvent(detail=_CHAT_COMPLETION_FAILED_ERROR).model_dump()
                )
            return

        trailing_sentence = sentence_buffer.flush()
        if trailing_sentence is not None:
            await _synthesize_and_send_sentence(websocket, send_lock, trailing_sentence)

        # 4. Insert + commit the assistant message once the full reply is
        # known, then announce completion - deliberately no `content` field
        # on the event itself, since the frontend already has the exact
        # text from accumulating every reply_delta it already received.
        assistant_row = (
            await session.execute(
                sqlalchemy.text(
                    "INSERT INTO chat_messages (role, content, question_id, no_answer_found) "
                    "VALUES (:role, :content, :question_id, :no_answer_found) "
                    "RETURNING id"
                ),
                {
                    "role": str(ChatRole.ASSISTANT),
                    "content": result.content,
                    "question_id": str(user_row.id),
                    "no_answer_found": result.no_answer_found,
                },
            )
        ).one()
        await session.commit()
        async with send_lock:
            await websocket.send_json(
                VoiceReplyDoneEvent(
                    id=str(assistant_row.id), noAnswerFound=result.no_answer_found
                ).model_dump()
            )


async def _synthesize_and_send_sentence(
    websocket: WebSocket, send_lock: asyncio.Lock, sentence: str
) -> None:
    """Synthesizes `sentence` via synthesize_speech and sends it as a
    base64-encoded VoiceAudioChunkEvent under send_lock. An LLMError from
    synthesis is caught and swallowed HERE (not re-raised) - per this
    plan's design notes ("TTS failure degrades that one sentence to
    text-only"), this must never abort the turn the way a
    generate_reply_stream failure does; the caller simply gets no
    audio_chunk event for this sentence and carries on."""
    try:
        audio_bytes = await synthesize_speech(sentence)
    except LLMError:
        return
    async with send_lock:
        await websocket.send_json(
            VoiceAudioChunkEvent(
                audioBase64=base64.b64encode(audio_bytes).decode("ascii")
            ).model_dump()
        )
