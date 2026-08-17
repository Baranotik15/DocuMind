# Voice Conversation Mode - Text/Audio Sync

## Goal
In the voice conversation mode (Phase 1 streaming text + Phase 2 spoken
replies), make the assistant's reply text appear at roughly the same pace
as its spoken audio, instead of the full text appearing almost instantly
while the audio is still only partway through reading it aloud.

## Requirements
- The reply text is revealed progressively, in sync with the actual
  playback of its corresponding audio clip - not word-by-word at LLM
  token speed, and not on a fixed/guessed typing speed independent of the
  real audio.
- Text belonging to a sentence is paired with that sentence's own
  synthesized audio clip (using the existing, already-guaranteed
  ordering: a sentence's `reply_delta` pieces all arrive before its own
  `audio_chunk`, per Phase 2's sequential synthesis design) - each pair's
  text is revealed over the course of that specific clip's own playback,
  not a global average pace.
- If a sentence's speech synthesis failed (no `audio_chunk` arrived for
  it), its text is shown immediately/all at once instead - there is
  nothing to sync to, so no artificial pacing is applied to it.
- Interrupting playback (barge-in, already implemented) discards not just
  the audio queue but also any in-progress or still-pending text reveal -
  nothing left over from an interrupted reply keeps appearing afterward.
- The reply is only finalized into the chat transcript once ALL of its
  text has actually been revealed on screen - if the backend's
  "reply complete" signal arrives before playback/reveal has caught up,
  finalizing waits for the reveal to finish first, so the persisted/
  displayed final message is never missing trailing text that just
  hadn't been revealed yet.
- `ChatPage.tsx` requires no changes - this is entirely internal to the
  `useVoiceConversationSession` hook, same as Phase 2's audio playback.

## Acceptance Criteria
- [ ] For a multi-sentence reply, text visibly continues appearing after
      the first sentence's audio starts, rather than the whole reply
      already being fully visible before audio playback progresses much
      at all.
- [ ] A given sentence's text finishes appearing at approximately the
      same time its own audio clip finishes playing (not before, not
      long after).
- [ ] A sentence whose synthesis failed (no audio produced) still shows
      its text right away rather than being stuck invisible or awaiting a
      clip that will never arrive.
- [ ] Speaking again (barge-in) while text is still being revealed
      immediately stops any further reveal of the interrupted reply, the
      same way it already stops audio playback.
- [ ] The reply's message bubble is only added to the chat transcript
      once its text has fully finished being revealed, even if the
      backend already reported the reply as complete earlier.
- [ ] A reply with no successful synthesis at all (e.g. TTS entirely
      unavailable) still behaves like today: text appears promptly and
      the message finalizes without waiting on anything.

## Non-Goals
- Any change to how fast the backend generates/streams text or
  synthesizes audio - this is purely about how the ALREADY-RECEIVED text
  is revealed on screen.
- Perfectly frame-accurate lip-sync-level timing - approximating each
  sentence's reveal to its own clip's duration is enough; the tolerance
  for the revealed text of a sentence finishing meaningfully before or
  after its own audio doesn't need to be sub-second exact.
- Any change to `ChatPage.tsx`, the WebSocket event shapes, or the
  backend's Phase 1/2 behavior - text/audio content and ordering are
  unchanged, only the pacing of when already-received text becomes
  visible changes.

## Open Questions
- None blocking - the pairing/pacing/fallback/barge-in/finalization-timing
  behavior was already worked out in discussion with the user before this
  spec was written.
