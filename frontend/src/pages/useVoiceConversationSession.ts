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

// The four event shapes the backend's voice-session WebSocket can send (see
// backend/app/chat/schemas.py's VoiceUserMessageEvent/VoiceReplyDeltaEvent/
// VoiceReplyDoneEvent/VoiceErrorEvent) - a plain discriminated union so
// routeIncomingEvent below can switch on `.type` with narrowing. Deliberately
// has NO catch-all/index-signature member for an unrecognized `.type` - see
// routeIncomingEvent's own `default` branch for how that's handled instead;
// adding one here would widen every other member's fields to `unknown`
// (matching that member's index signature too, since a literal `.type` is
// always also assignable to a `string`-typed one).
type VoiceSessionEvent =
  | { type: 'user_message'; id: string; content: string }
  | { type: 'reply_delta'; content: string }
  | { type: 'reply_done'; id: string; noAnswerFound: boolean }
  | { type: 'error'; detail: string }

function routeIncomingEvent(event: unknown, callbacks: VoiceConversationCallbacks): void {
  if (typeof event !== 'object' || event === null || !('type' in event)) {
    // Malformed/unexpected shape - same forward-compatible "ignore it"
    // contract as an unrecognized `.type` below.
    return
  }

  const typedEvent = event as VoiceSessionEvent
  switch (typedEvent.type) {
    case 'user_message':
      callbacks.onUserMessage({ id: typedEvent.id, content: typedEvent.content })
      return
    case 'reply_delta':
      callbacks.onReplyDelta(typedEvent.content)
      return
    case 'reply_done':
      callbacks.onReplyDone({ id: typedEvent.id, noAnswerFound: typedEvent.noAnswerFound })
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
      routeIncomingEvent(parsed, callbacks)
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
