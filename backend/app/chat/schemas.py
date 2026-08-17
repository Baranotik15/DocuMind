from typing import Literal

from pydantic import BaseModel


class SendMessageRequest(BaseModel):
    content: str


class TopChunksRequest(BaseModel):
    content: str


class ChatMessageSummary(BaseModel):
    id: str
    role: str
    content: str
    disliked: bool


class TopChunkSummary(BaseModel):
    chunkId: str
    documentId: str
    filename: str
    content: str
    matchPercent: float


# Query param for GET /chat/dislikes and GET /chat/no-answer-messages -
# FastAPI 422s any value outside this set automatically, same convention as
# app.dashboard.router's own DashboardRange.
ImprovementsRange = Literal["day", "7days", "30days", "all"]


class DislikedMessageSummary(BaseModel):
    id: str
    content: str
    # None only if question_id somehow didn't resolve (shouldn't happen in
    # practice, but the FK is nullable).
    questionContent: str | None
    dislikedAt: str
    createdAt: str


class NoAnswerMessageSummary(BaseModel):
    id: str
    content: str
    questionContent: str | None
    createdAt: str


class TranscriptionResult(BaseModel):
    text: str


# --- Voice conversation WebSocket events -----------------------------------
#
# Sent over ws://.../internal/chat/voice-session (app/chat/router.py's
# voice_session) - one connection covers a whole voice conversation, not one
# request/response like every other schema in this module. `type` is a
# Pydantic Literal discriminator so the frontend's ws.onmessage handler can
# switch on the parsed JSON's own "type" field, matching this plan's
# `.claude/plans/2026-08-14-voice-conversation-mode.md` Task 3 contract.


class VoiceUserMessageEvent(BaseModel):
    """Sent once a VAD-finalized speech segment has been persisted as a user
    chat_messages row - `id` is that row's id, `content` is the recognized
    text (see app.chat.router._handle_finalized_turn, Task 4)."""

    type: Literal["user_message"] = "user_message"
    id: str
    content: str


class VoiceReplyDeltaEvent(BaseModel):
    """One streamed piece of the assistant's in-progress reply - see
    app.chat.completion.generate_reply_stream. The frontend accumulates
    these; see this plan's design notes for why reply_done below doesn't
    resend the full text."""

    type: Literal["reply_delta"] = "reply_delta"
    content: str


class VoiceReplyDoneEvent(BaseModel):
    """Sent once the assistant's reply is fully streamed and persisted -
    `id` is the assistant chat_messages row's id, `noAnswerFound` mirrors
    that row's own no_answer_found column. Deliberately carries no `content`
    - see this plan's design notes on why the full text is never resent."""

    type: Literal["reply_done"] = "reply_done"
    id: str
    noAnswerFound: bool


class VoiceErrorEvent(BaseModel):
    """Sent either once at connection start (unconfigured Vosk model, then
    the connection closes) or mid-turn (an LLM failure - the session keeps
    running afterward, see this plan's design notes)."""

    type: Literal["error"] = "error"
    detail: str


class VoiceAudioChunkEvent(BaseModel):
    """Sent once a completed sentence of the in-progress reply (see
    app.chat.sentence_buffer.SentenceBuffer) has been synthesized to speech
    (app.chat.voice.synthesize_speech) - `audioBase64` is that sentence's
    raw MP3 clip, base64-encoded for JSON transport, per
    `.claude/plans/2026-08-15-voice-conversation-mode-phase-2.md`'s design
    notes on why audio rides inside a JSON event instead of a separate
    binary WS frame. Interleaved with reply_delta events for the same turn
    (both are sent as soon as they're each ready) - not a replacement for
    them, since the frontend still needs the text for the transcript. A
    synthesis failure for one sentence is swallowed by the caller (see
    app.chat.router._synthesize_and_send_sentence) rather than represented
    here - that sentence simply has no corresponding event at all."""

    type: Literal["audio_chunk"] = "audio_chunk"
    audioBase64: str
