# Voice Conversation Mode (Phase 1) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A second, separate mic-style button on ChatPage that opens a
WebSocket session, continuously streams the user's speech, uses Vosk's own
pause detection to auto-send each finished turn through the existing
retrieve+LLM pipeline with no manual Send click, and streams the assistant's
reply back as live text - per `.claude/specs/voice-conversation-mode.md`.
No text-to-speech/audio output (Phase 2, separate future work).

**Architecture:** Backend: one new WebSocket route,
`ws://.../internal/chat/voice-session`, on the existing `chat_router`. Per
connection it holds ONE long-lived `StreamingAudioDecoder` (a persistent
ffmpeg subprocess, new to `app/chat/voice.py`) and ONE long-lived
`vosk.KaldiRecognizer` for the life of the session - unlike the existing
single-clip `/chat/transcribe` endpoint, which creates and discards both per
request. Two concurrent loops run for the connection's lifetime: a receive
loop (`websocket.receive_bytes()` -> `decoder.write()`) and a decode loop
(`decoder.read()` -> `recognizer.AcceptWaveform()`); whenever
`AcceptWaveform` reports a finalized segment, its text (if non-empty) drives
a turn that mirrors `send_message`'s own steps (insert user row, embed,
pgvector retrieval, generate a reply) but through a new streaming variant of
`generate_reply` that yields text deltas, sent back over the same socket as
they're generated. Frontend: a new hook,
`frontend/src/pages/useVoiceConversationSession.ts`, owns the WebSocket and
a continuously-chunked `MediaRecorder` (rather than growing `ChatPage.tsx`,
already ~900 lines, further); `ChatPage.tsx` wires its callbacks to the
existing `messages` state plus one new transient "reply streaming in" bubble
state.

**Tech Stack:** FastAPI's native `@router.websocket` support (first
WebSocket route in this app), `asyncio.create_subprocess_exec` for the
persistent ffmpeg process (the existing single-clip `convert_to_pcm_wav`
uses the simpler, blocking `subprocess.run` - not reusable here), OpenAI's
streaming chat completions (`stream=True`), the browser's native
`WebSocket`/`MediaRecorder` APIs on the frontend - no new pip/npm
dependencies.

---

## Key design decisions (read before starting)

- **One persistent ffmpeg process and one persistent `KaldiRecognizer` per
  connection, created once and reused for the whole session** - not
  per-chunk, not per-turn. Vosk's own pause/endpoint detection (the
  mechanism this whole feature's VAD relies on) needs continuous audio
  context across the entire session; recreating either per chunk would
  reset that context and break turn detection.
- **The streaming decoder emits raw headerless PCM (`ffmpeg -f s16le`),
  not a WAV file per chunk** - deliberately different from
  `convert_to_pcm_wav`'s one-shot `-f wav` output. There is no single
  complete WAV file in a continuous stream to parse a header out of; raw
  PCM means every byte read from ffmpeg's stdout is immediately usable,
  no `wave` module involved on this path.
- **The receive loop (reading WS audio frames, writing to the decoder) and
  the decode loop (reading decoded PCM from the decoder, feeding the
  recognizer) MUST run as two concurrent asyncio tasks, never
  sequentially.** ffmpeg's stdout pipe has a bounded OS buffer; if nothing
  ever drains it, ffmpeg blocks writing its own output, which stops it
  reading more stdin, which blocks our own writes - a classic pipe
  deadlock. `asyncio.gather` (or equivalent) both loops for the
  connection's lifetime.
- **Every outgoing `websocket.send_json` (from either loop, or from a
  turn's reply-streaming) goes through one shared `asyncio.Lock` for the
  connection.** The mic never stops listening during Phase 1 (per spec),
  so a new turn can finalize and need to send its own `user_message` event
  while a PREVIOUS turn's `reply_delta` events are still being sent -
  Starlette's `WebSocket.send` isn't documented as safe for concurrent
  callers, so these must be serialized.
- **`generate_reply_stream` buffers only the first `len(NO_ANSWER_MARKER)`
  characters before yielding anything**, checks whether that buffered
  prefix IS the marker, and if so silently drops it (matching
  `_parse_reply`'s existing "hidden signal, never shown to a user"
  contract) instead of ever letting `[[NO_ANSWER]]` reach the frontend.
  Every yielded piece is also appended to a caller-supplied
  `StreamingReplyResult.content`, so it holds the exact final text once
  the generator is exhausted - byte-for-byte what gets persisted to
  `chat_messages` and what the frontend already has from its own streamed
  deltas.
- **On `reply_done`, the backend sends only `{id, noAnswerFound}` - not the
  full reply text again.** The frontend already has the complete text,
  byte-for-byte, from accumulating every `reply_delta` it already received;
  resending it would be redundant. The frontend's own accumulated string
  becomes that `ChatMessage`'s `content` when it's pushed into `messages`.
- **An embedding/LLM failure mid-turn sends a `error` event and ends that
  turn - it does NOT close the session.** The user can simply speak again;
  one failed turn shouldn't force restarting the whole voice conversation.
  This mirrors `send_message`'s own "user row stays committed even if
  generation fails" resilience, one level up.
- **New frontend hook file, not more code piled into `ChatPage.tsx`**
  (already ~900 lines before this feature). `useVoiceConversationSession.ts`
  owns the WebSocket + continuously-chunked `MediaRecorder`; `ChatPage.tsx`
  only wires its callbacks into existing/new state.
- **`Depends(require_session)` is reused as-is on the WebSocket route**, no
  WS-specific auth dependency. FastAPI translates a raised `HTTPException`
  from a dependency into a clean WebSocket close; the session cookie is
  sent on the WS handshake exactly like every existing `fetch(...,
  {credentials:'include'})` call already relies on, because
  `localhost:5173` and `localhost:8000` are same-site (SameSite only cares
  about the registrable domain, not the port) even though they're
  cross-origin. Task 3's first test proves this assumption rather than
  just asserting it.

---

### Task 1: Backend - persistent streaming audio decoder

**Files:**
- Modify: `backend/app/chat/voice.py`
- Test: `backend/tests/test_chat_voice.py` (extend)
- Reference: this file's own `convert_to_pcm_wav` (the one-shot sibling -
  same ffmpeg-via-subprocess spirit, different lifecycle)

**Contracts:**

```python
# backend/app/chat/voice.py - add
import asyncio
from collections.abc import AsyncIterator


class StreamingAudioDecoder:
    """One long-lived ffmpeg process per voice-conversation WebSocket
    connection (app/chat/router.py's voice_session) - decodes whatever
    container/codec the browser's continuously-chunked MediaRecorder
    produces into a continuous raw PCM stream (mono, TARGET_SAMPLE_RATE_HZ,
    16-bit, headerless - `ffmpeg ... -f s16le`, NOT `-f wav` like
    convert_to_pcm_wav - see this plan's design notes on why there's no
    WAV header to parse here).

    `write()` and `read()` must be driven concurrently by the caller (see
    this plan's design notes on the pipe-deadlock risk of not doing so) -
    this class does not spawn its own background draining task; it only
    wraps the subprocess and exposes both sides.
    """

    def __init__(self) -> None: ...

    async def __aenter__(self) -> "StreamingAudioDecoder":
        """Starts the ffmpeg subprocess via asyncio.create_subprocess_exec
        (stdin=PIPE, stdout=PIPE, stderr=PIPE) - same flag set as
        convert_to_pcm_wav's `-hide_banner -loglevel error -i pipe:0 -ar
        {TARGET_SAMPLE_RATE_HZ} -ac 1`, but `-f s16le pipe:1` instead of
        `-f wav pipe:1`."""
        ...

    async def __aexit__(self, *exc_info: object) -> None:
        """Closes stdin (signals ffmpeg no more input is coming, so it
        flushes and exits cleanly), awaits the process, and only then
        force-kills it if it's still alive (a stuck/misbehaving ffmpeg
        process must never be left running after the connection closes)."""
        ...

    async def write(self, chunk: bytes) -> None:
        """Writes one incoming audio chunk to ffmpeg's stdin and drains
        it (`await stdin.drain()`) - backpressure-aware, per this plan's
        concurrent-loops design note."""
        ...

    async def read(self) -> AsyncIterator[bytes]:
        """Yields decoded PCM as it becomes available from ffmpeg's
        stdout (`await stdout.read(n)` in a loop, some reasonable chunk
        size), until stdout hits EOF (empty read - ffmpeg exited/stdin was
        closed), at which point the generator ends."""
        ...
```

**Step 1: Write the failing tests**

Extend `test_chat_voice.py`, monkeypatching
`app.chat.voice.asyncio.create_subprocess_exec` to a fake returning an
object with fake `stdin` (a `MagicMock` with `write`/`drain` as
`AsyncMock`s recording every call) and fake `stdout` (an object whose
`read(n)` is an `AsyncMock` with a scripted `side_effect` list of byte
strings ending in `b""` to signal EOF), plus a fake `wait`/`kill`:
- `write("abc")` -> asserts `stdin.write` was called with `b"abc"` and
  `stdin.drain` was awaited.
- `read()` -> collecting everything yielded equals the concatenation of
  the scripted non-empty `stdout.read` side effects, stopping at the `b""`
  sentinel (no hang, no extra iteration).
- `__aexit__` -> asserts `stdin.close()` (or equivalent) was called before
  awaiting the process, and that the process is killed if `wait()`'s mock
  raises `asyncio.TimeoutError` (simulating a hung process) - a real
  ffmpeg subprocess must never be leaked.
- The real ffmpeg command list passed to `create_subprocess_exec` includes
  `"-f"`, `"s16le"` (not `"wav"`) - the one concrete assertion that this
  path genuinely differs from `convert_to_pcm_wav`'s.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_voice.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_voice.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/chat/voice.py backend/tests/test_chat_voice.py
git commit -m "feat(chat): add persistent streaming audio decoder for voice sessions"
```

---

### Task 2: Backend - streaming LLM completion

**Files:**
- Modify: `backend/app/chat/completion.py`
- Test: `backend/tests/test_llm.py` (extend)
- Reference: this file's own `generate_reply`/`_parse_reply`/
  `_build_system_prompt` (reused, not duplicated)

**Contracts:**

```python
# backend/app/chat/completion.py - add
from collections.abc import AsyncIterator


@dataclass
class StreamingReplyResult:
    """Mutable result populated by generate_reply_stream as it consumes the
    OpenAI stream - read AFTER the async generator it returns is fully
    exhausted (an async generator's yielded values are the only thing
    `async for` exposes; there's no ergonomic way to also get a return
    value out of one, hence this out-parameter style instead)."""

    content: str = ""
    no_answer_found: bool = False


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
    ...
```

**Step 1: Write the failing tests**

Extend `test_llm.py`. Mock a streaming OpenAI response: a small
`FakeAsyncStream` helper class wrapping a list of chunk `MagicMock`s (each
shaped `MagicMock(choices=[MagicMock(delta=MagicMock(content=<delta or
None>))])`) with `__aiter__`/`__anext__` (`StopAsyncIteration` once
exhausted) - `client.chat.completions.create = AsyncMock(return_value=
FakeAsyncStream([...]))`.
- Deltas concatenating to `"Hello there"` with no marker -> collecting
  everything yielded via `async for` equals `"Hello there"`;
  `result.content == "Hello there"`; `result.no_answer_found is False`.
- Deltas concatenating to `NO_ANSWER_MARKER + "\nActual answer"` (split
  across multiple small chunks, e.g. the marker itself split mid-token) ->
  nothing yielded ever contains any part of the marker; everything yielded
  concatenates to `"Actual answer"`; `result.no_answer_found is True`.
- A short reply shorter than `len(NO_ANSWER_MARKER)` with no marker (e.g.
  `"Hi"`) -> yields `"Hi"` once the stream ends, not stuck buffering
  forever waiting for more characters that never come.
- `FakeAsyncStream.__anext__` raising mid-iteration -> consuming the
  generator via `async for` raises `LLMError`.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_llm.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contract above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_llm.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/chat/completion.py backend/tests/test_llm.py
git commit -m "feat(chat): add streaming variant of generate_reply"
```

---

### Task 3: Backend - WebSocket connection lifecycle, audio pipeline, VAD

**Files:**
- Modify: `backend/app/chat/router.py`
- Modify: `backend/app/chat/schemas.py`
- Test: `backend/tests/test_chat_router.py` (extend)
- Reference: `backend/app/chat/voice.py`'s `_get_model`/`TARGET_SAMPLE_RATE_HZ`,
  this file's own `send_message` (the pipeline this task's turns will
  mirror in Task 4)

**Contracts:**

```python
# backend/app/chat/schemas.py - add
from typing import Literal


class VoiceUserMessageEvent(BaseModel):
    type: Literal["user_message"] = "user_message"
    id: str
    content: str


class VoiceReplyDeltaEvent(BaseModel):
    type: Literal["reply_delta"] = "reply_delta"
    content: str


class VoiceReplyDoneEvent(BaseModel):
    type: Literal["reply_done"] = "reply_done"
    id: str
    noAnswerFound: bool


class VoiceErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    detail: str
```

```python
# backend/app/chat/router.py - add
import asyncio
import json

from fastapi import WebSocket, WebSocketDisconnect
import vosk

from app.chat.voice import StreamingAudioDecoder, TARGET_SAMPLE_RATE_HZ, VoiceRecognitionUnavailableError
from app.chat.voice import _get_model as get_voice_model  # reused, not duplicated


@router.websocket("/chat/voice-session")
async def voice_session(
    websocket: WebSocket,
    user_email: str = Depends(require_session),
    session: AsyncSession = Depends(get_session),
) -> None:
    """See this plan's Architecture section and design notes for the full
    shape: accepts the connection, resolves the configured Vosk model
    (sends a VoiceErrorEvent + closes if unconfigured - see
    VoiceRecognitionUnavailableError), then runs the receive loop and the
    decode/recognize loop concurrently (asyncio.gather) inside one
    `async with StreamingAudioDecoder() as decoder:` block for the
    connection's lifetime, sharing one asyncio.Lock for every
    websocket.send_json call either loop (or Task 4's turn handling) makes.

    Receive loop: `while True: chunk = await websocket.receive_bytes();
    await decoder.write(chunk)` - exits via WebSocketDisconnect.

    Decode/recognize loop: one vosk.KaldiRecognizer(model,
    TARGET_SAMPLE_RATE_HZ) created ONCE before the loop starts (not
    per-iteration). `async for pcm_chunk in decoder.read():
    is_final = recognizer.AcceptWaveform(pcm_chunk); if is_final: text =
    json.loads(recognizer.Result())["text"]; if text: await
    _handle_finalized_turn(websocket, session, send_lock, text, user_email)`
    (Task 4) - empty text is silently skipped, per spec.

    Both loops ending (decoder.read() exhausting because ffmpeg exited, or
    a WebSocketDisconnect from either) ends the `async with` block, which
    tears the decoder/ffmpeg process down cleanly."""
    ...
```

**Step 1: Write the failing tests**

Extend `test_chat_router.py`, using `TestClient`'s
`client.websocket_connect("/internal/chat/voice-session")` (a context
manager - construct it via the SAME `authenticated_client`/plain-`client`
fixtures already in this file, since it's a normal cookie-jar-backed
`TestClient` under the hood). Monkeypatch `app.chat.router.StreamingAudioDecoder`
to a `FakeStreamingAudioDecoder` (async context manager whose `write`
appends to an internal buffer and whose `read()` immediately re-yields
whatever was written - no real ffmpeg), and
`app.chat.router.vosk.KaldiRecognizer` to a fake class whose
`AcceptWaveform` follows a scripted `side_effect` list of booleans and
whose `Result`/`FinalResult` return scripted JSON text - same monkeypatch
style `test_chat_voice.py` already uses for `vosk.KaldiRecognizer`. Also
monkeypatch `app.chat.router._handle_finalized_turn` to a bare `AsyncMock`
for this task's tests (Task 4 tests that function's real behavior
separately, in isolation).
- No session cookie -> the connection is rejected/closed (proves the
  `Depends(require_session)`-on-a-websocket assumption from this plan's
  design notes actually holds under FastAPI 0.141.1, rather than just
  trusting it).
- With a session cookie: sending a few binary chunks, with
  `AcceptWaveform` scripted `[False, True]` and `Result()` scripted to
  return `'{"text": "what is the refund policy"}'` on the finalizing call
  -> `_handle_finalized_turn` is awaited exactly once with
  `text="what is the refund policy"`.
- Same, but `Result()` returns `'{"text": ""}'` (silence/noise) ->
  `_handle_finalized_turn` is NOT called, and the connection stays open
  (send one more chunk afterward and confirm no error/close happened).
- `get_settings().vosk_model_path` unconfigured (monkeypatch settings,
  same idiom `test_chat_voice.py` already uses) -> connecting yields one
  `error` JSON event with `detail == "voice_model_not_configured"`, then
  the connection closes.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_router.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q`
Expected: PASS, no regressions.

**Step 4: Commit**

```bash
git add backend/app/chat/router.py backend/app/chat/schemas.py backend/tests/test_chat_router.py
git commit -m "feat(chat): add voice-session WebSocket connection lifecycle and VAD loop"
```

---

### Task 4: Backend - turn handling (retrieval + streaming reply)

**Files:**
- Modify: `backend/app/chat/router.py`
- Test: `backend/tests/test_chat_router.py` (extend)
- Reference: this file's own `send_message` (the exact retrieval/insert
  steps this mirrors)

**Contracts:**

```python
# backend/app/chat/router.py - add
async def _handle_finalized_turn(
    websocket: WebSocket,
    session: AsyncSession,
    send_lock: asyncio.Lock,
    text: str,
) -> None:
    """One full voice-triggered turn (called from Task 3's decode loop
    once VAD finalizes non-empty text) - mirrors send_message's own steps
    but streams the reply instead of blocking on the whole thing:

    1. INSERT the user chat_messages row (role='user', content=text - same
       defaults send_message's own INSERT relies on for channel), commit.
       Under send_lock, send VoiceUserMessageEvent(id=<row id>,
       content=text).
    2. embed_texts([text]) -> fetch_similar_chunks(session, embedding,
       get_settings().chat_retrieval_top_k) -> context_chunks, identical
       to send_message. LLMError here: under send_lock, send
       VoiceErrorEvent(detail=_CHAT_COMPLETION_FAILED_ERROR) (the same
       constant send_message's own 502 already uses) and RETURN - this
       turn ends, no assistant row, the session keeps running (see this
       plan's design notes).
    3. result = StreamingReplyResult(); `async for delta in
       generate_reply_stream(text, context_chunks, result):` send
       VoiceReplyDeltaEvent(content=delta) under send_lock for each piece.
       Same LLMError -> VoiceErrorEvent -> return contract as step 2 if
       generation fails mid-stream (an assistant row is NOT inserted in
       that case either - a partial, silently-truncated reply must never
       be persisted as if it were complete).
    4. Once exhausted: INSERT the assistant row (role='assistant',
       content=result.content, question_id=<step 1's row id>,
       no_answer_found=result.no_answer_found - identical column set to
       send_message's own assistant INSERT), commit. Under send_lock, send
       VoiceReplyDoneEvent(id=<assistant row id>,
       noAnswerFound=result.no_answer_found)."""
    ...
```

**Step 1: Write the failing tests**

Extend `test_chat_router.py`, calling `_handle_finalized_turn` directly as
a plain async function (`asyncio.run(...)`) against a real test-DB session
(same fixture pattern this file's other DB-touching tests already use) and
a `MagicMock` websocket whose `send_json` is an `AsyncMock` recording every
call, with `app.chat.router.embed_texts`/`generate_reply_stream` patched
(mirroring `test_analysis_service.py`'s LLM-call mocking idiom already
established elsewhere in this codebase):
- Happy path: `embed_texts` returns a fake vector, `generate_reply_stream`
  patched to a fake async generator yielding `["Paris", " is", " the
  capital"]` and setting `result.content`/`no_answer_found` accordingly ->
  a `chat_messages` user row and assistant row both exist afterward with
  the right `question_id` link; `send_json` was called, in order, with one
  `user_message`, three `reply_delta`, one `reply_done` payload (assert on
  `.model_dump()`-equivalent dict shapes).
- `embed_texts` raising `LLMError` -> `send_json` called with one
  `user_message` then one `error` payload; NO assistant row exists
  afterward (query `chat_messages` for the user row's id as `question_id`
  and confirm zero results).
- `generate_reply_stream` raising `LLMError` partway through iteration ->
  same `error`-event contract, still no assistant row, but the user row
  DOES still exist (mirrors send_message's own "user message persists even
  if generation fails" guarantee).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_router.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contract above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q`
Expected: PASS, no regressions.

**Step 4: Commit**

```bash
git add backend/app/chat/router.py backend/tests/test_chat_router.py
git commit -m "feat(chat): wire retrieval and streaming replies into voice-session turns"
```

---

### Task 5: Frontend - `useVoiceConversationSession` hook

**Files:**
- Create: `frontend/src/pages/useVoiceConversationSession.ts`
- Test: `frontend/src/pages/useVoiceConversationSession.test.ts`
- Reference: `ChatPage.tsx`'s existing `handleMicClick`/`handleRecordingStopped`
  (the `getUserMedia`/`MediaRecorder` idiom to reuse the spirit of, not the
  code - this hook's recorder runs continuously with a `timeslice`, not
  record-then-stop-then-upload-once)

**Contracts:**

```typescript
// frontend/src/pages/useVoiceConversationSession.ts
export type VoiceConversationStatus = 'idle' | 'connecting' | 'listening'

export interface VoiceConversationCallbacks {
  onUserMessage: (message: { id: string; content: string }) => void
  onReplyDelta: (content: string) => void
  onReplyDone: (message: { id: string; noAnswerFound: boolean }) => void
  onError: (message: string) => void
}

export interface VoiceConversationSession {
  status: VoiceConversationStatus
  start: () => Promise<void>
  stop: () => void
}

export function useVoiceConversationSession(
  callbacks: VoiceConversationCallbacks,
): VoiceConversationSession
```

`start()`: requests `navigator.mediaDevices.getUserMedia({ audio: true })`,
opens `new WebSocket('ws://localhost:8000/internal/chat/voice-session')`
(mirrors `httpClient.ts`'s hardcoded `BASE_URL` - same single-host, no env
plumbing yet rationale, just the `ws` scheme), sets `status = 'connecting'`
immediately then `'listening'` once the socket's `onopen` fires. Once open,
creates `new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })`,
wires `ondataavailable` to `ws.send(event.data)` (sending each `Blob`
chunk directly - `WebSocket.send` accepts a `Blob`, no manual
`arrayBuffer()` conversion needed) whenever `event.data.size > 0`, and
`recorder.start(VOICE_SESSION_TIMESLICE_MS)` (a module constant, e.g.
`250` - short enough that turn-ending latency feels responsive, long
enough not to spam tiny frames).

`ws.onmessage`: `JSON.parse(event.data)`, discriminate on `.type` -
`'user_message'`/`'reply_delta'`/`'reply_done'`/`'error'` - and invoke the
matching callback. An unrecognized `.type` is ignored (forward-compatible,
not an error).

`stop()`: stops the `MediaRecorder`, stops every track on the `MediaStream`
(`stream.getTracks().forEach(t => t.stop())`), closes the WebSocket, sets
`status = 'idle'`. Also called internally if the socket closes/errors
unexpectedly (`ws.onclose`/`ws.onerror`) - see this task's own test for the
exact assertion (status must always end up back at `'idle'`, never stuck in
`'connecting'`/`'listening'` after a close).

**Step 1: Write the failing tests**

`useVoiceConversationSession.test.ts`, using `@testing-library/react`'s
`renderHook` (check whether this project already has it available via
`@testing-library/react`'s package version - it's bundled from v13+; if
not already imported anywhere, this is this hook's own test's job to
introduce, no new dependency needed) plus the same
`Object.defineProperty(navigator, 'mediaDevices', ...)` /
`vi.stubGlobal('MediaRecorder', Fake...)` idioms `ChatPage.test.tsx`
already established, PLUS a new `FakeWebSocket` stub (`vi.stubGlobal('WebSocket',
FakeWebSocket)`) whose constructor records the URL, exposes `send` as a
`vi.fn()`, and lets the test manually fire `onopen`/`onmessage`/`onclose`
by calling the captured instance's handlers directly (no real networking):
- `start()` requests the mic, opens a WebSocket to the expected URL, and
  once both the fake socket's `onopen` fires AND recording begins, `status`
  is `'listening'`.
- Firing the fake socket's `onmessage` with a `'user_message'`-shaped JSON
  payload calls `onUserMessage` with the right `{id, content}`; same for
  `'reply_delta'`/`'reply_done'`/`'error'` each calling their own callback.
- Simulating the fake `MediaRecorder`'s `ondataavailable` firing calls the
  fake WebSocket's `send` with that chunk.
- `stop()` stops every media stream track, closes the socket, and sets
  `status` back to `'idle'`.
- Firing the fake socket's `onclose` directly (simulating an unexpected
  server-side close) also settles `status` back to `'idle'` without `stop()`
  having been called explicitly.

Run: `cd frontend && npx vitest run src/pages/useVoiceConversationSession.test.ts`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run src/pages/useVoiceConversationSession.test.ts`
and `npx tsc -b`.
Expected: PASS, no type errors.

**Step 4: Commit**

```bash
git add frontend/src/pages/useVoiceConversationSession.ts frontend/src/pages/useVoiceConversationSession.test.ts
git commit -m "feat(chat): add useVoiceConversationSession hook"
```

---

### Task 6: Frontend - ChatPage integration (button, listening UI, streaming bubble, input lockout)

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`
- Modify: `frontend/src/pages/ChatPage.test.tsx`
- Reference: this file's own `MicIcon`/`StopIcon` (hand-rolled SVG
  convention to match for a new `VoiceConversationIcon`), the existing
  `isSending`-drives-a-separate-typing-indicator-bubble pattern (the
  streaming-reply bubble follows the same shape, with real growing text
  instead of dots)

**Contracts:**

```typescript
// frontend/src/pages/ChatPage.tsx
import { useVoiceConversationSession } from './useVoiceConversationSession'

/** Hand-rolled waveform glyph for the voice-conversation button - same
 * no-icon-library rationale as MicIcon/StopIcon above. Visually distinct
 * from MicIcon (this is a SEPARATE control, see this plan's Architecture
 * notes) - a simple set of vertical bars reads as "live audio" at a
 * glance, distinct from the single-mic glyph. */
function VoiceConversationIcon(): JSX.Element { ... }
```

New state: `streamingReplyContent: string | null` (the in-progress
assistant reply's text so far, `null` when nothing is streaming).

```typescript
const voiceConversation = useVoiceConversationSession({
  onUserMessage: (message) => {
    setMessages((current) => [...current, { id: message.id, role: 'user', content: message.content, disliked: false }])
    setStreamingReplyContent('')  // a reply is now expected - empty string, not null, so the bubble renders immediately
  },
  onReplyDelta: (content) => {
    setStreamingReplyContent((current) => (current ?? '') + content)
  },
  onReplyDone: (message) => {
    setStreamingReplyContent((current) => {
      setMessages((prev) => [
        ...prev,
        { id: message.id, role: 'assistant', content: current ?? '', disliked: false },
      ])
      return null
    })
  },
  onError: (detail) => {
    setStreamingReplyContent(null)
    setVoiceError(detail === 'voice_model_not_configured' ? VOICE_UNAVAILABLE_MESSAGE : VOICE_GENERIC_ERROR_MESSAGE)
  },
})
```

Render: the streaming bubble renders using the SAME assistant-message
`Paper`/`Group`/`BotAvatar` markup the real message list already uses
(extract nothing new - just render one extra bubble with
`streamingReplyContent`'s current value when it's non-null, positioned
after the real `messages.map(...)` list and before/instead of the
existing `isSending` typing-indicator block, since the two are mutually
exclusive - a voice turn is never also `isSending`).

The new button sits next to the existing mic `ActionIcon` in the input
bar: `aria-label` reflects `voiceConversation.status`
(`'idle'` -> "Start voice conversation", `'connecting'`/`'listening'` ->
"End voice conversation"), `onClick` calls `voiceConversation.start()` or
`.stop()` depending on current status, with a distinct active-session
visual treatment (color/variant change plus e.g. a small pulsing dot -
implementer's call on the exact glow/pulse styling, following this file's
existing CSS-module conventions in `ChatPage.module.css`) so it's
unambiguous versus the plain dictation mic sitting right next to it.

The ordinary `Textarea`, Send `ActionIcon`, and the existing dictation mic
`ActionIcon` all get `disabled={... || voiceConversation.status !== 'idle'}`
added to their existing disabled conditions.

**Step 1: Write the failing tests**

Extend `ChatPage.test.tsx` with a new `describe('Voice conversation mode',
...)` block, stubbing `WebSocket`/`MediaRecorder`/`mediaDevices` the same
way Task 5's own test file does (a small shared fake-setup helper is fine
to duplicate between the two files rather than forcing a shared test
utility for this one case - keep it simple):
- Clicking the new button shows the active/listening state and disables
  the message input, Send button, and dictation mic button.
- Simulating a `'user_message'` event appends a user `ChatMessage` to the
  transcript.
- Simulating `'reply_delta'` events after that renders a growing assistant
  bubble with the accumulated text, NOT yet a real entry in the message
  list.
- Simulating `'reply_done'` finalizes that bubble into a real assistant
  message in the transcript (same accumulated text) and the transient
  streaming bubble disappears.
- Simulating an `'error'` event with `detail: 'voice_model_not_configured'`
  shows the existing `VOICE_UNAVAILABLE_MESSAGE` alert.
- Clicking the button again while active ends the session: input/Send/mic
  become enabled again, button returns to idle appearance.

Run: `cd frontend && npx vitest run src/pages/ChatPage.test.tsx`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run` (full suite) and `npx tsc -b`.
Expected: PASS, no regressions, no type errors.

**Step 4: Commit**

```bash
git add frontend/src/pages/ChatPage.tsx frontend/src/pages/ChatPage.test.tsx
git commit -m "feat(chat): wire voice conversation mode into ChatPage"
```

---

### Task 7: Full regression + live smoke test

**Files:** None new - verification only.

**Step 1:** `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q` - PASS.

**Step 2:** `cd frontend && npx vitest run && npx tsc -b` - PASS, no type
errors.

**Step 3:** `docker compose up -d --build backend worker frontend` - the
real Vosk model from this session's earlier work should already be
configured (`VOSK_MODEL_PATH` in `.env`, model bind-mounted per the
existing `docker-compose.yml` fix) - confirm `docker compose ps` shows
backend healthy.

**Step 4:** Live smoke test via a throwaway user (same idiom as every
earlier live check this session - `app.auth.service.create_user`, clean up
afterward): open Chat, click the new voice-conversation button, grant mic
permission, confirm the active/listening UI appears and the ordinary
input/Send/dictation controls are disabled. Speak a short question in
Russian, pause, and confirm: it appears as a user message with no manual
Send; the reply visibly streams in as growing text; once done it's a real
message like any other (still there after reloading the page); the session
is still listening (try a second question in the same session without
re-clicking the button). Test the empty-segment case (stay silent briefly,
or make noise with no speech) and confirm nothing gets sent and the
session keeps running. Click the button again and confirm the session ends
cleanly (input controls re-enable). Then unset/break `VOSK_MODEL_PATH`,
restart, and confirm starting a session surfaces the "not configured"
error instead of a silently-broken connection - restore it afterward.
Clean up the throwaway user/session/seeded chat rows afterward.

**Step 5: Commit** (only if Steps 1-2 required fixes)

```bash
git add -A
git commit -m "test: fix regressions found during voice-conversation-mode smoke testing"
```
