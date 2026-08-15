# Voice Conversation Mode (Phase 2 - spoken replies)

## Goal
Make the hands-free voice conversation (Phase 1: WebSocket session, VAD via
Vosk, auto-send, streaming text reply - already live) also speak its
replies out loud via OpenAI TTS, with low time-to-first-audio (synthesized
sentence-by-sentence as the reply streams in, not after the whole reply is
done), and let the user interrupt (barge-in) by simply talking over it.

## Requirements
- As the assistant's reply streams in (Phase 1's existing token-by-token
  generation), completed sentences are synthesized to speech and sent to
  the frontend as soon as each one is ready - never waiting for the whole
  reply to finish generating before the first audio is available.
- The frontend plays synthesized sentence clips back in order,
  back-to-back with no audible gap between consecutive clips of the same
  reply.
- Text streaming into the chat transcript (Phase 1's existing behavior) is
  unchanged and happens in parallel with audio playback - the reply is
  both heard and read, not one or the other.
- The microphone keeps listening (per Phase 1) for the entire duration of
  audio playback, not just while idle.
- If a new user utterance is finalized (VAD) while a previous turn is
  still generating its reply and/or its audio hasn't finished playing,
  that previous turn is interrupted: audio playback stops immediately,
  any not-yet-played queued clips for it are discarded, and any
  still-in-flight text generation or speech synthesis for it is cancelled
  outright (not left to finish in the background). This applies whether
  playback has started yet or the reply is still only text so far.
- An interrupted turn's user message stays in the chat history (it was
  already persisted when recognized, per Phase 1), but it never gets an
  assistant reply - same "no reply is persisted unless it completed in
  full" rule Phase 1 already applies to a failed/errored turn. Its
  transient streaming-text bubble is cleared rather than finalized.
- The voice-conversation button itself (idle/active visual states, icon
  change, ending the session on a second click) is unchanged from Phase 1.
- If speech synthesis fails for a reply (e.g. the TTS call errors), the
  reply is still shown as text (Phase 1's existing behavior) - a synthesis
  failure degrades to text-only for that one reply, it does not error out
  the whole turn or the session.

## Acceptance Criteria
- [ ] During a voice session, an assistant reply is audibly spoken, and
      the first audio is heard before the full reply has finished
      generating (observable as audio starting while the text bubble is
      still growing, for any reply long enough to contain more than one
      sentence).
- [ ] Multiple sentences in one reply play back seamlessly, one after
      another, without needing to wait for user action between them.
- [ ] The reply's text still streams into the chat transcript exactly as
      it does today, unchanged, at the same time audio is playing.
- [ ] Speaking again while a previous reply is still generating and/or
      still playing immediately stops that audio, discards anything still
      queued for it, and the new utterance is recognized as the start of
      a new turn - no talking over each other, no queued backlog of old
      replies playing after the interruption.
- [ ] The interrupted turn's own user message is still visible in the
      chat history afterward; it has no assistant reply, and no stray
      partial reply bubble is left on screen.
- [ ] A TTS failure for one reply still leaves that reply's text visible
      in the chat and does not close the voice session or block further
      turns.
- [ ] Ending the voice session (clicking the button again) while audio is
      playing stops the audio immediately, same as any other teardown.

## Non-Goals
- Any change to the voice-conversation button's own appearance/behavior,
  or to the existing single-shot dictation button - both are unchanged.
- Any change to how/when text streams into the transcript - Phase 1's
  behavior there is final.
- Voice selection/customization in the UI - one configured TTS voice for
  the whole deployment, not a per-user or per-message choice.
- Persisting synthesized audio anywhere (database, disk) - it's played
  once and discarded, never stored.
- Real interruption-safe mid-sentence audio splicing (e.g. fading out
  cleanly) - a hard stop on interruption is acceptable, it doesn't need to
  sound polished.

## Open Questions
- None blocking - TTS provider (OpenAI), the sentence-chunked synthesis
  pipeline, and the barge-in behavior were already settled in discussion
  with the user before this spec was written.
