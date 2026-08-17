# Voice Recognition in Chat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an operator dictate a chat question by voice on ChatPage,
transcribed offline by a locally-hosted Vosk model, landing in the message
input box for review before sending - per `.claude/specs/voice-recognition.md`.

**Architecture:** Backend: a new `app/chat/voice.py` module wraps two
external boundaries behind one `transcribe_audio()` call - ffmpeg (via
`subprocess`, decodes whatever container/codec the browser's MediaRecorder
produced into mono 16kHz PCM WAV) and Vosk (`vosk.Model` +
`vosk.KaldiRecognizer`, offline speech-to-text against a single
operator-installed model). A new `POST /internal/chat/transcribe` endpoint on
the existing `chat_router` accepts one recorded clip (same bounded-read/size-
cap discipline as `documents/router.py`'s upload endpoint) and returns its
transcribed text - no DB write, no dashboard event, stateless. Frontend:
`ChatPage.tsx` gets a mic `ActionIcon` next to the message input, using the
browser's `MediaRecorder`/`getUserMedia` APIs to record, then POSTs the clip
and replaces the draft with the returned text - the user still has to press
Send. Model files are never bundled - `backend/data/vosk_models/` (already
created, already `.gitignore`d) is where an operator drops an unzipped model,
pointed at via a new `VOSK_MODEL_PATH` setting.

**Tech Stack:** `vosk` (new pip dependency, offline Kaldi-based STT), `ffmpeg`
(new system dependency in `backend/Dockerfile`, audio decode/resample) on the
backend; the browser's native `MediaRecorder`/`navigator.mediaDevices` APIs
(no new frontend package) on the frontend. Everything else follows this
codebase's existing FastAPI/raw-SQL and React/Mantine/TypeScript patterns.

---

## Key design decisions (read before starting)

- **Record-then-send, not streaming** - the browser records a complete clip,
  then uploads it once on stop. Simpler than a WebSocket streaming
  recognizer, at the cost of not showing partial text while speaking. This
  was an explicit choice over the streaming alternative (see the spec's
  Non-Goals).
- **One configured model, no in-UI language switcher** - `VOSK_MODEL_PATH`
  points at exactly one unzipped model directory. Multi-model/multi-language
  support is explicitly out of scope for this version.
- **Transcribed text always REPLACES the current draft**, it never appends to
  or merges with whatever was already typed. The spec left this as an open
  question; replacing is the simplest, most predictable behavior and avoids
  inventing concatenation/cursor-position semantics for what should be a rare
  edge case (dictating after already typing something). Push back if this
  reads wrong once it's live.
- **The mic control is always visible**, even with no model configured -
  clicking it still records and uploads, and the resulting 503 is what
  surfaces the "model not installed" message. This matches the spec's chosen
  resolution: errors surface on use rather than hiding the control.
- **No new DB table, no dashboard_events row.** Transcription is a stateless
  utility call - a chat_messages row is only ever created when the operator
  presses Send on the (possibly-edited) resulting text, through the existing
  `POST /chat/messages` path. Nothing here changes that endpoint.
- **The upload size cap reuses `get_settings().max_upload_size_bytes`** (the
  same 10MB default `documents/router.py` already enforces) rather than
  introducing a separate voice-specific limit or a duration cap - this
  answers the spec's "does the clip need a hard cap" open question
  pragmatically: at typical MediaRecorder bitrates, 10MB is minutes of audio,
  comfortably enough for a dictated chat question.
- **`_read_upload_within_limit` is duplicated, not imported, from
  `documents/router.py`.** It's a small (~10 line), self-contained guard: for
  one, importing a `_`-prefixed helper across router modules is worse
  layering than a short local copy; this keeps `chat/router.py` from
  depending on `documents/router.py` for an unrelated concern.
- **`transcribe_audio` resolves the model FIRST, before touching ffmpeg** -
  so an unconfigured deployment fails fast (and its own test never needs to
  mock subprocess/ffmpeg at all) instead of spending time decoding audio it's
  about to reject anyway.
- **ffmpeg output is read via the stdlib `wave` module, not fed to Vosk raw**
  - a WAV file's ~44-byte header would otherwise be interpreted by
  `KaldiRecognizer.AcceptWaveform` as bogus leading audio samples. `wave`
  strips it and hands back only the actual PCM frames.
- **Transcription runs in the FastAPI request path via `asyncio.to_thread`**,
  not a Celery task - a single short clip through ffmpeg+Kaldi is fast
  (roughly sub-second to a few seconds for the small model), so there's no
  need for the background-job machinery `documents`/`analysis` use for
  longer-running work; `asyncio.to_thread` just keeps the blocking
  subprocess/CPU work off the event loop.

---

### Task 1: Backend voice service - config, ffmpeg conversion, Vosk transcription

**Files:**
- Modify: `backend/app/config.py`
- Create: `backend/app/chat/voice.py`
- Test: `backend/tests/test_chat_voice.py`
- Reference: `backend/app/chunks/embedding.py` (the `LLMError`/`@lru_cache`-
  getter/`client: X | None = None`-for-testability pattern to mirror)

**Contracts:**

```python
# backend/app/config.py - add to Settings
# Absolute or CWD-relative path to an unzipped Vosk model directory (e.g.
# "./data/vosk_models/vosk-model-small-ru-0.22") - operator-installed, never
# bundled with the app (see backend/data/vosk_models/, .gitignore'd, and the
# README's voice-recognition setup section). Empty (default) means voice
# input is unconfigured - app/chat/voice.py's _get_model() is what actually
# enforces "gracefully unavailable, not a crash" for that, same convention as
# openai_api_key/slack_bot_token above.
vosk_model_path: str = ""
```

```python
# backend/app/chat/voice.py
from functools import lru_cache

import vosk

from app.config import get_settings

# Silences Kaldi's default stderr logging spam - set once at import time.
vosk.SetLogLevel(-1)

TARGET_SAMPLE_RATE_HZ = 16000


class VoiceRecognitionUnavailableError(Exception):
    """No VOSK_MODEL_PATH is configured, or the configured path isn't a
    loadable Vosk model directory - see get_settings().vosk_model_path."""


class AudioConversionError(Exception):
    """ffmpeg failed to decode/convert the uploaded clip (e.g. empty or
    corrupt audio, or ffmpeg isn't installed/on PATH). Message includes
    ffmpeg's own stderr output for diagnosis."""


@lru_cache
def _get_model() -> vosk.Model:
    """Loads the configured Vosk model once per process (vosk.Model(path) is
    expensive - reads the whole model into memory) and caches it for the
    life of the process. Raises VoiceRecognitionUnavailableError if
    get_settings().vosk_model_path is empty or not a directory - this
    exception is NOT cached by lru_cache (functools only caches successful
    returns), so a later config fix doesn't need a process restart to take
    effect. Tests never call this directly - they pass their own `model` into
    transcribe_audio below instead; a test-only fixture clears this cache
    the same way test_llm.py's _clear_client_cache fixture clears
    embedding.get_client's."""
    ...


def convert_to_pcm_wav(audio_bytes: bytes) -> bytes:
    """Shells out to ffmpeg (`subprocess.run`, input piped via stdin, output
    read from stdout - no temp files) to decode `audio_bytes` (whatever
    container/codec the browser's MediaRecorder produced, e.g. webm/opus)
    into mono 16-bit PCM WAV at TARGET_SAMPLE_RATE_HZ:
    `ffmpeg -i pipe:0 -ar 16000 -ac 1 -f wav pipe:1` (plus `-hide_banner
    -loglevel error` to keep stderr limited to real failures). Raises
    AudioConversionError, with ffmpeg's stderr decoded into the message, if
    the process exits non-zero."""
    ...


def transcribe_audio(audio_bytes: bytes, model: vosk.Model | None = None) -> str:
    """Full pipeline for one recorded clip. Order matters (see this plan's
    design notes): resolves `model` (defaults to _get_model(), which raises
    VoiceRecognitionUnavailableError if unconfigured) BEFORE calling
    convert_to_pcm_wav, so an unconfigured deployment fails fast without
    spending time on ffmpeg. Then:
    1. wav_bytes = convert_to_pcm_wav(audio_bytes) - raises
       AudioConversionError.
    2. Opens wav_bytes via the stdlib `wave` module (io.BytesIO-wrapped) and
       reads ALL frames as one bytes blob - never feeds the raw WAV bytes
       (header included) straight to Kaldi.
    3. recognizer = vosk.KaldiRecognizer(model, TARGET_SAMPLE_RATE_HZ);
       recognizer.AcceptWaveform(<the frames from step 2>).
    4. Returns json.loads(recognizer.FinalResult())["text"] - an empty
       string for silence/no speech detected is a valid, non-error result
       (Vosk's own FinalResult already returns {"text": ""} for that case).

    `model` is None in production (resolves via _get_model()); tests pass a
    real-enough fake so this function's own logic (frame extraction, JSON
    parsing) is exercised without a real model file - see Step 1 below for
    exactly how to fake vosk.KaldiRecognizer for that."""
    ...
```

**Step 1: Write the failing tests**

`test_chat_voice.py`:
- `_get_model`: with `get_settings().vosk_model_path == ""` (monkeypatch
  `app.config.get_settings` or construct+monkeypatch a `Settings` instance,
  matching `test_llm.py`'s settings-monkeypatch idiom) -> raises
  `VoiceRecognitionUnavailableError`, and `subprocess.run`/`vosk.Model` are
  never touched (assert via a `MagicMock` substituted for `vosk.Model` that
  `assert_not_called()`).
- `convert_to_pcm_wav`: monkeypatch `app.chat.voice.subprocess.run` to a
  `MagicMock(returncode=0, stdout=b"fake-wav-bytes", stderr=b"")` -> asserts
  the command list passed to `subprocess.run` includes `"ffmpeg"`,
  `"-ar"`/`"16000"`, `"-ac"`/`"1"`, and that the function returns
  `b"fake-wav-bytes"`. A second case with `returncode=1, stderr=b"boom"` ->
  raises `AudioConversionError` whose message contains `"boom"`.
- `transcribe_audio`: monkeypatch `app.chat.voice.convert_to_pcm_wav` to
  return real, tiny, valid WAV bytes (generate with the stdlib `wave` module
  in the test itself - a few hundred silent PCM frames at 16kHz mono 16-bit
  is enough, no real ffmpeg needed), and monkeypatch
  `app.chat.voice.vosk.KaldiRecognizer` to a factory returning a
  `MagicMock(AcceptWaveform=MagicMock(), FinalResult=MagicMock(return_value='{"text": "hello world"}'))`
  -> `transcribe_audio(b"whatever", model=MagicMock())` returns
  `"hello world"`. Assert `AcceptWaveform` was called with the WAV's raw
  frames (not the full WAV bytes - i.e. shorter than the input, no
  `RIFF`/`WAVE` header bytes present in what it was called with).
- `transcribe_audio` with `model=None` and `vosk_model_path=""` (monkeypatched
  settings) -> raises `VoiceRecognitionUnavailableError` without
  `convert_to_pcm_wav` being called (monkeypatch it to a `MagicMock` and
  assert `assert_not_called()`).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_voice.py -v`
Expected: FAIL (module doesn't exist yet)

**Step 2: Implement**

Add `vosk_model_path` to `Settings` per the contract above. Implement
`backend/app/chat/voice.py` per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_voice.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/config.py backend/app/chat/voice.py backend/tests/test_chat_voice.py
git commit -m "feat(chat): add Vosk-based voice transcription service"
```

---

### Task 2: Backend endpoint - `POST /internal/chat/transcribe`

**Files:**
- Modify: `backend/app/chat/schemas.py`
- Modify: `backend/app/chat/router.py`
- Test: `backend/tests/test_chat_router.py`
- Reference: `backend/app/documents/router.py`'s `_read_upload_within_limit`
  (shape to duplicate locally, see this plan's design notes on why it's not
  imported) and `upload_document`'s `UploadFile` handling

**Contracts:**

```python
# backend/app/chat/schemas.py - add
class TranscriptionResult(BaseModel):
    text: str
```

```python
# backend/app/chat/router.py - add
from fastapi import UploadFile

from app.chat.voice import (
    AudioConversionError,
    VoiceRecognitionUnavailableError,
    transcribe_audio,
)

_VOICE_MODEL_NOT_CONFIGURED_ERROR = "voice_model_not_configured"
_AUDIO_PROCESSING_FAILED_ERROR = "audio_processing_failed"

# Local duplicate of documents/router.py's _read_upload_within_limit - see
# this plan's design notes for why this isn't a shared cross-router import.
_UPLOAD_READ_CHUNK_SIZE = 1024 * 1024


async def _read_upload_within_limit(file: UploadFile, max_bytes: int) -> bytes:
    ...  # identical shape to documents/router.py's version


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
    ...
```

**Step 1: Write the failing tests**

Extend `test_chat_router.py`, following its existing
`authenticated_client`/`files={...}` conventions (see
`test_documents_router.py`'s `io.BytesIO`-based upload tests for the exact
multipart shape):
- `POST /internal/chat/transcribe` with a small fake audio payload, with
  `app.chat.router.transcribe_audio` patched (`unittest.mock.patch`, same
  idiom `test_documents_router.py` uses for `run_document_pipeline.delay`)
  to return `"what is the refund policy"` -> 200,
  `{"text": "what is the refund policy"}`.
- Same, but the patched `transcribe_audio` raises
  `VoiceRecognitionUnavailableError` -> 503,
  `detail == "voice_model_not_configured"`.
- Same, but raises `AudioConversionError` -> 400,
  `detail == "audio_processing_failed"`.
- A payload larger than a monkeypatched, small `max_upload_size_bytes` ->
  413 (mirror `test_documents_router.py`'s own oversized-upload test).
- No session cookie -> 401 (same one-line pattern as this file's other
  endpoint tests).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_router.py -v`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q`
Expected: PASS, no regressions.

**Step 4: Commit**

```bash
git add backend/app/chat/schemas.py backend/app/chat/router.py backend/tests/test_chat_router.py
git commit -m "feat(chat): add POST /chat/transcribe endpoint"
```

---

### Task 3: Packaging - vosk dependency, ffmpeg, config docs

**Files:**
- Modify: `backend/requirements.txt`
- Modify: `backend/Dockerfile`
- Modify: `.env.example`

**Contracts:**

```text
# backend/requirements.txt - add (alongside the other exact-pinned entries)
vosk==0.3.45
```

```dockerfile
# backend/Dockerfile - add before `RUN pip install`, so ffmpeg is cached in
# its own layer separately from the requirements.txt-triggered layer
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

```text
# .env.example - add near the other optional-override block
# Path (inside the backend/worker containers) to an unzipped Vosk speech
# model directory - powers the Chat page's voice-dictation mic button.
# Optional: empty means voice input is unconfigured and the mic button's
# transcribe calls fail with a clear "not installed" error instead of
# working - see README's Voice Recognition section for how to download and
# install a model. Models live under backend/data/vosk_models/ (shared with
# the documind_storage volume, same as uploaded documents), NOT committed to
# git - place a model there yourself, e.g.:
# VOSK_MODEL_PATH=./data/vosk_models/vosk-model-small-ru-0.22
VOSK_MODEL_PATH=
```

**Step 1: Verify the image builds**

Run: `docker compose build backend`
Expected: succeeds, `ffmpeg -version` runs inside the built image (spot
check: `docker compose run --rm backend ffmpeg -version`).

**Step 2: Commit**

```bash
git add backend/requirements.txt backend/Dockerfile .env.example
git commit -m "chore(chat): add vosk dependency, ffmpeg, VOSK_MODEL_PATH config"
```

---

### Task 4: Frontend API client - `transcribeVoice`

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/httpClient.ts`
- Modify: `frontend/src/api/mockClient.ts`
- Test: `frontend/src/api/httpClient.test.ts`

**Contracts:**

```typescript
// frontend/src/api/client.ts - add to ApiClient interface
/** POST /internal/chat/transcribe - uploads one recorded audio clip, returns its transcribed text. Throws VoiceUnavailableError (503) if no Vosk model is configured server-side. */
transcribeVoice(audioBlob: Blob): Promise<string>
```

```typescript
// frontend/src/api/httpClient.ts - add near ChatCompletionError
/** Thrown when POST /internal/chat/transcribe fails with 503 (no Vosk model configured server-side). */
export class VoiceUnavailableError extends Error {
  constructor(message = 'voice_model_not_configured') {
    super(message)
    this.name = 'VoiceUnavailableError'
  }
}
```

`throwForStatus` gets one more branch, alongside the existing 409/502 ones:
```typescript
if (response.status === 503 && detail === 'voice_model_not_configured') {
  throw new VoiceUnavailableError()
}
```

`httpApiClient.transcribeVoice`:
```typescript
async transcribeVoice(audioBlob) {
  const formData = new FormData()
  formData.set('file', audioBlob, 'recording.webm')
  const result = await requestJson<{ text: string }>('/internal/chat/transcribe', {
    method: 'POST',
    body: formData,
  })
  return result.text
},
```

`mockClient.ts`: `async transcribeVoice(_audioBlob) { return 'mock transcribed text' }`
- follows this file's existing plain-canned-return style (e.g.
  `getTopMatchingChunks`), no seeded array needed.

**Step 1: Write the failing test**

`httpClient.test.ts`: mock `fetch` to assert `transcribeVoice(blob)` POSTs to
`/internal/chat/transcribe` with a `FormData` body containing the blob under
key `"file"`, and returns the parsed `text` string from a `{ text: "..." }`
JSON response. A second case: `fetch` resolves with `status: 503`,
`detail: 'voice_model_not_configured'` -> rejects with `VoiceUnavailableError`.

Run: `cd frontend && npx vitest run src/api/httpClient.test.ts`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run src/api/httpClient.test.ts` and `npx tsc -b`
Expected: PASS, no type errors (mockClient.ts must still satisfy `ApiClient`).

**Step 4: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/httpClient.ts frontend/src/api/mockClient.ts frontend/src/api/httpClient.test.ts
git commit -m "feat(chat): add transcribeVoice API client method"
```

---

### Task 5: ChatPage - mic button, recording/transcribing states

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`
- Modify: `frontend/src/pages/ChatPage.test.tsx`
- Reference: `ChatPage.tsx`'s existing `SendIcon`/`ThumbsDownIcon`
  hand-rolled-SVG convention, `sendFailed`/`isSending` state-and-`Alert`
  pattern for `handleSend`

**Contracts:**

```typescript
// frontend/src/pages/ChatPage.tsx
import { VoiceUnavailableError } from '../api/httpClient'

type MicState = 'idle' | 'recording' | 'transcribing'

const VOICE_UNAVAILABLE_MESSAGE =
  "Voice recognition isn't set up on the server yet - see the README's Voice Recognition section."
const VOICE_GENERIC_ERROR_MESSAGE = "Couldn't transcribe that - try again."

/** Hand-rolled mic glyph - same no-icon-library rationale as SendIcon/ThumbsDownIcon. */
function MicIcon(): JSX.Element { ... }
```

State additions inside `ChatPage()`:
- `micState: MicState` (default `'idle'`)
- `voiceError: string | null` (default `null`)
- `mediaRecorderRef = useRef<MediaRecorder | null>(null)`
- `recordedChunksRef = useRef<Blob[]>([])`

```typescript
async function handleMicClick(): Promise<void> {
  if (micState === 'recording') {
    mediaRecorderRef.current?.stop()  // triggers the 'stop' handler below
    return
  }
  if (micState !== 'idle') {
    return  // ignore clicks while transcribing
  }

  setVoiceError(null)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(stream)
    recordedChunksRef.current = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data)
      }
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop())
      void handleRecordingStopped()
    }
    mediaRecorderRef.current = recorder
    recorder.start()
    setMicState('recording')
  } catch {
    // getUserMedia rejected - no mic, permission denied, or unsupported API.
    setVoiceError(VOICE_GENERIC_ERROR_MESSAGE)
  }
}

async function handleRecordingStopped(): Promise<void> {
  setMicState('transcribing')
  const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' })
  try {
    const text = await apiClient.transcribeVoice(blob)
    setDraft(text)  // REPLACES the current draft - see this plan's design notes
  } catch (error) {
    setVoiceError(error instanceof VoiceUnavailableError ? VOICE_UNAVAILABLE_MESSAGE : VOICE_GENERIC_ERROR_MESSAGE)
  } finally {
    setMicState('idle')
  }
}
```

Render, inside the input `Paper`'s `Group`, before the existing send
`ActionIcon`:
```tsx
<ActionIcon
  aria-label={micState === 'recording' ? 'Stop recording' : 'Start voice input'}
  onClick={() => void handleMicClick()}
  disabled={isSending || micState === 'transcribing'}
  color={micState === 'recording' ? 'alertMagenta' : 'signalBlue'}
  radius="xl"
  size="xl"
  variant={micState === 'recording' ? 'filled' : 'outline'}
>
  {micState === 'transcribing' ? <Loader size="xs" color="white" /> : <MicIcon />}
</ActionIcon>
```

`voiceError` renders via the same `Alert` shape `sendFailed` already uses
(color `alertMagenta`, `withCloseButton`, `onClose` clears it) - placed
alongside/instead of the existing send-error `Alert` (both can independently
be non-null; render both if so, following the existing single-`Alert`
block's structure extended to a second one below it).

**Step 1: Write the failing tests**

Extend `ChatPage.test.tsx`. jsdom has no real `MediaRecorder`/
`getUserMedia` - stub both as this suite's `fetch` is already stubbed:

```typescript
class FakeMediaRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: MediaStream) {}
  start(): void {}
  stop(): void {
    this.ondataavailable?.({ data: new Blob(['fake-audio']) })
    this.onstop?.()
  }
}
```
Stub `navigator.mediaDevices.getUserMedia` (via
`vi.spyOn(navigator.mediaDevices, 'getUserMedia')` or
`Object.defineProperty`, whichever this project's jsdom setup allows -
check `frontend/src/test-utils.tsx`/`vitest.setup` for an existing
precedent before picking) to resolve a fake `MediaStream`-shaped object
with a no-op `getTracks: () => []`, and `vi.stubGlobal('MediaRecorder',
FakeMediaRecorder)`.

- Clicking the mic button starts "recording" (aria-label flips to "Stop
  recording", color/variant change is implementation detail - assert via
  aria-label and/or a `data-testid`).
- Clicking it again stops recording, which (via the fake's synchronous
  `stop()`) immediately fires `onstop` -> shows a "transcribing" state
  (assert the `Loader` or a `data-testid="voice-transcribing"`), calls
  `apiClient.transcribeVoice` (stub `fetch` to resolve `{ text: "hello" }`
  for that request), and once resolved sets the message input's value to
  `"hello"` (overwriting any prior draft - seed the input with existing text
  first to prove replacement, not concatenation).
- A stubbed 503-shaped `fetch` response for the transcribe call ->
  `VOICE_UNAVAILABLE_MESSAGE` shown in an alert.
- A stubbed generic-failure `fetch` response -> `VOICE_GENERIC_ERROR_MESSAGE`
  shown instead.
- `getUserMedia` rejecting (mock it to reject) -> `VOICE_GENERIC_ERROR_MESSAGE`
  shown, `micState` stays `'idle'`.

Run: `cd frontend && npx vitest run src/pages/ChatPage.test.tsx`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run` (full suite) and `npx tsc -b`
Expected: PASS, no regressions, no type errors.

**Step 4: Commit**

```bash
git add frontend/src/pages/ChatPage.tsx frontend/src/pages/ChatPage.test.tsx
git commit -m "feat(chat): add mic button for voice-dictated messages"
```

---

### Task 6: README - feature description + manual model install instructions

**Files:**
- Modify: `README.md`
- Modify: `README.ru.md` (this project maintains a parallel Russian
  translation - see its language-switcher badge in `README.md`'s header;
  keep both in sync)

**Contracts:**

Add a bullet to the existing Features list describing voice dictation in
Chat (mic button, offline/local Vosk recognition, transcribed text lands in
the input for review). Add a new "Voice Recognition" setup section (near the
existing OpenAI-key/Slack setup sections) covering, at minimum:
- Voice input is optional and off by default (empty `VOSK_MODEL_PATH`).
- Where to download a model: https://alphacephei.com/vosk/models (link to
  the official list, not a specific file - models/languages change over
  time). Name `vosk-model-small-ru-0.22` as the tested reference model.
- Unzip the downloaded model into `backend/data/vosk_models/` (create the
  path if needed - note it's `.gitignore`d, models are never committed).
- Set `VOSK_MODEL_PATH` in `.env` to the unzipped folder's path, e.g.
  `VOSK_MODEL_PATH=./data/vosk_models/vosk-model-small-ru-0.22`.
- Restart the backend/worker containers to pick up the new setting.
- Note the license varies by model (most Vosk models are Apache 2.0, but not
  all - link to the models page rather than asserting a blanket license).

**Step 1: Write the section**

No test - documentation only. Cross-check every path/env-var name mentioned
against Task 1-3's actual final names before writing (`VOSK_MODEL_PATH`,
`backend/data/vosk_models/`).

**Step 2: Commit**

```bash
git add README.md README.ru.md
git commit -m "docs(readme): document voice recognition feature and model setup"
```

---

### Task 7: Full regression + live smoke test

**Files:** None new - verification only.

**Step 1:** `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q` - PASS.

**Step 2:** `cd frontend && npx vitest run && npx tsc -b` - PASS, no type
errors.

**Step 3:** `docker compose up -d --build backend worker frontend`.

**Step 4:** Install a real model for the live check: unzip
`vosk-model-small-ru-0.22.zip` (already downloaded, sitting at the repo
root per this session's earlier setup) into
`backend/data/vosk_models/vosk-model-small-ru-0.22/`, set
`VOSK_MODEL_PATH=./data/vosk_models/vosk-model-small-ru-0.22` in `.env`,
restart the backend/worker containers so the setting takes effect.

**Step 5:** Live smoke test via a throwaway user (same idiom as this
project's earlier live checks - `app.auth.service.create_user`, clean up
afterward): open Chat, click the mic button, grant microphone permission,
speak a short Russian phrase, stop recording, confirm the transcribed text
appears in the input box (not auto-sent), edit it if needed, press Send, and
confirm the reply arrives normally. Then unset `VOSK_MODEL_PATH` (or point it
at a nonexistent path), restart, and confirm the mic button still records but
now surfaces the "not installed" error instead of transcribed text. Clean up
the throwaway user/session/seeded chat rows afterward.

**Step 6: Commit** (only if Steps 1-2 required fixes)

```bash
git add -A
git commit -m "test: fix regressions found during voice-recognition smoke testing"
```
