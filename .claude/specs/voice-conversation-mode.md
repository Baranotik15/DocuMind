# Voice Conversation Mode (Phase 1 - streaming input, no TTS)

## Goal
Let a user have a hands-free spoken conversation with the chat assistant -
speak a question, have it auto-sent the moment they pause, and watch the
reply stream in as text - without pressing Send or re-clicking anything
between turns. This is Phase 1 of a two-phase feature: it covers the input
side and a live-streamed text reply only. Phase 2 (a separate future spec)
adds spoken (TTS) replies, audio playback, and barge-in.

## Requirements
- A new voice-conversation button exists on ChatPage, distinct from and
  coexisting with the existing single-shot dictation mic button (which is
  unchanged by this feature).
- Clicking it opens a WebSocket connection to the backend and starts
  continuous microphone capture - not a record-then-upload single clip like
  the existing dictation button.
- While a session is active, the button/UI shows a clearly distinct
  "listening" visual state (an icon change plus an active-session
  indicator) - unambiguous at a glance versus idle.
- Microphone audio is streamed to the backend continuously, in chunks,
  for the duration of the session - not buffered and sent as one upload at
  the end.
- The end of a user's spoken turn is detected using the Vosk recognizer's
  own built-in pause/endpoint detection (the same signal the existing
  transcription feature already gets from `AcceptWaveform` returning a
  finalized segment) - no separate custom silence-timer is introduced.
- The moment a turn is finalized with non-empty recognized text, that text
  is automatically sent through the same retrieval+LLM pipeline
  `POST /chat/messages` already uses (embed the question, pgvector
  retrieval, chat completion) - no manual Send click. The resulting user
  and assistant messages are persisted to `chat_messages` exactly as they
  are today.
- A finalized turn with empty (silence/noise, no recognized speech) text is
  silently ignored - not sent as a message, not surfaced as an error - and
  the session keeps listening.
- The assistant's reply streams back to the frontend incrementally as it's
  generated (not withheld until the full completion finishes) and appears
  in the chat transcript live.
- After a turn completes, the session automatically keeps listening for the
  next turn - a continuous, hands-free multi-turn conversation - with no
  need to re-click the button between turns.
- While a voice-conversation session is active, the ordinary message
  input box, its Send button, and the existing dictation mic button are all
  disabled - only one path can produce a message at a time, so a
  voice-triggered auto-send can never race a manual one.
- Clicking the voice-conversation button again while a session is active
  ends it: the WebSocket closes, the microphone stops, the ordinary
  input/Send/dictation controls re-enable, and the button returns to its
  idle appearance.
- If no Vosk model is configured (see the existing dictation feature's
  "not installed" error), starting a voice-conversation session fails with
  a clear, equivalent error instead of opening a silently-broken session.

## Acceptance Criteria
- [ ] The voice-conversation button is visible on ChatPage alongside the
      existing dictation mic button, and behaves independently of it.
- [ ] Clicking it starts continuous microphone capture and opens a
      WebSocket session; the UI clearly shows an active "listening" state.
- [ ] Speaking a question and then pausing causes it to be transcribed,
      auto-sent, and to appear in the chat transcript as a user message -
      with no Send click and no text ever placed in the input box first.
- [ ] The assistant's reply appears incrementally (visibly streaming in),
      not all at once after a delay.
- [ ] After the reply, the session keeps listening automatically; a second
      spoken question in the same session is transcribed and auto-sent the
      same way, without re-clicking the button.
- [ ] Pausing during silence/background noise with no actual speech does
      not send an empty message and does not error - the session simply
      keeps listening.
- [ ] While a session is active, the message input box, Send button, and
      dictation mic button are all disabled.
- [ ] Clicking the voice-conversation button again ends the session: audio
      capture stops, the WebSocket closes, and the input/Send/dictation
      controls become usable again.
- [ ] With no Vosk model configured, starting a session surfaces a clear
      error instead of opening a non-functional session.
- [ ] Every voice-triggered message is persisted in `chat_messages`
      identically to a manually-sent one (same columns, same retrieval
      behavior, visible on reload like any other chat history).

## Non-Goals
- Text-to-speech / any spoken reply - Phase 2.
- Any audio playback UI - Phase 2.
- Barge-in / interrupting an in-progress reply - Phase 2 (moot without
  audio playback in Phase 1).
- Any change to the existing single-shot dictation mic button's behavior.
- Reconnecting automatically after a dropped WebSocket connection - a
  connection drop simply ends the session (see Open Questions).
- Multiple simultaneous voice-conversation sessions, or any language/model
  selection beyond the single configured Vosk model the existing
  dictation feature already uses.

## Open Questions
- Should an abandoned-but-still-open session (user walked away, stopped
  responding to prompts) auto-end after some idle duration, or stay open
  indefinitely until manually closed or the tab closes? Leaning toward "no
  auto-timeout in Phase 1" for simplicity, but worth confirming in the
  plan.
- Exact behavior on an unexpected WebSocket drop (network blip) beyond
  "the session ends" - does the UI need a distinct error state versus a
  normal user-initiated close, so the user knows to manually restart it?
