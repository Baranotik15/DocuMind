import { useRef, useState } from 'react'

// Mirrors httpClient.ts's own hardcoded BASE_URL ('http://localhost:8000')
// convention - single-host, no env plumbing yet (see that file's own
// comment) - just the `ws` scheme instead of `http`.
const VOICE_SESSION_WS_URL = 'ws://localhost:8000/internal/chat/voice-session'

// How often the continuously-recording MediaRecorder below flushes a chunk
// (via its own internal timeslice, NOT record-then-stop-then-upload-once
// like ChatPage.tsx's single-shot dictation feature) - short enough that
// turn-ending latency feels responsive, long enough not to spam tiny frames
// over the WebSocket.
const VOICE_SESSION_TIMESLICE_MS = 250

export type VoiceConversationStatus = 'idle' | 'connecting' | 'listening'

export interface VoiceConversationCallbacks {
  onUserMessage: (message: { id: string; content: string }) => void
  onReplyDelta: (content: string) => void
  onReplyDone: (message: { id: string; noAnswerFound: boolean }) => void
  onError: (message: string) => void
}

export interface VoiceConversationSession {
  status: VoiceConversationStatus
  start: () => Promise<void>
  stop: () => void
}

// The five event shapes the backend's voice-session WebSocket can send (see
// backend/app/chat/schemas.py's VoiceUserMessageEvent/VoiceReplyDeltaEvent/
// VoiceReplyDoneEvent/VoiceAudioChunkEvent/VoiceErrorEvent) - a plain
// discriminated union so routeIncomingEvent below can switch on `.type` with
// narrowing. Deliberately has NO catch-all/index-signature member for an
// unrecognized `.type` - see routeIncomingEvent's own `default` branch for
// how that's handled instead; adding one here would widen every other
// member's fields to `unknown` (matching that member's index signature too,
// since a literal `.type` is always also assignable to a `string`-typed
// one).
type VoiceSessionEvent =
  | { type: 'user_message'; id: string; content: string }
  | { type: 'reply_delta'; content: string }
  | { type: 'reply_done'; id: string; noAnswerFound: boolean }
  | { type: 'audio_chunk'; audioBase64: string }
  | { type: 'error'; detail: string }

// The audio-playback side effects routeIncomingEvent needs beyond the four
// caller-supplied VoiceConversationCallbacks - kept as a separate parameter
// (not folded into VoiceConversationCallbacks) since these are internal to
// this hook's own playback queue, not something ChatPage.tsx provides or
// needs to know about (see this file's module doc / the phase 2 plan's
// design notes: ChatPage.tsx needs zero changes for spoken replies).
interface VoiceSessionAudioHandlers {
  playAudioChunk: (audioBase64: string) => void
  stopAndClearAudioQueue: () => void
}

function routeIncomingEvent(
  event: unknown,
  callbacks: VoiceConversationCallbacks,
  audioHandlers: VoiceSessionAudioHandlers,
): void {
  if (typeof event !== 'object' || event === null || !('type' in event)) {
    // Malformed/unexpected shape - same forward-compatible "ignore it"
    // contract as an unrecognized `.type` below.
    return
  }

  const typedEvent = event as VoiceSessionEvent
  switch (typedEvent.type) {
    case 'user_message':
      // A new user turn starting IS the entire barge-in signal (see this
      // plan's design notes: no separate WS event exists for it) - stop and
      // clear whatever reply audio was queued or still playing from the
      // now-stale previous turn before surfacing the new one.
      audioHandlers.stopAndClearAudioQueue()
      callbacks.onUserMessage({ id: typedEvent.id, content: typedEvent.content })
      return
    case 'reply_delta':
      callbacks.onReplyDelta(typedEvent.content)
      return
    case 'reply_done':
      callbacks.onReplyDone({ id: typedEvent.id, noAnswerFound: typedEvent.noAnswerFound })
      return
    case 'audio_chunk':
      audioHandlers.playAudioChunk(typedEvent.audioBase64)
      return
    case 'error':
      callbacks.onError(typedEvent.detail)
      return
    default:
      // Unrecognized type - ignored, not an error (forward-compatible).
      return
  }
}

/**
 * Owns a PERSISTENT WebSocket connection plus a CONTINUOUSLY-recording
 * MediaRecorder for DocuMind's hands-free voice conversation mode - a
 * dedicated hook rather than more code piled into ChatPage.tsx (already
 * ~900 lines before this feature, see the plan's own design notes).
 * Deliberately different from ChatPage.tsx's own single-shot dictation
 * feature (handleMicClick/handleRecordingStopped): that one records, stops,
 * uploads once, and gets one transcription back; this one streams small
 * audio chunks continuously over a live WebSocket for as long as the
 * session stays open, with the server's own VAD (silence detection)
 * driving repeated `user_message`/`reply_delta`/`reply_done`/`error`
 * events for as many turns as the user speaks.
 *
 * `start()`: requests mic access, opens the WebSocket, and - once it's
 * open - starts the MediaRecorder with a short repeating timeslice,
 * forwarding every non-empty chunk it produces straight over the socket.
 * `stop()` (and an unexpected server-side close/error) always tears
 * everything down and leaves `status` back at 'idle'.
 */
export function useVoiceConversationSession(callbacks: VoiceConversationCallbacks): VoiceConversationSession {
  const [status, setStatus] = useState<VoiceConversationStatus>('idle')
  // Imperative handles for the in-progress session's resources - refs, not
  // state, for the same reason ChatPage.tsx's own mediaRecorderRef is a ref:
  // these are started/stopped/closed by calling methods on them directly,
  // never read/displayed by a render.
  const wsRef = useRef<WebSocket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // Sequential spoken-reply playback queue - same imperative-handle
  // convention as the refs above (these are started/stopped by calling
  // methods on them directly, never read by a render). audioQueueRef holds
  // object URLs for clips received but not yet started; currentAudioRef
  // holds the one clip actually playing right now, if any.
  const audioQueueRef = useRef<string[]>([])
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)

  // Plays the next queued clip, if any and if nothing is already playing -
  // called once per audio_chunk received AND from a clip's own onended/
  // onerror so playback advances through the queue one clip at a time
  // (never overlapping, per the plan's design notes on synthesis order).
  function playNextQueuedAudio(): void {
    if (currentAudioRef.current) {
      // Something is already playing - this will be called again once it
      // ends (or errors).
      return
    }

    const nextUrl = audioQueueRef.current.shift()
    if (!nextUrl) {
      return
    }

    const audio = new Audio(nextUrl)
    currentAudioRef.current = audio
    const advance = (): void => {
      URL.revokeObjectURL(nextUrl)
      currentAudioRef.current = null
      playNextQueuedAudio()
    }
    // onerror is treated identically to onended - one bad clip must not
    // wedge the rest of the queue behind it.
    audio.onended = advance
    audio.onerror = advance
    audio.play()
  }

  // The entire barge-in mechanism (see this file's module doc / the phase 2
  // plan's design notes): stops+clears whatever's currently playing and
  // discards every still-queued clip. Called both when a new user_message
  // arrives mid-reply and from teardown(), so ending the session
  // mid-playback silences immediately too.
  function stopAndClearAudioQueue(): void {
    const audio = currentAudioRef.current
    currentAudioRef.current = null
    if (audio) {
      audio.pause()
      URL.revokeObjectURL(audio.src)
    }

    audioQueueRef.current.forEach((url) => URL.revokeObjectURL(url))
    audioQueueRef.current = []
  }

  // Decodes a base64-encoded MP3 sentence clip into a Blob object URL,
  // queues it, and kicks off playback (a no-op if a clip is already
  // playing - it'll be picked up once that one ends).
  function playAudioChunk(audioBase64: string): void {
    const binary = atob(audioBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mp3' }))
    audioQueueRef.current.push(url)
    playNextQueuedAudio()
  }

  // Shared by stop() AND by an unexpected ws.onclose/onerror - both must
  // leave every resource released and status back at 'idle', so this is the
  // one place that does it. Nulls the socket's own handlers before closing
  // it so a user-initiated stop() can never cause its own resulting close
  // event to re-run this a second time.
  function teardown(): void {
    const recorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    if (recorder) {
      try {
        recorder.stop()
      } catch {
        // Already stopped/inactive - nothing left to do (same degrade-
        // quietly convention as this file's ChatPage.tsx sibling).
      }
    }

    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())

    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
    }

    stopAndClearAudioQueue()

    setStatus('idle')
  }

  async function start(): Promise<void> {
    setStatus('connecting')

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    streamRef.current = stream

    const ws = new WebSocket(VOICE_SESSION_WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          ws.send(event.data)
        }
      }
      mediaRecorderRef.current = recorder
      recorder.start(VOICE_SESSION_TIMESLICE_MS)
      setStatus('listening')
    }

    ws.onmessage = (event) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data as string)
      } catch {
        // Malformed frame - ignored, same forward-compatible spirit as an
        // unrecognized `.type` in routeIncomingEvent above.
        return
      }
      routeIncomingEvent(parsed, callbacks, { playAudioChunk, stopAndClearAudioQueue })
    }

    // Both an unexpected close and a socket-level error end the session the
    // same way stop() does - the mic never gets left silently listening
    // with nowhere for its audio to go.
    ws.onclose = () => teardown()
    ws.onerror = () => teardown()
  }

  function stop(): void {
    teardown()
  }

  return { status, start, stop }
}
