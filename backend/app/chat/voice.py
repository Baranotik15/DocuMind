import json
import os
import subprocess
import wave
from functools import lru_cache
from io import BytesIO

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
