# Voice Conversation Text/Audio Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the reply text in voice conversation mode reveal at the pace
of its own spoken audio (not LLM token speed) - per
`.claude/specs/voice-conversation-text-audio-sync.md`.

**Architecture:** All inside `useVoiceConversationSession.ts` - no backend
or `ChatPage.tsx` changes. Incoming `reply_delta` text is buffered (not
forwarded to `onReplyDelta` immediately); when the NEXT `audio_chunk`
arrives, it claims whatever's buffered so far as its own paired
`{ text, audioUrl }` segment (this also naturally absorbs a failed
sentence's leftover text into the next successful pairing, with no special
case needed). Each segment's text is revealed progressively during its own
clip's playback via the `<audio>` element's native `timeupdate` event
(`onReplyDelta` called with each newly-due slice as `currentTime/duration`
advances), with a safety-net full flush on `onended`/`onerror` so nothing
is ever lost to timing/rounding. A short fallback timer detects "no audio
is coming" (TTS unavailable for this whole reply) and reverts to
immediate, unpaced forwarding for the rest of that turn. `reply_done` is
held (not forwarded to `callbacks.onReplyDone`) until the queue is fully
drained, so `ChatPage.tsx`'s final message always contains the complete
text.

**Tech Stack:** No new dependencies - the browser's native `HTMLAudioElement`
`timeupdate`/`ended`/`error` events, plus `setTimeout`/`clearTimeout` for
the no-audio fallback.

---

## Key design decisions (read before starting)

- **Pairing is "whatever's buffered claims the next `audio_chunk`", not
  strict one-sentence-per-clip bookkeeping.** If a sentence's synthesis
  failed silently (already-existing Phase 2 behavior - no `audio_chunk`
  sent for it), its text simply stays in the buffer and gets bundled into
  the NEXT successful pairing automatically - revealed a bit faster than
  ideal during that next clip, but never lost or requiring its own
  special-case code.
- **A `NO_AUDIO_FALLBACK_TIMEOUT_MS` timer (4000ms) is the "give up
  syncing" safety net**, reset every time new `reply_delta` text arrives
  with nothing yet paired. If it fires, whatever's buffered is flushed
  immediately and - for the REST of that turn only - all further
  `reply_delta` content forwards immediately too (matching pre-sync
  behavior). This is what keeps a totally-TTS-unavailable reply "prompt"
  per the spec, without needing to know in advance whether synthesis will
  work.
- **Revealed via `timeupdate`, not a hand-rolled `setInterval`.** The
  audio element already ticks this as it actually plays, including
  naturally pausing/stalling correctly if the browser buffers - a manual
  wall-clock timer would drift from real playback for no benefit.
- **`onended`/`onerror` always does one final "reveal everything still
  unrevealed" flush before advancing to the next segment** - `timeupdate`
  firing frequency isn't guaranteed exact, so this is what guarantees a
  segment's text is 100% visible by the time its audio finishes, not
  99%-ish.
- **`reply_done` is deferred whenever the queue isn't already empty and
  idle at the moment it arrives.** The deferred payload is fired from the
  same "advance to next segment" path once that path finds nothing left
  to play - one single place decides "the reply is now fully
  displayed AND done", rather than two different code paths both trying
  to finalize it.
- **Barge-in (already-existing `stopAndClearAudioQueue`, invoked on every
  new `user_message`) additionally resets ALL of this task's new state**
  (pending buffer, fallback timer, sync-mode flag, deferred `reply_done`)
  - an interrupted turn must never have its held-back `reply_done` fire
  later, and a fresh turn must always start back in full sync mode even
  if the previous one had fallen back to unpaced forwarding.

---

### Task 1: Text/audio pairing, paced reveal, no-audio fallback, deferred `reply_done`

**Files:**
- Modify: `frontend/src/pages/useVoiceConversationSession.ts`
- Modify: `frontend/src/pages/useVoiceConversationSession.test.ts`
- Reference: this file's own existing `playNextQueuedAudio`/
  `stopAndClearAudioQueue`/`playAudioChunk`/`routeIncomingEvent`
  (Phase 2's audio-queue code - extend it, don't replace its shape)

**Contracts:**

```typescript
// frontend/src/pages/useVoiceConversationSession.ts

// How long to wait, after buffering reply text with nothing yet paired to
// an audio_chunk, before concluding TTS isn't going to provide one for
// this reply at all and falling back to immediate/unpaced forwarding for
// the rest of the turn (see this plan's design notes).
const NO_AUDIO_FALLBACK_TIMEOUT_MS = 4000

interface QueuedReplySegment {
  text: string
  audioUrl: string
}
```

Replace `audioQueueRef: useRef<string[]>([])` with
`audioQueueRef: useRef<QueuedReplySegment[]>([])`. Add:
- `pendingSentenceTextRef = useRef('')` - reply_delta content received
  since the last pairing.
- `syncModeRef = useRef(true)` - false once this turn has fallen back to
  unpaced forwarding.
- `noAudioFallbackTimeoutRef = useRef<number | null>(null)`.
- `revealedCharsRef = useRef(0)` - how much of the CURRENTLY-PLAYING
  segment's text has been revealed so far.
- `pendingReplyDoneRef = useRef<{ id: string; noAnswerFound: boolean } | null>(null)`.

```typescript
// Called for every reply_delta event instead of forwarding straight to
// callbacks.onReplyDelta (see routeIncomingEvent's updated 'reply_delta'
// case below).
function bufferReplyDelta(content: string, callbacks: VoiceConversationCallbacks): void {
  if (!syncModeRef.current) {
    callbacks.onReplyDelta(content)
    return
  }
  pendingSentenceTextRef.current += content
  if (noAudioFallbackTimeoutRef.current !== null) {
    window.clearTimeout(noAudioFallbackTimeoutRef.current)
  }
  noAudioFallbackTimeoutRef.current = window.setTimeout(() => {
    syncModeRef.current = false
    const leftover = pendingSentenceTextRef.current
    pendingSentenceTextRef.current = ''
    if (leftover) {
      callbacks.onReplyDelta(leftover)
    }
  }, NO_AUDIO_FALLBACK_TIMEOUT_MS)
}
```

```typescript
// Replaces playAudioChunk's body: claims pendingSentenceTextRef's current
// contents as this clip's paired text (clearing both the buffer and the
// fallback timer - an audio_chunk arriving IS confirmation this reply's
// audio is working), pushes the pair, and kicks off playback.
function playAudioChunk(audioBase64: string): void {
  if (noAudioFallbackTimeoutRef.current !== null) {
    window.clearTimeout(noAudioFallbackTimeoutRef.current)
    noAudioFallbackTimeoutRef.current = null
  }
  const text = pendingSentenceTextRef.current
  pendingSentenceTextRef.current = ''

  // ...existing base64-decode-to-Blob-to-object-URL logic, unchanged...

  audioQueueRef.current.push({ text, audioUrl: url })
  playNextQueuedAudio(callbacksForReveal) // see below - now needs callbacks to call onReplyDelta as it reveals
}
```

`playNextQueuedAudio` needs access to `VoiceConversationCallbacks` now (to
call `onReplyDelta` as it reveals, and `onReplyDone` once fully drained) -
thread it through as a parameter from wherever it's already called
(`routeIncomingEvent`'s `audio_chunk` case, and its own recursive
self-call), same as `routeIncomingEvent` already receives `callbacks`.

```typescript
// Updated shape - starts revealing the new segment's text as it plays,
// and is also THE place that fires a deferred reply_done once there's
// truly nothing left queued or playing.
function playNextQueuedAudio(callbacks: VoiceConversationCallbacks): void {
  if (currentAudioRef.current) {
    return
  }

  const next = audioQueueRef.current.shift()
  if (!next) {
    // Nothing left to play - if a reply_done was waiting on exactly this
    // moment, this is it.
    if (pendingReplyDoneRef.current) {
      callbacks.onReplyDone(pendingReplyDoneRef.current)
      pendingReplyDoneRef.current = null
    }
    return
  }

  revealedCharsRef.current = 0
  const audio = new Audio(next.audioUrl)
  currentAudioRef.current = audio

  audio.ontimeupdate = () => {
    const ratio = audio.duration > 0 && Number.isFinite(audio.duration) ? audio.currentTime / audio.duration : 1
    const targetChars = Math.min(next.text.length, Math.floor(ratio * next.text.length))
    if (targetChars > revealedCharsRef.current) {
      callbacks.onReplyDelta(next.text.slice(revealedCharsRef.current, targetChars))
      revealedCharsRef.current = targetChars
    }
  }

  const advance = (): void => {
    // Safety-net flush - guarantees the segment's full text is visible
    // even if timeupdate under-fired near the end.
    if (revealedCharsRef.current < next.text.length) {
      callbacks.onReplyDelta(next.text.slice(revealedCharsRef.current))
      revealedCharsRef.current = next.text.length
    }
    URL.revokeObjectURL(next.audioUrl)
    currentAudioRef.current = null
    playNextQueuedAudio(callbacks)
  }
  audio.onended = advance
  audio.onerror = advance
  audio.play()
}
```

`routeIncomingEvent`'s cases change:
- `'reply_delta'`: calls `bufferReplyDelta(typedEvent.content, callbacks)`
  instead of `callbacks.onReplyDelta(typedEvent.content)` directly.
- `'reply_done'`: clears `noAudioFallbackTimeoutRef` (the stream is over,
  irrelevant now); if `pendingSentenceTextRef.current` is non-empty,
  flushes it via `callbacks.onReplyDelta(...)` and clears it (nothing more
  is ever coming to pair with it). THEN: if `audioQueueRef.current` is
  empty AND `currentAudioRef.current` is null, calls
  `callbacks.onReplyDone(...)` immediately; otherwise stores it in
  `pendingReplyDoneRef` for `playNextQueuedAudio` to fire later.

`stopAndClearAudioQueue()` additionally resets: clears
`noAudioFallbackTimeoutRef` if set, resets `pendingSentenceTextRef.current
= ''`, `syncModeRef.current = true`, `revealedCharsRef.current = 0`,
`pendingReplyDoneRef.current = null`, and clears `audio.ontimeupdate` on
whatever was playing (avoid a stray reveal call firing after teardown).

**Step 1: Write the failing tests**

Extend `useVoiceConversationSession.test.ts`. The existing `FakeAudio`
class (from Phase 2's Task 4) needs two additions: a settable
`currentTime`/`duration` and an `ontimeupdate` field the test fires
manually (same hand-driven-events philosophy as its existing `onended`/
`onerror`). Use `vi.useFakeTimers()` for the fallback-timeout tests
(`vi.advanceTimersByTime(NO_AUDIO_FALLBACK_TIMEOUT_MS)`), restoring real
timers afterward per this file's existing `afterEach` conventions.

- Several `reply_delta` events followed by one `audio_chunk` -> nothing is
  forwarded to `onReplyDelta` yet at this point (still buffered/paired,
  not revealed).
- Firing the resulting `FakeAudio`'s `ontimeupdate` with `duration = 10`,
  `currentTime = 5` -> `onReplyDelta` is called with roughly the first
  half of that segment's paired text (assert by slicing, not exact pixel
  match); firing it again with `currentTime = 10` reveals the rest.
- Firing `onended` before `currentTime` ever reached the full duration
  (simulate under-firing `timeupdate`) -> the SAFETY-NET flush still
  reveals whatever wasn't yet shown, exactly once, no duplicated
  characters.
- `reply_delta` events with NO `audio_chunk` ever arriving, advancing
  fake timers past `NO_AUDIO_FALLBACK_TIMEOUT_MS` -> the buffered text is
  flushed via `onReplyDelta` immediately (not paced), and a FURTHER
  `reply_delta` event afterward (still no audio) is ALSO forwarded
  immediately (proves `syncModeRef` stays off for the rest of the turn,
  not just the one timeout).
- `reply_done` arriving while a segment is still playing/revealing ->
  `onReplyDone` is NOT called yet; firing that segment's `onended` (with
  nothing else queued) -> `onReplyDone` fires then, with the correct
  `id`/`noAnswerFound`.
- `reply_done` arriving with the queue already empty/idle -> `onReplyDone`
  fires immediately, same as before this task.
- `reply_done` arriving with leftover buffered (never-paired) text ->
  that text is flushed via `onReplyDelta` before/alongside `onReplyDone`
  firing.
- A `user_message` (barge-in) arriving mid-reveal, followed by a fresh
  `audio_chunk` in the NEW turn -> the new turn's pairing/reveal starts
  clean (no leftover text from the interrupted turn ever appears, and a
  `reply_done` that was pending for the OLD turn never fires).

Run: `cd frontend && npx vitest run src/pages/useVoiceConversationSession.test.ts`
Expected: FAIL, then PASS after implementing.

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run` (full suite) and `npx tsc -b`.
Expected: PASS, no regressions, no type errors. Confirm via `git diff
--stat` that `ChatPage.tsx` was NOT touched.

**Step 4: Commit**

```bash
git add frontend/src/pages/useVoiceConversationSession.ts frontend/src/pages/useVoiceConversationSession.test.ts
git commit -m "feat(chat): pace voice-reply text reveal to match spoken audio playback"
```

---

### Task 2: Live smoke test

**Files:** None new - verification only.

**Step 1:** `cd frontend && npx vitest run && npx tsc -b` - PASS.

**Step 2:** `docker compose up -d --build frontend` (backend/worker are
unchanged by this plan - no rebuild needed for them).

**Step 3:** Live check via the same fake-microphone Playwright approach
used for Phases 1 and 2 (a throwaway user, `--use-fake-device-for-media-
stream` + `--use-file-for-fake-audio-capture`): start a voice session,
let a multi-sentence reply come back, and confirm BY WATCHING THE PAGE
(screenshots at a few points during one reply, a few seconds apart) that
the visible text is still growing partway through that reply's audio
playback rather than already being fully shown near the start. Confirm no
new console errors. Clean up the throwaway user/seeded chat rows
afterward, same as every prior live check.

**Step 4: Commit** (only if Step 1 required fixes)

```bash
git add -A
git commit -m "test: fix regressions found during text-audio-sync smoke testing"
```
