import io
import wave

import pytest
from unittest.mock import MagicMock

from app.chat import voice
from app.chat.voice import (
    AudioConversionError,
    VoiceRecognitionUnavailableError,
    transcribe_audio,
)
from app.config import Settings


@pytest.fixture(autouse=True)
def _clear_model_cache() -> None:
    """_get_model() is @lru_cache'd at module level, same rationale as
    test_llm.py's _clear_client_cache fixture for embedding.get_client -
    clear before and after each test so a cached (or cached-failure-free)
    state never leaks between tests running in the same process."""
    voice._get_model.cache_clear()
    yield
    voice._get_model.cache_clear()


def _make_silent_wav_bytes(num_frames: int = 800) -> bytes:
    """A few hundred silent PCM frames at 16kHz mono 16-bit - enough for
    transcribe_audio's own frame-extraction/JSON-parsing logic to run
    against real (if trivial) WAV bytes, no real ffmpeg needed."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b"\x00\x00" * num_frames)
    return buffer.getvalue()


def test_get_model_raises_when_vosk_model_path_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(voice, "get_settings", lambda: Settings(vosk_model_path=""))
    fake_model_cls = MagicMock()
    monkeypatch.setattr(voice.vosk, "Model", fake_model_cls)

    with pytest.raises(VoiceRecognitionUnavailableError):
        voice._get_model()

    fake_model_cls.assert_not_called()


def test_convert_to_pcm_wav_returns_stdout_on_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_mock = MagicMock(
        return_value=MagicMock(returncode=0, stdout=b"fake-wav-bytes", stderr=b"")
    )
    monkeypatch.setattr(voice.subprocess, "run", run_mock)

    result = voice.convert_to_pcm_wav(b"some-audio-bytes")

    assert result == b"fake-wav-bytes"
    (command,), _kwargs = run_mock.call_args
    assert "ffmpeg" in command
    assert "-ar" in command
    assert "16000" in command
    assert "-ac" in command
    assert "1" in command


def test_convert_to_pcm_wav_raises_audio_conversion_error_on_nonzero_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_mock = MagicMock(
        return_value=MagicMock(returncode=1, stdout=b"", stderr=b"boom")
    )
    monkeypatch.setattr(voice.subprocess, "run", run_mock)

    with pytest.raises(AudioConversionError, match="boom"):
        voice.convert_to_pcm_wav(b"some-audio-bytes")


def test_transcribe_audio_returns_final_result_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wav_bytes = _make_silent_wav_bytes()
    monkeypatch.setattr(voice, "convert_to_pcm_wav", MagicMock(return_value=wav_bytes))

    fake_recognizer = MagicMock(
        AcceptWaveform=MagicMock(),
        FinalResult=MagicMock(return_value='{"text": "hello world"}'),
    )
    recognizer_factory = MagicMock(return_value=fake_recognizer)
    monkeypatch.setattr(voice.vosk, "KaldiRecognizer", recognizer_factory)

    result = transcribe_audio(b"whatever", model=MagicMock())

    assert result == "hello world"
    fake_recognizer.AcceptWaveform.assert_called_once()
    (accepted_frames,) = fake_recognizer.AcceptWaveform.call_args.args
    assert len(accepted_frames) < len(wav_bytes)
    assert b"RIFF" not in accepted_frames
    assert b"WAVE" not in accepted_frames


def test_transcribe_audio_raises_when_unconfigured_and_never_converts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(voice, "get_settings", lambda: Settings(vosk_model_path=""))
    convert_mock = MagicMock()
    monkeypatch.setattr(voice, "convert_to_pcm_wav", convert_mock)

    with pytest.raises(VoiceRecognitionUnavailableError):
        transcribe_audio(b"whatever", model=None)

    convert_mock.assert_not_called()
