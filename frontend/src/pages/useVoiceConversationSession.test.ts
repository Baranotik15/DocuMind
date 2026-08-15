import { act, renderHook } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceConversationSession } from './useVoiceConversationSession'
import type { VoiceConversationCallbacks } from './useVoiceConversationSession'

// This hook owns a PERSISTENT WebSocket + a continuously-chunked
// MediaRecorder (see the hook's own doc comment) - a different shape than
// ChatPage.tsx's single-shot dictation feature (record, stop, upload once).
// getUserMedia/MediaRecorder are stubbed the SAME WAY ChatPage.test.tsx's own
// 'Voice input (mic button)' describe block already does (see that file),
// matched here for consistency. WebSocket has no prior test precedent in
// this codebase - FakeWebSocket below is new: its constructor records the
// URL it was opened with, exposes `send`/`close` as vi.fn()s, and lets a
// test reach into the captured instance to fire onopen/onmessage/onclose/
// onerror directly, simulating server behavior deterministically with no
// real networking.
describe('useVoiceConversationSession', () => {
  class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = []
    stream: MediaStream
    options: MediaRecorderOptions | undefined
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    startedWithTimeslice: number | undefined

    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      this.stream = stream
      this.options = options
      FakeMediaRecorder.instances.push(this)
    }

    start(timeslice?: number): void {
      this.startedWithTimeslice = timeslice
    }

    stop(): void {
      this.onstop?.()
    }
  }

  class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    url: string
    send = vi.fn()
    close = vi.fn()
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(url: string) {
      this.url = url
      FakeWebSocket.instances.push(this)
    }
  }

  let getUserMediaMock: ReturnType<typeof vi.fn>
  let stopTrackMock: ReturnType<typeof vi.fn>
  // Each field is vi.fn<T>() (the exact callback signature as vitest 4's own
  // single-generic-parameter form), not a bare vi.fn() - so each mock is
  // simultaneously assignable to VoiceConversationCallbacks itself AND still
  // has the Mock-only members (toHaveBeenCalledWith, etc.) these tests
  // assert on below.
  let callbacks: {
    onUserMessage: ReturnType<typeof vi.fn<VoiceConversationCallbacks['onUserMessage']>>
    onReplyDelta: ReturnType<typeof vi.fn<VoiceConversationCallbacks['onReplyDelta']>>
    onReplyDone: ReturnType<typeof vi.fn<VoiceConversationCallbacks['onReplyDone']>>
    onError: ReturnType<typeof vi.fn<VoiceConversationCallbacks['onError']>>
  }

  beforeEach(() => {
    FakeMediaRecorder.instances = []
    FakeWebSocket.instances = []
    stopTrackMock = vi.fn()
    getUserMediaMock = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrackMock }],
    } as unknown as MediaStream)
    // navigator.mediaDevices doesn't exist in jsdom at all - defined fresh
    // via Object.defineProperty, same idiom ChatPage.test.tsx's own 'Voice
    // input (mic button)' describe block already uses.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    })
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    callbacks = {
      onUserMessage: vi.fn<VoiceConversationCallbacks['onUserMessage']>(),
      onReplyDelta: vi.fn<VoiceConversationCallbacks['onReplyDelta']>(),
      onReplyDone: vi.fn<VoiceConversationCallbacks['onReplyDone']>(),
      onError: vi.fn<VoiceConversationCallbacks['onError']>(),
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('start() requests the mic, opens a WebSocket to the expected URL, and reaches "listening" once the socket opens and recording begins', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))

    expect(result.current.status).toBe('idle')

    await act(async () => {
      await result.current.start()
    })

    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:8000/internal/chat/voice-session')
    // The socket hasn't opened yet (the test hasn't fired onopen) - no
    // recording has begun, and status has not reached 'listening' yet.
    expect(result.current.status).toBe('connecting')
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })

    expect(result.current.status).toBe('listening')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(FakeMediaRecorder.instances[0].stream).toBeDefined()
    expect(FakeMediaRecorder.instances[0].options).toEqual({ mimeType: 'audio/webm;codecs=opus' })
    // Started with a short repeating timeslice, not record-then-stop-once.
    expect(FakeMediaRecorder.instances[0].startedWithTimeslice).toBeGreaterThan(0)
  })

  it('routes each incoming WebSocket event to its matching callback, ignoring an unrecognized type', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'user_message', id: 'msg-1', content: 'what is the refund policy' }) })
    })
    expect(callbacks.onUserMessage).toHaveBeenCalledWith({ id: 'msg-1', content: 'what is the refund policy' })

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'Re' }) })
    })
    expect(callbacks.onReplyDelta).toHaveBeenCalledWith('Re')

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'reply_done', id: 'msg-2', noAnswerFound: false }) })
    })
    expect(callbacks.onReplyDone).toHaveBeenCalledWith({ id: 'msg-2', noAnswerFound: false })

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'error', detail: 'voice_model_not_configured' }) })
    })
    expect(callbacks.onError).toHaveBeenCalledWith('voice_model_not_configured')

    // An unrecognized type is forward-compatible, not an error - none of the
    // callbacks above fire again for it.
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'something_future', content: 'ignored' }) })
    })
    expect(callbacks.onUserMessage).toHaveBeenCalledTimes(1)
    expect(callbacks.onReplyDelta).toHaveBeenCalledTimes(1)
    expect(callbacks.onReplyDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
  })

  it("sends each MediaRecorder chunk over the WebSocket as it's produced, skipping empty chunks", async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })

    const chunk = new Blob(['fake-audio-chunk'])
    act(() => {
      FakeMediaRecorder.instances[0].ondataavailable?.({ data: chunk })
    })
    expect(FakeWebSocket.instances[0].send).toHaveBeenCalledWith(chunk)
    expect(FakeWebSocket.instances[0].send).toHaveBeenCalledTimes(1)

    // A zero-size chunk (e.g. a timeslice tick with nothing captured yet)
    // must not be forwarded.
    act(() => {
      FakeMediaRecorder.instances[0].ondataavailable?.({ data: new Blob([]) })
    })
    expect(FakeWebSocket.instances[0].send).toHaveBeenCalledTimes(1)
  })

  it('stop() stops every media stream track, closes the socket, and returns status to idle', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    expect(result.current.status).toBe('listening')

    act(() => {
      result.current.stop()
    })

    expect(stopTrackMock).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
  })

  it('an unexpected server-side close also settles status back to idle, without stop() being called explicitly', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    expect(result.current.status).toBe('listening')

    act(() => {
      FakeWebSocket.instances[0].onclose?.()
    })

    expect(result.current.status).toBe('idle')
    // The underlying resources are still cleaned up even though this close
    // came from the server side rather than a user-initiated stop().
    expect(stopTrackMock).toHaveBeenCalledTimes(1)
  })
})
