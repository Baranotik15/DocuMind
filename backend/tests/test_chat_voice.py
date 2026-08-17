import asyncio
import io
import wave

import pytest
from unittest.mock import AsyncMock, MagicMock, call

from app.chat import voice
from app.chat.voice import (
    AudioConversionError,
    VoiceRecognitionUnavailableError,
    synthesize_speech,
    transcribe_audio,
)
from app.chunks.embedding import LLMError
from app.config import Settings, get_settings


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


# --- StreamingAudioDecoder -------------------------------------------------
#
# Wraps ONE long-lived ffmpeg subprocess via asyncio.create_subprocess_exec
# (not the blocking subprocess.run used above) - no existing async-subprocess
# test precedent in this file, so these fakes mimic asyncio's own
# StreamWriter/StreamReader/Process surface directly:
#   - stdin.write() is SYNC (buffers), stdin.drain()/close() per real
#     asyncio.StreamWriter (drain is async, close is sync).
#   - stdout.read(n) is ASYNC per real asyncio.StreamReader.
#   - process.wait()/kill() per real asyncio.subprocess.Process (wait is
#     async, kill is sync).
# Every test drives the decoder's async methods via asyncio.run(), matching
# this codebase's established convention (see this plan's Task 4 notes) of
# not introducing pytest-asyncio for a handful of async call sites.


def _fake_stdin() -> MagicMock:
    stdin = MagicMock()
    stdin.write = MagicMock()
    stdin.drain = AsyncMock()
    stdin.close = MagicMock()
    return stdin


def _fake_stdout(read_side_effect: list[bytes]) -> MagicMock:
    stdout = MagicMock()
    stdout.read = AsyncMock(side_effect=read_side_effect)
    return stdout


def _fake_process(
    stdin: MagicMock | None = None,
    stdout: MagicMock | None = None,
    wait_side_effect: object = None,
) -> MagicMock:
    process = MagicMock()
    process.stdin = stdin if stdin is not None else _fake_stdin()
    process.stdout = stdout if stdout is not None else _fake_stdout([b""])
    process.stderr = MagicMock()
    process.wait = AsyncMock(side_effect=wait_side_effect)
    process.kill = MagicMock()
    return process


def _patch_create_subprocess_exec(
    monkeypatch: pytest.MonkeyPatch, process: MagicMock
) -> AsyncMock:
    create_mock = AsyncMock(return_value=process)
    monkeypatch.setattr(voice.asyncio, "create_subprocess_exec", create_mock)
    return create_mock


def test_streaming_audio_decoder_starts_ffmpeg_with_raw_pcm_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one concrete assertion that this path genuinely differs from
    convert_to_pcm_wav's: `-f s16le`, not `-f wav`, piped both ends."""
    process = _fake_process()
    create_mock = _patch_create_subprocess_exec(monkeypatch, process)

    async def _run() -> None:
        async with voice.StreamingAudioDecoder():
            pass

    asyncio.run(_run())

    create_mock.assert_awaited_once()
    args, kwargs = create_mock.call_args
    assert "ffmpeg" in args
    assert "-ar" in args
    assert str(voice.TARGET_SAMPLE_RATE_HZ) in args
    assert "-ac" in args
    f_index = args.index("-f")
    assert args[f_index + 1] == "s16le"
    assert "wav" not in args
    assert kwargs["stdin"] == asyncio.subprocess.PIPE
    assert kwargs["stdout"] == asyncio.subprocess.PIPE
    assert kwargs["stderr"] == asyncio.subprocess.PIPE


def test_streaming_audio_decoder_write_writes_and_drains_stdin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _fake_process()
    _patch_create_subprocess_exec(monkeypatch, process)

    async def _run() -> None:
        async with voice.StreamingAudioDecoder() as decoder:
            await decoder.write(b"abc")

    asyncio.run(_run())

    process.stdin.write.assert_called_once_with(b"abc")
    process.stdin.drain.assert_awaited_once()


def test_streaming_audio_decoder_read_yields_chunks_until_eof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _fake_process(stdout=_fake_stdout([b"pcm-1", b"pcm-2", b""]))
    _patch_create_subprocess_exec(monkeypatch, process)

    async def _run() -> list[bytes]:
        collected: list[bytes] = []
        async with voice.StreamingAudioDecoder() as decoder:
            async for chunk in decoder.read():
                collected.append(chunk)
        return collected

    collected = asyncio.run(_run())

    assert collected == [b"pcm-1", b"pcm-2"]
    assert process.stdout.read.await_count == 3


def test_streaming_audio_decoder_aexit_closes_stdin_before_awaiting_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tracker = MagicMock()
    stdin = _fake_stdin()
    stdin.close.side_effect = lambda: tracker.close()

    async def _record_wait() -> None:
        tracker.wait()

    process = _fake_process(stdin=stdin)
    process.wait = AsyncMock(side_effect=_record_wait)
    _patch_create_subprocess_exec(monkeypatch, process)

    async def _run() -> None:
        async with voice.StreamingAudioDecoder():
            pass

    asyncio.run(_run())

    assert tracker.mock_calls == [call.close(), call.wait()]


def test_streaming_audio_decoder_aexit_kills_process_if_wait_times_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stuck/misbehaving ffmpeg process must never be left running after
    the connection closes."""
    process = _fake_process(wait_side_effect=[asyncio.TimeoutError(), None])
    _patch_create_subprocess_exec(monkeypatch, process)

    async def _run() -> None:
        async with voice.StreamingAudioDecoder():
            pass

    asyncio.run(_run())

    process.kill.assert_called_once()
    assert process.wait.await_count == 2


# --- synthesize_speech ------------------------------------------------------


def _fake_speech_response(audio_bytes: bytes) -> MagicMock:
    response = MagicMock()
    response.aread = AsyncMock(return_value=audio_bytes)
    return response


def test_synthesize_speech_returns_audio_bytes() -> None:
    client = MagicMock()
    client.audio.speech.create = AsyncMock(
        return_value=_fake_speech_response(b"fake-mp3-bytes")
    )

    result = asyncio.run(synthesize_speech("Hello", client=client))

    assert result == b"fake-mp3-bytes"


def test_synthesize_speech_calls_client_with_configured_model_and_voice() -> None:
    client = MagicMock()
    client.audio.speech.create = AsyncMock(
        return_value=_fake_speech_response(b"fake-mp3-bytes")
    )

    asyncio.run(synthesize_speech("Hello", client=client))

    client.audio.speech.create.assert_awaited_once_with(
        model=get_settings().openai_tts_model,
        voice=get_settings().openai_tts_voice,
        input="Hello",
        response_format="mp3",
    )


def test_synthesize_speech_raises_llm_error_on_sdk_failure() -> None:
    client = MagicMock()
    client.audio.speech.create = AsyncMock(side_effect=RuntimeError("boom"))

    with pytest.raises(LLMError):
        asyncio.run(synthesize_speech("Hello", client=client))
