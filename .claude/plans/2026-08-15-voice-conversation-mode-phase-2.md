# Voice Conversation Mode (Phase 2 - spoken replies) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make voice-conversation replies (Phase 1: WebSocket session, VAD,
auto-send, streaming text - already live) also speak out loud via OpenAI
TTS, synthesized sentence-by-sentence for low time-to-first-audio, with
barge-in (talking over a reply cancels it outright) - per
`.claude/specs/voice-conversation-mode-phase-2.md`.

**Architecture:** Backend: a small `SentenceBuffer` re-groups
`generate_reply_stream`'s token deltas into complete sentences; each
completed sentence is synthesized via a new `synthesize_speech` (OpenAI's
`/audio/speech`, mirroring `embed_texts`/`generate_reply`'s
`get_client()`/`LLMError` pattern) and sent to the frontend as a new
`audio_chunk` WS event, interleaved with the existing `reply_delta` events
(text streaming is unchanged). The biggest structural change: each turn now
runs as a **cancellable `asyncio.Task`** (not an inline `await`) with its
**own isolated DB session** (not the connection-shared one) - so that when a
new utterance finalizes while a previous turn is still generating/
synthesizing, the previous task is simply `.cancel()`led outright, safely,
with no risk of corrupting shared session/transaction state. No new
"barge-in" event type is needed - the frontend already resets its streaming
bubble on every `user_message`; Phase 2 just also has it stop/clear
whatever audio was queued or playing at that moment. Frontend: all of this
is absorbed into the existing `useVoiceConversationSession` hook (a new
`audio_chunk` case, an internal sequential playback queue) - `ChatPage.tsx`
needs no changes at all.

**Tech Stack:** OpenAI's `/audio/speech` endpoint via the already-pinned
`openai==2.52.0` SDK (`AsyncOpenAI.audio.speech.create`, returns
`HttpxBinaryResponseContent` - read via `await response.aread()`), Python's
stdlib `base64` for WS transport (audio is sent as a base64 string inside a
JSON event, consistent with every other voice-session event being JSON -
not a mix of binary and text frames), the browser's native `Audio`/`Blob`/
`URL.createObjectURL` APIs on the frontend for sequential playback. No new
pip/npm dependencies.

---

## Key design decisions (read before starting)

- **TTS synthesis is awaited sequentially, one sentence at a time - not
  fired off concurrently.** This guarantees playback order with no need
  for sequence numbers or frontend-side reordering, and keeps the whole
  feature far simpler. It does not meaningfully hurt the "hear the start
  early" goal: the entire benefit comes from not waiting for the FULL
  reply before the FIRST sentence's audio is sent, which this still does.
  A brief pause consuming new `generate_reply_stream` deltas while one
  sentence's synthesis is in flight is an acceptable, invisible-to-the-user
  trade-off for that simplicity.
- **Each turn now runs as its own `asyncio.Task`, and each turn gets its
  own freshly-opened `AsyncSession`** (via `async_session_factory()`
  directly, NOT the connection-scoped session `Depends(get_session)` used
  to inject) - this is the change that makes barge-in SAFE. Cancelling a
  task mid-DB-write on a session SHARED with the rest of the connection
  could corrupt that shared session's transaction state for whatever runs
  next; cancelling a task that owns its own session just means that
  session's `async with` block unwinds and rolls back/closes cleanly,
  affecting nothing else. `voice_session` itself no longer needs
  `Depends(get_session)` at all as a result - remove that parameter.
- **No new "barge-in" WS event type.** The backend's only job is: before
  starting a new turn's task, cancel any still-running previous one. The
  frontend already resets its transient reply-streaming state every time a
  `user_message` event arrives (Phase 1); Phase 2 just extends that same
  handler to also stop/clear whatever audio was queued or playing - no
  extra signal needed, and no race between a hypothetical separate event
  and the `user_message` that always immediately follows it anyway.
- **A synthesis (TTS) failure for one sentence is swallowed, not
  propagated** - unlike an `LLMError` from `generate_reply_stream` itself
  (which still ends the turn with a `VoiceErrorEvent`, per Phase 1), a
  failed `synthesize_speech` call for one sentence just means that
  sentence has no audio; text streaming and the rest of the reply continue
  completely unaffected, per the spec's explicit "degrades to text-only"
  requirement.
- **Audio is sent as base64 inside a JSON `audio_chunk` event, not a
  separate binary WS frame.** Every other voice-session event is already
  JSON; mixing frame types would complicate both the backend's send path
  and the frontend's `onmessage` handler for no real benefit at
  short-sentence-clip sizes.
- **`ChatPage.tsx` needs zero changes.** Playback (queueing, sequencing,
  stopping/clearing on interruption) is fully internal to
  `useVoiceConversationSession` - the page component's four existing
  callbacks are untouched.

---

### Task 1: Backend - sentence-boundary buffer

**Files:**
- Create: `backend/app/chat/sentence_buffer.py`
- Test: `backend/tests/test_sentence_buffer.py`

**Contracts:**

```python
# backend/app/chat/sentence_buffer.py
_SENTENCE_TERMINATORS = (".", "!", "?")


class SentenceBuffer:
    """Re-groups a stream of small text deltas (as generate_reply_stream
    yields them) into complete sentences, so a caller can trigger TTS
    synthesis as soon as each sentence is ready instead of waiting for the
    whole reply. A simple heuristic, deliberately not a full NLP
    tokenizer (see the spec's Non-Goals) - good enough to trigger
    synthesis promptly, not required to be linguistically perfect."""

    def __init__(self) -> None: ...

    def add(self, delta: str) -> list[str]:
        """Appends `delta` to the internal buffer, then extracts every
        NEWLY complete sentence it can find: a terminator character
        (`.`/`!`/`?`) that is followed by at least one whitespace
        character already present in the buffer. A terminator with
        nothing (yet) after it is NOT treated as complete - more text may
        still be coming in a future delta - it stays buffered. A single
        delta can complete more than one short sentence at once (e.g. a
        delta like " Yes. No." arriving after enough prior buffered text) -
        returns all of them, in order, as a list (usually empty or
        length 1, but callers must handle more). Whatever remains after
        every complete sentence is extracted stays in the buffer for the
        next call."""
        ...

    def flush(self) -> str | None:
        """Called once the underlying reply stream is exhausted - returns
        whatever text is still buffered (WITH its trailing terminator if
        it has one, even without confirming whitespace after it, since
        the stream is definitively over), trimmed. Returns None if
        nothing (or only whitespace) remains buffered."""
        ...
```

**Step 1: Write the failing tests**

`test_sentence_buffer.py`:
- Feeding `["Hel", "lo there", ". How", " are you?"]` one delta at a time:
  `add()` returns `[]` for the first three calls, then `["Hello there."]`
  on the fourth call fed by-word up to `". How"` (once whitespace after
  the `.` is confirmed) - implementer picks exact split points to prove
  a terminator mid-delta with no trailing text yet buffers, not fires
  early.
- A single `add()` call whose newly-appended text contains two complete
  sentences at once (e.g. buffer already has enough prior text, then one
  delta like `" Yes. No. "` arrives) returns both sentences in one list,
  in order.
- Trailing text with no terminator ever arriving via `add()` (e.g. ends
  on `"and so"`) - every `add()` call returns `[]`; `flush()` returns
  `"and so"`.
- A reply that ends exactly on a terminator with nothing after it (e.g.
  last delta is `"Done."` and the stream ends there) - `add()` never
  fires for it (no trailing whitespace was ever seen), but `flush()`
  returns `"Done."` (the terminator is real, whitespace confirmation is
  only needed to disambiguate MORE text still coming, which isn't the
  case once the stream is genuinely over).
- `flush()` on an empty/never-fed buffer returns `None`.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_sentence_buffer.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contract above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_sentence_buffer.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/chat/sentence_buffer.py backend/tests/test_sentence_buffer.py
git commit -m "feat(chat): add sentence-boundary buffer for TTS chunking"
```

---

### Task 2: Backend - speech synthesis

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/app/chat/voice.py`
- Modify: `.env.example`
- Test: `backend/tests/test_chat_voice.py` (extend)
- Reference: `backend/app/chunks/embedding.py`'s `embed_texts`/`get_client`/
  `LLMError` pattern (reused, not duplicated)

**Contracts:**

```python
# backend/app/config.py - add to Settings, near openai_chat_model
openai_tts_model: str = "tts-1"
# One of OpenAI's fixed voice names (alloy/echo/fable/onyx/nova/shimmer,
# per the SDK's own Voice literal type) - a single deployment-wide voice,
# no per-user/per-message selection (see the spec's Non-Goals).
openai_tts_voice: str = "alloy"
```

```python
# backend/app/chat/voice.py - add
from openai import AsyncOpenAI

from app.chunks.embedding import LLMError, get_client  # reused, not duplicated


async def synthesize_speech(text: str, client: AsyncOpenAI | None = None) -> bytes:
    """Synthesizes `text` to speech via get_settings().openai_tts_model/
    openai_tts_voice, response_format="mp3" (small, universally decodable
    by a browser <audio>/Web Audio API element - each call synthesizes one
    already-complete short sentence, not a continuous stream, so there's
    no container-streaming complexity to handle). Returns the complete
    clip's raw bytes (`await response.aread()` - HttpxBinaryResponseContent,
    not a plain awaited bytes value). Raises LLMError on any SDK failure,
    same contract as embed_texts/generate_reply - callers don't need a
    separate exception type for a third OpenAI-backed capability.
    `client` defaults to get_client() - tests inject a fake."""
    ...
```

```text
# .env.example - add near the other commented-optional-override block
# (OPENAI_EMBEDDING_MODEL/OPENAI_CHAT_MODEL)
# OPENAI_TTS_MODEL=tts-1
# OPENAI_TTS_VOICE=alloy
```

**Step 1: Write the failing tests**

Extend `test_chat_voice.py`, following `test_llm.py`'s existing
`client.chat.completions.create = AsyncMock(...)` mocking idiom but for
`client.audio.speech.create`: mock it to return a `MagicMock` whose
`aread` is an `AsyncMock(return_value=b"fake-mp3-bytes")`.
- `synthesize_speech("Hello", client=client)` -> returns `b"fake-mp3-bytes"`;
  assert `client.audio.speech.create` was awaited with
  `model=get_settings().openai_tts_model`,
  `voice=get_settings().openai_tts_voice`, `input="Hello"`,
  `response_format="mp3"`.
- `client.audio.speech.create` raising -> `synthesize_speech` raises
  `LLMError`.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_voice.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q`
Expected: PASS, no regressions.

**Step 4: Commit**

```bash
git add backend/app/config.py backend/app/chat/voice.py .env.example backend/tests/test_chat_voice.py
git commit -m "feat(chat): add OpenAI TTS speech synthesis"
```

---

### Task 3: Backend - cancellable per-turn tasks (barge-in) + sentence-buffered TTS

**Files:**
- Modify: `backend/app/chat/router.py`
- Modify: `backend/app/chat/schemas.py`
- Test: `backend/tests/test_chat_router.py` (extend)
- Reference: `backend/app/db/session.py`'s `async_session_factory` (used
  directly here, not `Depends(get_session)`)

**Contracts:**

```python
# backend/app/chat/schemas.py - add
class VoiceAudioChunkEvent(BaseModel):
    type: Literal["audio_chunk"] = "audio_chunk"
    audioBase64: str
```

```python
# backend/app/chat/router.py - voice_session's signature loses its session
# param (no longer used at this level - see this plan's design notes):
@router.websocket("/chat/voice-session")
async def voice_session(
    websocket: WebSocket,
    user_email: str = Depends(require_session),
) -> None:
    """... (existing docstring content, plus:) Each finalized turn now runs
    as its own asyncio.Task (current_turn_task, a local var closed over by
    _decode_loop) instead of being awaited inline. Whenever a NEW segment
    finalizes with non-empty text while a PREVIOUS turn's task is still
    running (`current_turn_task is not None and not
    current_turn_task.done()`), that previous task is cancelled
    (`current_turn_task.cancel()`) - not awaited, not otherwise handled;
    see this plan's design notes for why a bare cancel() is sufficient and
    safe here - before starting the new one via
    `asyncio.create_task(_handle_finalized_turn(...))`."""
    ...


async def _handle_finalized_turn(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    text: str,
) -> None:
    """Same 4-step shape as Phase 1 (insert user row + announce, embed +
    retrieve, stream + synthesize, insert assistant row + announce), with
    two changes:

    0. Opens ITS OWN session for the whole function body:
       `async with async_session_factory() as session:` (imported from
       app.db.session) - NOT a session passed in from the caller. This is
       what makes cancelling this task safe: nothing outside this
       function's own `async with` block is ever touched, so a
       CancelledError at any point just unwinds this block, rolling back/
       closing this turn's own session, with zero effect on any other
       turn's task or on the connection itself.

    3. (replaces Phase 1's step 3) A `SentenceBuffer` is fed every delta
       ALONGSIDE sending it as a VoiceReplyDeltaEvent (that part is
       unchanged - text streaming is untouched, per the spec). Whenever
       `sentence_buffer.add(delta)` returns one or more completed
       sentences, each is synthesized and sent, IN ORDER, via a small
       helper (see below) BEFORE resuming consumption of more deltas from
       generate_reply_stream (sequential, not concurrent - see this
       plan's design notes on why). Once the reply stream is exhausted,
       `sentence_buffer.flush()`'s result (if any) is synthesized and sent
       the same way, covering whatever trailing text never ended in a
       terminator."""
    ...


async def _synthesize_and_send_sentence(
    websocket: WebSocket, send_lock: asyncio.Lock, sentence: str
) -> None:
    """Synthesizes `sentence` via voice.synthesize_speech and sends it as
    a base64-encoded VoiceAudioChunkEvent under send_lock. An LLMError from
    synthesis is caught and swallowed HERE (not re-raised) - per the
    spec's "TTS failure degrades that one reply to text-only" requirement,
    this must never abort the turn the way a generate_reply_stream failure
    does."""
    ...
```

**Integration:** `_handle_finalized_turn` now imports `SentenceBuffer` from
`app.chat.sentence_buffer`, `synthesize_speech` from `app.chat.voice`, and
`async_session_factory` from `app.db.session`. `voice_session` drops its
`session: AsyncSession = Depends(get_session)` parameter and the now-unused
`get_session`/`AsyncSession` imports it was the only user of (check the
rest of the file doesn't need them for something else before removing).

**Step 1: Write the failing tests**

Extend `test_chat_router.py`:
- Extend the existing `_handle_finalized_turn` direct-call tests (Phase
  1's happy-path test) to also assert `websocket.send_json` includes
  `audio_chunk` events between the `reply_delta` events, with
  `app.chat.voice.synthesize_speech` patched (mirror how
  `generate_reply_stream` is already patched) to return a fixed fake
  audio byte string - assert the sent event's `audioBase64` field
  base64-decodes back to those exact bytes.
- A patched `synthesize_speech` that raises `LLMError` for one sentence
  -> no `audio_chunk` event is sent for that sentence, but the turn
  completes normally otherwise (reply_delta events, assistant row,
  `reply_done` all still happen) - proves synthesis failures degrade to
  text-only rather than aborting the turn.
- **Barge-in / cancellation test** (the important new one): drive this
  through the real `voice_session` WebSocket route (same
  `client.websocket_connect` + `FakeStreamingAudioDecoder` +
  fake-`vosk.KaldiRecognizer` setup Phase 1's own WS tests already use),
  with `_handle_finalized_turn` (or `generate_reply_stream` underneath it)
  patched so the FIRST finalized turn's execution can be held open under
  test control (e.g. an `asyncio.Event` the test controls, or a patched
  `generate_reply_stream` that yields one delta then awaits an `Event`
  before yielding more) - script the fake recognizer to finalize a SECOND
  segment while the first is still "in progress" this way. Assert: the
  first turn's own `chat_messages` assistant row is NEVER created (the
  turn was cancelled before completing), the SECOND turn's user row IS
  created and gets a real reply, and no stray `reply_delta`/`audio_chunk`
  events belonging to the cancelled first turn arrive after the
  cancellation point. This is genuinely new territory (testing real
  asyncio task cancellation over a live WebSocket test connection) -
  budget real time for it; a `_wait_until`-style polling helper (Phase
  1's own WS tests already established this pattern) will likely be
  needed again here.

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
git commit -m "feat(chat): synthesize and stream sentence audio, with barge-in via cancellable turn tasks"
```

---

### Task 4: Frontend - audio playback + barge-in in `useVoiceConversationSession`

**Files:**
- Modify: `frontend/src/pages/useVoiceConversationSession.ts`
- Modify: `frontend/src/pages/useVoiceConversationSession.test.ts`
- Reference: this file's own existing `teardown`/`routeIncomingEvent`
  shape (extend, don't restructure)

**Contracts:**

```typescript
// frontend/src/pages/useVoiceConversationSession.ts

// Add 'audio_chunk' to the discriminated union:
type VoiceSessionEvent =
  | { type: 'user_message'; id: string; content: string }
  | { type: 'reply_delta'; content: string }
  | { type: 'reply_done'; id: string; noAnswerFound: boolean }
  | { type: 'audio_chunk'; audioBase64: string }
  | { type: 'error'; detail: string }
```

Inside `useVoiceConversationSession`, add:
- `audioQueueRef = useRef<string[]>([])` - pending object URLs not yet
  played.
- `currentAudioRef = useRef<HTMLAudioElement | null>(null)` - the clip
  currently playing, if any.
- `playNextQueuedAudio()`: if `currentAudioRef.current` is already playing,
  does nothing (called again once the current clip ends). Otherwise pops
  the next URL off `audioQueueRef`, if any; if none, does nothing. Creates
  `new Audio(url)`, stores it in `currentAudioRef`, wires its `onended`
  (and `onerror`, treated the same as ended - one bad clip shouldn't wedge
  the queue) to revoke that object URL (`URL.revokeObjectURL`), clear
  `currentAudioRef`, and recursively call `playNextQueuedAudio()` again,
  then calls `.play()`.
- `stopAndClearAudioQueue()`: stops+clears `currentAudioRef` if set
  (`.pause()`, revoke its URL), revokes every URL still in
  `audioQueueRef`, empties the queue. Used by: the barge-in handling
  below, AND by `teardown()` (so ending the session mid-playback silences
  immediately, per the spec's last acceptance criterion).

On receiving an `audio_chunk` event: decode `audioBase64` (`atob`, then
build a `Uint8Array`/`Blob` with `type: 'audio/mp3'`), create an object
URL, push it onto `audioQueueRef`, then call `playNextQueuedAudio()`.

**Barge-in**: right before invoking `callbacks.onUserMessage(...)` for a
NEW `user_message` event, first call `stopAndClearAudioQueue()` - this is
the ENTIRE barge-in mechanism on the frontend side (see this plan's design
notes on why no separate event/signal is needed - a new `user_message`
arriving IS the signal that any previous turn's audio is now stale).

`teardown()` additionally calls `stopAndClearAudioQueue()` alongside its
existing recorder/stream/socket cleanup.

**Step 1: Write the failing tests**

Extend `useVoiceConversationSession.test.ts`. jsdom's `Audio`/`atob` exist
but real playback doesn't - stub `window.Audio` with a small fake class
(`play`/`pause` as `vi.fn()`s, an `onended`/`onerror` field the test fires
manually, matching this file's existing `FakeWebSocket`/`FakeMediaRecorder`
philosophy of driving events by hand rather than relying on real timing).
`URL.createObjectURL`/`revokeObjectURL` need stubbing too (jsdom typically
lacks real implementations) - `vi.fn()` returning a fake incrementing URL
string is enough, no real Blob decoding needs to succeed for these tests.
- One `audio_chunk` event -> a fake `Audio` is constructed and `.play()`
  called.
- Two `audio_chunk` events arriving before the first clip finishes ->
  the second doesn't start playing yet (only one `Audio` instance's
  `.play()` has been called); firing the first fake `Audio`'s `onended`
  starts the second (a new `Audio` constructed, `.play()` called on it) -
  proves sequential, not overlapping, playback.
- A `user_message` event arriving while a clip is mid-playback (queue also
  has a pending second clip) -> the currently-playing `Audio`'s `.pause()`
  is called, `URL.revokeObjectURL` is called for both the playing clip's
  URL and the still-queued one's URL, and a THIRD subsequent `audio_chunk`
  event afterward starts fresh (its own new `Audio`, nothing left over
  from before).
- `stop()` while a clip is playing also pauses it and revokes its URL
  (same assertion shape as the `user_message`-triggers-barge-in case
  above, via `teardown()`).

Run: `cd frontend && npx vitest run src/pages/useVoiceConversationSession.test.ts`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run` (full suite) and `npx tsc -b`.
Expected: PASS, no regressions, no type errors. Confirm via `git diff`
that `ChatPage.tsx` was NOT touched (per this plan's design notes, it
needs no changes).

**Step 4: Commit**

```bash
git add frontend/src/pages/useVoiceConversationSession.ts frontend/src/pages/useVoiceConversationSession.test.ts
git commit -m "feat(chat): play synthesized reply audio with barge-in support"
```

---

### Task 5: Full regression + live smoke test

**Files:** None new - verification only.

**Step 1:** `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q` - PASS.

**Step 2:** `cd frontend && npx vitest run && npx tsc -b` - PASS, no type
errors.

**Step 3:** `docker compose up -d --build backend worker frontend` - confirm
`docker compose ps` shows backend healthy. (Give it a extra beat if health
briefly flaps right after a rebuild - this has happened before on this
machine and always settled within ~30s.)

**Step 4:** Live smoke test. This feature is much harder to verify by ear
programmatically than by DB/event inspection - lean on the same real
end-to-end approach that caught a real bug in Phase 1 (a headless Chromium
launch with `--use-fake-device-for-media-stream` +
`--use-file-for-fake-audio-capture=<a synthesized WAV>`, driving the app
through a throwaway user, same as Phase 1's own smoke test) rather than
trusting unit tests alone:
- Confirm `audio_chunk` events actually arrive over the WS with non-empty
  `audioBase64` payloads (log/inspect frames, same technique used in
  Phase 1's own debugging), interleaved with `reply_delta` events - not
  bunched all at the end.
- Confirm no JS console errors from audio playback (autoplay policy
  issues, decode failures) - Chromium launched with fake-media flags
  generally does not require an autoplay user gesture the way a real
  visit would, but check for `NotAllowedError`-shaped console errors
  specifically, since that's the most likely real-world friction point
  for this feature outside of testing.
- Best-effort barge-in check: let a session run long enough (the fake
  device's looping WAV naturally produces several distinct finalized
  segments over time, per Phase 1's own experience) to likely produce a
  second finalized turn while a first one's reply/audio is still in
  flight; afterward, query `chat_messages` directly and confirm the
  interrupted turn's user row exists with no matching assistant row
  (`question_id` pointing at it), while the turn that came after it does
  have a complete pair - this is the same DB-level verification technique
  already proven out in Phase 1, and doesn't depend on being able to
  literally judge audio interruption by ear.
- Clean up: revoke the throwaway user, delete any seeded `chat_messages`
  rows this run created (same as every prior live check this session).

**Step 5: Commit** (only if Steps 1-2 required fixes)

```bash
git add -A
git commit -m "test: fix regressions found during voice-conversation-mode-phase-2 smoke testing"
```
