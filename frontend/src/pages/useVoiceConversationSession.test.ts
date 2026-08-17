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

  // Stands in for the browser's real HTMLAudioElement/`Audio` constructor -
  // jsdom has no real playback, so (matching FakeWebSocket/FakeMediaRecorder
  // above) this fake exposes play/pause as vi.fn()s and lets a test fire
  // onended/onerror/ontimeupdate by hand instead of relying on real timing.
  // currentTime/duration are plain settable fields - a test sets them then
  // fires ontimeupdate itself, standing in for the browser doing so as
  // playback actually progresses.
  class FakeAudio {
    static instances: FakeAudio[] = []
    src: string
    play = vi.fn()
    pause = vi.fn()
    currentTime = 0
    duration = 0
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    ontimeupdate: (() => void) | null = null

    constructor(src: string) {
      this.src = src
      FakeAudio.instances.push(this)
    }
  }

  let getUserMediaMock: ReturnType<typeof vi.fn>
  let stopTrackMock: ReturnType<typeof vi.fn>
  let createObjectURLMock: ReturnType<typeof vi.fn>
  let revokeObjectURLMock: ReturnType<typeof vi.fn>
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
    FakeAudio.instances = []
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
    vi.stubGlobal('Audio', FakeAudio)
    // jsdom has no real Blob-URL implementation - fakes return a distinct,
    // incrementing URL string each call, which is all these tests need to
    // tell queued clips apart.
    let nextObjectURLId = 0
    createObjectURLMock = vi.fn(() => `blob:fake-url-${nextObjectURLId++}`)
    revokeObjectURLMock = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock })

    callbacks = {
      onUserMessage: vi.fn<VoiceConversationCallbacks['onUserMessage']>(),
      onReplyDelta: vi.fn<VoiceConversationCallbacks['onReplyDelta']>(),
      onReplyDone: vi.fn<VoiceConversationCallbacks['onReplyDone']>(),
      onError: vi.fn<VoiceConversationCallbacks['onError']>(),
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // Restores real timers for every test, whether or not a given test
    // opted into vi.useFakeTimers() itself (a no-op when it didn't) - the
    // no-audio-fallback tests below rely on fake timers and must not leak
    // that into later tests.
    vi.useRealTimers()
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
    // Buffered, not forwarded yet - see the text/audio sync tests below for
    // the pairing/pacing behavior this hook now applies to reply_delta.
    expect(callbacks.onReplyDelta).not.toHaveBeenCalled()

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'reply_done', id: 'msg-2', noAnswerFound: false }) })
    })
    // Nothing left to ever pair with 'Re' - reply_done flushes it, then
    // fires immediately since the audio queue is empty/idle.
    expect(callbacks.onReplyDelta).toHaveBeenCalledWith('Re')
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

  it('an audio_chunk event decodes and plays the clip via a fresh Audio element', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
    })

    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(FakeAudio.instances[0].src).toBe('blob:fake-url-0')
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1)
  })

  it('queues a second audio_chunk clip and only starts it once the first finishes, proving sequential playback', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
    })
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-2') }) })
    })

    // The second clip is queued, not played, while the first is still going.
    expect(FakeAudio.instances).toHaveLength(1)
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1)

    act(() => {
      FakeAudio.instances[0].onended?.()
    })

    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:fake-url-0')
    expect(FakeAudio.instances).toHaveLength(2)
    expect(FakeAudio.instances[1].src).toBe('blob:fake-url-1')
    expect(FakeAudio.instances[1].play).toHaveBeenCalledTimes(1)
  })

  it('a user_message event arriving mid-playback stops and revokes the playing and queued clips, and a later audio_chunk starts fresh', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
    })
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-2') }) })
    })
    expect(FakeAudio.instances).toHaveLength(1)
    const playingClip = FakeAudio.instances[0]

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'user_message', id: 'msg-1', content: 'never mind' }) })
    })

    expect(playingClip.pause).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:fake-url-0')
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:fake-url-1')
    expect(callbacks.onUserMessage).toHaveBeenCalledWith({ id: 'msg-1', content: 'never mind' })
    // Nothing was left over from the interrupted turn - the queued clip
    // never got its own Audio instance/play() call.
    expect(FakeAudio.instances).toHaveLength(1)

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-3') }) })
    })

    expect(FakeAudio.instances).toHaveLength(2)
    expect(FakeAudio.instances[1].src).toBe('blob:fake-url-2')
    expect(FakeAudio.instances[1].play).toHaveBeenCalledTimes(1)
  })

  it('stop() while a clip is playing also pauses it and revokes its URL', async () => {
    const { result } = renderHook(() => useVoiceConversationSession(callbacks))
    await act(async () => {
      await result.current.start()
    })
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
    })
    const playingClip = FakeAudio.instances[0]

    act(() => {
      result.current.stop()
    })

    expect(playingClip.pause).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:fake-url-0')
  })

  // Task 1 of the text/audio sync plan (see .claude/plans/2026-08-15-voice-
  // conversation-text-audio-sync.md): reply_delta text is buffered until an
  // audio_chunk pairs it, then revealed progressively in step with that
  // clip's own playback via native timeupdate, with a safety-net flush on
  // onended/onerror and a no-audio fallback so a totally-TTS-broken reply
  // still surfaces promptly.
  describe('text/audio pacing', () => {
    it('buffers several reply_delta events until an audio_chunk pairs them, forwarding nothing yet', async () => {
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'Hello' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: ' world' }) })
      })
      expect(callbacks.onReplyDelta).not.toHaveBeenCalled()

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
      })

      // The audio_chunk claims the buffered text as its paired segment and
      // starts playback, but nothing is REVEALED until timeupdate/ended
      // fires - pairing and reveal are separate steps.
      expect(FakeAudio.instances).toHaveLength(1)
      expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1)
      expect(callbacks.onReplyDelta).not.toHaveBeenCalled()
    })

    it('reveals the paired text proportionally as ontimeupdate reports playback progress', async () => {
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'Hello world' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
      })
      const audio = FakeAudio.instances[0]

      act(() => {
        audio.duration = 10
        audio.currentTime = 5
        audio.ontimeupdate?.()
      })
      // Roughly the first half of 'Hello world' (11 chars) - assert by
      // slicing the known full text, not an exact pixel-perfect count.
      const firstCall = callbacks.onReplyDelta.mock.calls[0]?.[0] ?? ''
      expect(firstCall.length).toBeGreaterThan(0)
      expect('Hello world'.startsWith(firstCall)).toBe(true)
      expect(firstCall.length).toBeLessThan('Hello world'.length)

      act(() => {
        audio.currentTime = 10
        audio.ontimeupdate?.()
      })
      const revealedSoFar = callbacks.onReplyDelta.mock.calls.map((call) => call[0]).join('')
      expect(revealedSoFar).toBe('Hello world')
    })

    it('onended does a safety-net flush of whatever text was not yet revealed, exactly once', async () => {
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'Never fully ticked' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
      })
      const audio = FakeAudio.instances[0]

      // Simulate timeupdate under-firing: only a small partial reveal
      // happens before the clip ends.
      act(() => {
        audio.duration = 10
        audio.currentTime = 1
        audio.ontimeupdate?.()
      })
      const revealedBeforeEnd = callbacks.onReplyDelta.mock.calls.map((call) => call[0]).join('')
      expect(revealedBeforeEnd.length).toBeLessThan('Never fully ticked'.length)

      act(() => {
        audio.onended?.()
      })

      const revealedTotal = callbacks.onReplyDelta.mock.calls.map((call) => call[0]).join('')
      expect(revealedTotal).toBe('Never fully ticked')

      // The safety-net flush must not double-reveal characters already
      // shown by timeupdate.
      act(() => {
        audio.onended?.()
      })
      const revealedAfterSecondEnded = callbacks.onReplyDelta.mock.calls.map((call) => call[0]).join('')
      expect(revealedAfterSecondEnded).toBe('Never fully ticked')
    })

    it('falls back to immediate, unpaced forwarding for the rest of the turn once no audio_chunk arrives within the timeout', async () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'stuck text' }) })
      })
      expect(callbacks.onReplyDelta).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(callbacks.onReplyDelta).toHaveBeenCalledWith('stuck text')
      expect(FakeAudio.instances).toHaveLength(0)

      // Sync mode stays OFF for the rest of the turn - a further
      // reply_delta with still no audio is ALSO forwarded immediately, not
      // buffered again waiting for another timeout.
      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: ' more text' }) })
      })
      expect(callbacks.onReplyDelta).toHaveBeenCalledWith(' more text')
      expect(callbacks.onReplyDelta).toHaveBeenCalledTimes(2)
    })

    it('reply_done arriving while a segment is still playing is deferred until the queue drains, then fires with the correct payload', async () => {
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'Answer text' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
      })
      const audio = FakeAudio.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_done', id: 'msg-9', noAnswerFound: false }) })
      })
      expect(callbacks.onReplyDone).not.toHaveBeenCalled()

      act(() => {
        audio.onended?.()
      })
      expect(callbacks.onReplyDone).toHaveBeenCalledWith({ id: 'msg-9', noAnswerFound: false })
      expect(callbacks.onReplyDone).toHaveBeenCalledTimes(1)
    })

    it('reply_done arriving with the queue already empty and idle fires onReplyDone immediately', async () => {
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_done', id: 'msg-10', noAnswerFound: true }) })
      })
      expect(callbacks.onReplyDone).toHaveBeenCalledWith({ id: 'msg-10', noAnswerFound: true })
    })

    it('reply_done arriving with leftover buffered (never-paired) text flushes it via onReplyDelta before onReplyDone fires', async () => {
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'trailing text' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_done', id: 'msg-11', noAnswerFound: false }) })
      })

      expect(callbacks.onReplyDelta).toHaveBeenCalledWith('trailing text')
      expect(callbacks.onReplyDone).toHaveBeenCalledWith({ id: 'msg-11', noAnswerFound: false })
      const deltaOrder = callbacks.onReplyDelta.mock.invocationCallOrder[0]
      const doneOrder = callbacks.onReplyDone.mock.invocationCallOrder[0]
      expect(deltaOrder).toBeLessThan(doneOrder)
    })

    it('a barge-in mid-reveal resets pairing/reveal/deferred-reply_done state so the new turn starts clean', async () => {
      const { result } = renderHook(() => useVoiceConversationSession(callbacks))
      await act(async () => {
        await result.current.start()
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      const ws = FakeWebSocket.instances[0]

      // Old turn: one paired/playing segment, plus leftover unpaired text
      // buffered after it, plus a reply_done that arrives while the queue
      // is still busy (so it gets deferred).
      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'Sentence one.' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-1') }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'Sentence two' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_done', id: 'msg-old', noAnswerFound: false }) })
      })
      expect(callbacks.onReplyDone).not.toHaveBeenCalled()

      callbacks.onReplyDelta.mockClear()

      // Barge-in: a new user_message interrupts everything above.
      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'user_message', id: 'msg-new', content: 'never mind' }) })
      })
      expect(callbacks.onReplyDone).not.toHaveBeenCalled()

      // New turn: fresh pairing/reveal, with none of the old turn's
      // leftover text mixed in.
      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'New reply' }) })
        ws.onmessage?.({ data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('fake-mp3-bytes-2') }) })
      })
      const newAudio = FakeAudio.instances[FakeAudio.instances.length - 1]

      act(() => {
        newAudio.onended?.()
      })
      const revealedInNewTurn = callbacks.onReplyDelta.mock.calls.map((call) => call[0]).join('')
      expect(revealedInNewTurn).toBe('New reply')

      // The OLD turn's deferred reply_done must never fire, even though its
      // queue is now (coincidentally) drained too.
      expect(callbacks.onReplyDone).not.toHaveBeenCalled()

      // A reply_done for the NEW turn still works normally (queue idle by
      // this point).
      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: 'reply_done', id: 'msg-new-done', noAnswerFound: false }) })
      })
      expect(callbacks.onReplyDone).toHaveBeenCalledWith({ id: 'msg-new-done', noAnswerFound: false })
    })
  })
})
