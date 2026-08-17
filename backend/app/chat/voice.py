import asyncio
import json
import os
import subprocess
import wave
from collections.abc import AsyncIterator
from functools import lru_cache
from io import BytesIO

import vosk
from openai import AsyncOpenAI

from app.chunks.embedding import LLMError, get_client  # reused, not duplicated
from app.config import get_settings

# Silences Kaldi's default stderr logging spam - set once at import time.
vosk.SetLogLevel(-1)

TARGET_SAMPLE_RATE_HZ = 16000

# Chunk size for draining ffmpeg's stdout in StreamingAudioDecoder.read() -
# arbitrary but reasonable; small enough to keep latency low, large enough
# not to spend most of the time in read() syscall overhead.
_STREAM_READ_CHUNK_SIZE = 4096

# How long __aexit__ waits for ffmpeg to exit on its own (after closing
# stdin) before concluding it's hung and force-killing it - see
# StreamingAudioDecoder.__aexit__.
_SHUTDOWN_TIMEOUT_SECONDS = 5.0


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
    model_path = get_settings().vosk_model_path
    if not model_path or not os.path.isdir(model_path):
        raise VoiceRecognitionUnavailableError(
            "No Vosk model configured or loadable - set VOSK_MODEL_PATH to an "
            "unzipped Vosk model directory."
        )
    return vosk.Model(model_path)


def convert_to_pcm_wav(audio_bytes: bytes) -> bytes:
    """Shells out to ffmpeg (`subprocess.run`, input piped via stdin, output
    read from stdout - no temp files) to decode `audio_bytes` (whatever
    container/codec the browser's MediaRecorder produced, e.g. webm/opus)
    into mono 16-bit PCM WAV at TARGET_SAMPLE_RATE_HZ:
    `ffmpeg -i pipe:0 -ar 16000 -ac 1 -f wav pipe:1` (plus `-hide_banner
    -loglevel error` to keep stderr limited to real failures). Raises
    AudioConversionError, with ffmpeg's stderr decoded into the message, if
    the process exits non-zero."""
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ar",
            str(TARGET_SAMPLE_RATE_HZ),
            "-ac",
            "1",
            "-f",
            "wav",
            "pipe:1",
        ],
        input=audio_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        stderr_text = result.stderr.decode("utf-8", errors="replace")
        raise AudioConversionError(f"ffmpeg failed to convert audio: {stderr_text}")
    return result.stdout


class StreamingAudioDecoder:
    """One long-lived ffmpeg process per voice-conversation WebSocket
    connection (app/chat/router.py's voice_session) - decodes whatever
    container/codec the browser's continuously-chunked MediaRecorder
    produces into a continuous raw PCM stream (mono, TARGET_SAMPLE_RATE_HZ,
    16-bit, headerless - `ffmpeg ... -f s16le`, NOT `-f wav` like
    convert_to_pcm_wav - there's no single complete WAV file in a
    continuous stream to parse a header out of; every byte read from
    ffmpeg's stdout here is immediately usable PCM).

    `write()` and `read()` must be driven concurrently by the caller (two
    asyncio tasks gathered for the connection's lifetime - see
    app/chat/router.py's voice_session). ffmpeg's stdout pipe has a bounded
    OS buffer; if nothing ever drains it, ffmpeg blocks writing its own
    output, which stops it reading more stdin, which blocks our own
    writes - a classic pipe deadlock. This class does not spawn its own
    background draining task; it only wraps the subprocess and exposes
    both sides.
    """

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None

    async def __aenter__(self) -> "StreamingAudioDecoder":
        """Starts the ffmpeg subprocess via asyncio.create_subprocess_exec
        (stdin=PIPE, stdout=PIPE, stderr=PIPE) - same flag set as
        convert_to_pcm_wav's `-hide_banner -loglevel error -i pipe:0 -ar
        {TARGET_SAMPLE_RATE_HZ} -ac 1`, but `-f s16le pipe:1` instead of
        `-f wav pipe:1`."""
        self._process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ar",
            str(TARGET_SAMPLE_RATE_HZ),
            "-ac",
            "1",
            "-f",
            "s16le",
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        """Closes stdin (signals ffmpeg no more input is coming, so it
        flushes and exits cleanly), awaits the process, and only then
        force-kills it if it's still alive (a stuck/misbehaving ffmpeg
        process must never be left running after the connection closes)."""
        process = self._process
        assert process is not None, "__aenter__ must run before __aexit__"

        if process.stdin is not None:
            process.stdin.close()

        try:
            await asyncio.wait_for(process.wait(), timeout=_SHUTDOWN_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

    async def write(self, chunk: bytes) -> None:
        """Writes one incoming audio chunk to ffmpeg's stdin and drains
        it (`await stdin.drain()`) - backpressure-aware, per this class's
        concurrent-loops contract."""
        process = self._process
        assert process is not None and process.stdin is not None, (
            "write() called outside an active StreamingAudioDecoder context"
        )
        process.stdin.write(chunk)
        await process.stdin.drain()

    async def read(self) -> AsyncIterator[bytes]:
        """Yields decoded PCM as it becomes available from ffmpeg's
        stdout (`await stdout.read(n)` in a loop, some reasonable chunk
        size), until stdout hits EOF (empty read - ffmpeg exited/stdin was
        closed), at which point the generator ends."""
        process = self._process
        assert process is not None and process.stdout is not None, (
            "read() called outside an active StreamingAudioDecoder context"
        )
        while True:
            chunk = await process.stdout.read(_STREAM_READ_CHUNK_SIZE)
            if not chunk:
                return
            yield chunk


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
    active_model = model if model is not None else _get_model()

    wav_bytes = convert_to_pcm_wav(audio_bytes)

    with wave.open(BytesIO(wav_bytes), "rb") as wav_file:
        frames = wav_file.readframes(wav_file.getnframes())

    recognizer = vosk.KaldiRecognizer(active_model, TARGET_SAMPLE_RATE_HZ)
    recognizer.AcceptWaveform(frames)
    return json.loads(recognizer.FinalResult())["text"]


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
    try:
        active_client = client if client is not None else get_client()
        response = await active_client.audio.speech.create(
            model=get_settings().openai_tts_model,
            voice=get_settings().openai_tts_voice,
            input=text,
            response_format="mp3",
        )
        return await response.aread()
    except Exception as exc:
        raise LLMError(f"Failed to synthesize speech: {exc}") from exc
