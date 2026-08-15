import type { ChatMessage } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, fireEvent, waitFor, within } from '@testing-library/react'

import { ChatPage } from './ChatPage'
import { renderWithProviders, screen } from '../test-utils'

// ChatPage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - so, same as httpClient.test.ts and the other
// rewritten page tests (UploadPage.test.tsx, ChunkPreviewPage.test.tsx,
// DashboardPage.test.tsx), stub global `fetch` rather than relying on
// mockClient.ts's seeded in-memory data.

const seededMessages: ChatMessage[] = [
  { id: 'msg-1', role: 'user', content: 'How do I upload a new document?', disliked: false },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'Go to the Upload page and choose a file to add it to the library.',
    disliked: false,
  },
  { id: 'msg-3', role: 'user', content: 'Can I edit the generated chunks afterward?', disliked: false },
  {
    id: 'msg-4',
    role: 'assistant',
    content: 'Yes, open the Chunks page, edit any chunk inline, and click Save.',
    disliked: false,
  },
]

describe('ChatPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // The "cleared" state now persists in localStorage (see Clear chat's
    // own tests below) - reset between tests so one test's clear can't
    // leak into another's fresh render.
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response
  }

  function emptyResponse(status = 204): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new Error('no body')
      },
    } as unknown as Response
  }

  function stubFetch(
    options: {
      sendResult?: 'success' | 'failure'
      assistantReply?: ChatMessage
    } = {},
  ): void {
    const {
      sendResult = 'success',
      assistantReply = {
        id: 'msg-5',
        role: 'assistant',
        content: 'PDF, DOCX, Markdown, and plain text.',
        disliked: false,
      },
    } = options

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'

      if (method === 'GET' && url.endsWith('/internal/chat/messages')) {
        return Promise.resolve(jsonResponse(seededMessages))
      }
      if (method === 'POST' && url.endsWith('/internal/chat/messages')) {
        if (sendResult === 'failure') {
          return Promise.resolve(jsonResponse({ detail: 'chat_completion_failed' }, 502))
        }
        return Promise.resolve(jsonResponse(assistantReply))
      }
      if (method === 'POST' && url.endsWith('/dislike')) {
        return Promise.resolve(emptyResponse(204))
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })
  }

  it('shows a centered welcome message when there is no chat history yet', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.endsWith('/internal/chat/messages')) {
        return Promise.resolve(jsonResponse([]))
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    renderWithProviders(<ChatPage />)

    expect(await screen.findByText('Ask DocuMind about your documents')).toBeInTheDocument()
    expect(screen.getByTestId('bot-avatar')).toBeInTheDocument()
  })

  it('hides the welcome message once there is chat history', async () => {
    stubFetch()

    renderWithProviders(<ChatPage />)

    await screen.findByText('How do I upload a new document?')
    expect(screen.queryByText('Ask DocuMind about your documents')).not.toBeInTheDocument()
  })

  it('renders seeded messages', async () => {
    stubFetch()

    renderWithProviders(<ChatPage />)

    // Seeded chat messages (stubbed from GET /internal/chat/messages) load
    // asynchronously.
    expect(await screen.findByText('How do I upload a new document?')).toBeInTheDocument()
    expect(
      await screen.findByText('Go to the Upload page and choose a file to add it to the library.'),
    ).toBeInTheDocument()
    expect(await screen.findByText('Can I edit the generated chunks afterward?')).toBeInTheDocument()
    expect(
      await screen.findByText('Yes, open the Chunks page, edit any chunk inline, and click Save.'),
    ).toBeInTheDocument()
  })

  it('dislikes an assistant message and reflects the disliked state visually', async () => {
    stubFetch()

    renderWithProviders(<ChatPage />)

    const assistantMessageText = await screen.findByText(
      'Go to the Upload page and choose a file to add it to the library.',
    )
    const messageContainer = assistantMessageText.closest('[data-message-id="msg-2"]')
    expect(messageContainer).not.toBeNull()

    const dislikeButton = within(messageContainer as HTMLElement).getByRole('button', { name: /dislike message/i })
    fireEvent.click(dislikeButton)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8000/internal/chat/messages/msg-2/dislike',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    await waitFor(() => {
      expect(
        within(messageContainer as HTMLElement).getByRole('button', { name: /message disliked/i }),
      ).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it('clicking dislike a second time undoes it - easy to hit by accident, so it toggles back off', async () => {
    stubFetch()

    renderWithProviders(<ChatPage />)

    const assistantMessageText = await screen.findByText(
      'Go to the Upload page and choose a file to add it to the library.',
    )
    const messageContainer = assistantMessageText.closest('[data-message-id="msg-2"]')
    expect(messageContainer).not.toBeNull()

    fireEvent.click(within(messageContainer as HTMLElement).getByRole('button', { name: /dislike message/i }))
    await waitFor(() => {
      expect(
        within(messageContainer as HTMLElement).getByRole('button', { name: /message disliked/i }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    fireEvent.click(within(messageContainer as HTMLElement).getByRole('button', { name: /message disliked/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8000/internal/chat/messages/msg-2/dislike',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    await waitFor(() => {
      expect(
        within(messageContainer as HTMLElement).getByRole('button', { name: /dislike message/i }),
      ).toHaveAttribute('aria-pressed', 'false')
    })
  })

  it('optimistically shows the sent message and appends the assistant reply once it resolves', async () => {
    const assistantReply: ChatMessage = {
      id: 'msg-5',
      role: 'assistant',
      content: 'PDF, DOCX, Markdown, and plain text.',
      disliked: false,
    }
    stubFetch({ assistantReply })

    renderWithProviders(<ChatPage />)

    await screen.findByText('How do I upload a new document?')

    const input = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(input, { target: { value: 'What file formats are supported?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    // The typed message shows up immediately (optimistic append), even
    // though sendChatMessage now resolves to the assistant reply only, not
    // an echo of the user's own message.
    expect(await screen.findByText('What file formats are supported?')).toBeInTheDocument()
    // The assistant's reply is appended once the request resolves.
    expect(await screen.findByText('PDF, DOCX, Markdown, and plain text.')).toBeInTheDocument()
  })

  it('keeps the optimistic user message and shows an inline error when the assistant fails to respond', async () => {
    stubFetch({ sendResult: 'failure' })

    renderWithProviders(<ChatPage />)

    await screen.findByText('How do I upload a new document?')

    const input = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(input, { target: { value: 'What file formats are supported?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    // The user's own message is genuinely persisted server-side even when
    // the OpenAI call fails, so it stays visible (this also doubles as
    // verification that the ChatCompletionError rejection is handled, not
    // left unhandled - vitest fails a test on an unhandled rejection).
    expect(await screen.findByText('What file formats are supported?')).toBeInTheDocument()
    expect(await screen.findByText("The assistant couldn't respond - try again.")).toBeInTheDocument()
  })

  it('shows a typing indicator while the assistant reply is in flight, then hides it once the reply resolves', async () => {
    const assistantReply: ChatMessage = {
      id: 'msg-5',
      role: 'assistant',
      content: 'PDF, DOCX, Markdown, and plain text.',
      disliked: false,
    }
    // A send request that stays pending until the test explicitly resolves
    // it, so the intermediate "typing" state can actually be observed
    // (stubFetch's default mock resolves synchronously, which never gives
    // the test a chance to see the indicator before the reply lands).
    let resolveSend: (response: Response) => void = () => {
      throw new Error('resolveSend called before being assigned')
    }
    const sendResponse = new Promise<Response>((resolve) => {
      resolveSend = resolve
    })

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.endsWith('/internal/chat/messages')) {
        return Promise.resolve(jsonResponse(seededMessages))
      }
      if (method === 'POST' && url.endsWith('/internal/chat/messages')) {
        return sendResponse
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    renderWithProviders(<ChatPage />)

    await screen.findByText('How do I upload a new document?')

    const input = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(input, { target: { value: 'What file formats are supported?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(await screen.findByTestId('typing-indicator')).toBeInTheDocument()

    resolveSend(jsonResponse(assistantReply))

    await waitFor(() => {
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument()
    })
    expect(await screen.findByText('PDF, DOCX, Markdown, and plain text.')).toBeInTheDocument()
  })

  it('hides the typing indicator once the assistant reply fails', async () => {
    let resolveSend: (response: Response) => void = () => {
      throw new Error('resolveSend called before being assigned')
    }
    const sendResponse = new Promise<Response>((resolve) => {
      resolveSend = resolve
    })

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.endsWith('/internal/chat/messages')) {
        return Promise.resolve(jsonResponse(seededMessages))
      }
      if (method === 'POST' && url.endsWith('/internal/chat/messages')) {
        return sendResponse
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    renderWithProviders(<ChatPage />)

    await screen.findByText('How do I upload a new document?')

    const input = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(input, { target: { value: 'What file formats are supported?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(await screen.findByTestId('typing-indicator')).toBeInTheDocument()

    resolveSend(jsonResponse({ detail: 'chat_completion_failed' }, 502))

    await waitFor(() => {
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument()
    })
    expect(await screen.findByText("The assistant couldn't respond - try again.")).toBeInTheDocument()
  })

  it('renders the bot avatar on assistant messages only', async () => {
    stubFetch()

    renderWithProviders(<ChatPage />)

    const userMessageText = await screen.findByText('How do I upload a new document?')
    const userContainer = userMessageText.closest('[data-message-id="msg-1"]')
    expect(userContainer).not.toBeNull()
    expect(within(userContainer as HTMLElement).queryByTestId('bot-avatar')).not.toBeInTheDocument()

    const assistantMessageText = await screen.findByText(
      'Go to the Upload page and choose a file to add it to the library.',
    )
    const assistantContainer = assistantMessageText.closest('[data-message-id="msg-2"]')
    expect(assistantContainer).not.toBeNull()
    expect(within(assistantContainer as HTMLElement).getByTestId('bot-avatar')).toBeInTheDocument()
  })

  it('falls back to the hand-drawn glyph if the custom avatar image fails to load', async () => {
    stubFetch()

    renderWithProviders(<ChatPage />)

    const assistantMessageText = await screen.findByText(
      'Go to the Upload page and choose a file to add it to the library.',
    )
    const messageContainer = assistantMessageText.closest('[data-message-id="msg-2"]') as HTMLElement
    const avatar = within(messageContainer).getByTestId('bot-avatar')

    const image = avatar.querySelector('img')
    expect(image).not.toBeNull()
    expect(avatar.querySelector('svg')).toBeNull()

    fireEvent.error(image as HTMLImageElement)

    expect(avatar.querySelector('img')).toBeNull()
    expect(avatar.querySelector('svg')).not.toBeNull()
  })

  describe('Clear chat', () => {
    it('does not clear anything until the confirmation dialog is accepted', async () => {
      stubFetch()

      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))

      // Mantine's Modal mounts via an enter transition rather than
      // instantly, same as the confirm dialogs in UploadPage.test.tsx/
      // ChunkPreviewPage.test.tsx - wait for it.
      expect(await screen.findByText('Clear chat window?')).toBeInTheDocument()
      expect(screen.getByText('How do I upload a new document?')).toBeInTheDocument()
    })

    it('keeps the messages when the confirmation dialog is dismissed', async () => {
      stubFetch()

      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
      await screen.findByText('Clear chat window?')
      fireEvent.click(screen.getByRole('button', { name: 'Keep visible' }))

      // Mantine's Modal unmounts via an exit transition rather than
      // instantly - wait for it.
      await waitFor(() => expect(screen.queryByText('Clear chat window?')).not.toBeInTheDocument())
      expect(screen.getByText('How do I upload a new document?')).toBeInTheDocument()
    })

    it('confirming Clear chat empties the visible message list WITHOUT calling the backend - history stays in the database', async () => {
      stubFetch()

      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      const fetchCallsBeforeClear = fetchMock.mock.calls.length

      fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
      await screen.findByText('Clear chat window?')
      fireEvent.click(screen.getByRole('button', { name: 'Clear chat window' }))

      await waitFor(() => {
        expect(screen.queryByText('How do I upload a new document?')).not.toBeInTheDocument()
      })
      await waitFor(() => expect(screen.queryByText('Clear chat window?')).not.toBeInTheDocument())
      // Purely local - no additional fetch call fired for the clear itself.
      expect(fetchMock.mock.calls.length).toBe(fetchCallsBeforeClear)
    })

    it('a cleared conversation stays hidden after a reload, even though the backend still has it', async () => {
      stubFetch()

      const first = renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
      await screen.findByText('Clear chat window?')
      fireEvent.click(screen.getByRole('button', { name: 'Clear chat window' }))
      await waitFor(() => expect(screen.queryByText('How do I upload a new document?')).not.toBeInTheDocument())

      first.unmount()

      // Simulates a page reload: a fresh mount, with the backend still
      // returning the exact same seeded list it always has (nothing was
      // ever deleted server-side) - the previously-cleared messages must
      // stay hidden anyway, via the local record of what was cleared.
      renderWithProviders(<ChatPage />)

      expect(await screen.findByText('Ask DocuMind about your documents')).toBeInTheDocument()
      expect(screen.queryByText('How do I upload a new document?')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Go to the Upload page and choose a file to add it to the library.'),
      ).not.toBeInTheDocument()
    })

    it('a message sent after clearing stays visible through a later reload', async () => {
      const assistantReply: ChatMessage = {
        id: 'msg-5',
        role: 'assistant',
        content: 'PDF, DOCX, Markdown, and plain text.',
        disliked: false,
      }
      stubFetch({ assistantReply })

      const first = renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
      await screen.findByText('Clear chat window?')
      fireEvent.click(screen.getByRole('button', { name: 'Clear chat window' }))
      await waitFor(() => expect(screen.queryByText('How do I upload a new document?')).not.toBeInTheDocument())

      const input = screen.getByRole('textbox', { name: /message/i })
      fireEvent.change(input, { target: { value: 'What file formats are supported?' } })
      fireEvent.click(screen.getByRole('button', { name: /send/i }))
      expect(await screen.findByText('PDF, DOCX, Markdown, and plain text.')).toBeInTheDocument()

      first.unmount()

      // The backend now returns the seeded history PLUS the new exchange -
      // the new messages (not in the hidden-ids set) should survive a
      // reload; the old, already-cleared ones should still stay hidden.
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/chat/messages')) {
          return Promise.resolve(
            jsonResponse([
              ...seededMessages,
              { id: 'msg-6', role: 'user', content: 'What file formats are supported?', disliked: false },
              { id: 'msg-5', role: 'assistant', content: 'PDF, DOCX, Markdown, and plain text.', disliked: false },
            ]),
          )
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      renderWithProviders(<ChatPage />)

      expect(await screen.findByText('PDF, DOCX, Markdown, and plain text.')).toBeInTheDocument()
      expect(screen.queryByText('How do I upload a new document?')).not.toBeInTheDocument()
    })
  })

  // jsdom has no real MediaRecorder/getUserMedia - FakeMediaRecorder's
  // stop() synchronously fires both ondataavailable and onstop (a real
  // MediaRecorder does this asynchronously, but synchronous is enough to
  // exercise ChatPage's own state transitions and is far simpler to drive
  // from a test). navigator.mediaDevices doesn't exist in jsdom at all, so
  // it's defined fresh via Object.defineProperty (same pattern
  // src/test-setup.ts already uses for matchMedia/ResizeObserver/
  // document.fonts - there's no existing precedent for mediaDevices
  // specifically, this follows that file's established shape) rather than
  // vi.spyOn, which requires the property to already exist on the object.
  describe('Voice input (mic button)', () => {
    class FakeMediaRecorder {
      stream: MediaStream
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(stream: MediaStream) {
        this.stream = stream
      }
      start(): void {}
      stop(): void {
        this.ondataavailable?.({ data: new Blob(['fake-audio']) })
        this.onstop?.()
      }
    }

    // jsdom also has no Web Audio API - playRecordingSound's try/catch means
    // ChatPage itself never crashes without it (see that function's own doc
    // comment), but these fakes let the two tests below actually assert a
    // start/stop beep was played, not just that nothing threw. Records each
    // oscillator's frequency at the moment .start() is called - matching
    // playRecordingSound, which always sets `oscillator.frequency.value`
    // before calling .start().
    let recordedOscillatorFrequencies: number[]

    class FakeGainNode {
      gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }
      connect(): void {}
    }

    class FakeOscillatorNode {
      frequency = { value: 0 }
      onended: (() => void) | null = null
      connect(): void {}
      start(): void {
        recordedOscillatorFrequencies.push(this.frequency.value)
      }
      stop(): void {
        this.onended?.()
      }
    }

    class FakeAudioContext {
      currentTime = 0
      destination = {}
      createOscillator(): FakeOscillatorNode {
        return new FakeOscillatorNode()
      }
      createGain(): FakeGainNode {
        return new FakeGainNode()
      }
      close(): Promise<void> {
        return Promise.resolve()
      }
    }

    let getUserMediaMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      getUserMediaMock = vi.fn().mockResolvedValue({ getTracks: () => [] } as unknown as MediaStream)
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: getUserMediaMock },
      })
      vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
      recordedOscillatorFrequencies = []
      vi.stubGlobal('AudioContext', FakeAudioContext)
    })

    function stubMessagesAndTranscribe(transcribeResponse: () => Response): void {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/chat/messages')) {
          return Promise.resolve(jsonResponse(seededMessages))
        }
        if (method === 'POST' && url.endsWith('/internal/chat/transcribe')) {
          return Promise.resolve(transcribeResponse())
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })
    }

    it('clicking the mic button starts recording, flipping its aria-label, showing the stop-square icon, and playing a start beep', async () => {
      stubMessagesAndTranscribe(() => jsonResponse({ text: 'hello' }))
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument()
      })
      expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true })
      // The button swaps its mic glyph for a filled square (StopIcon) the
      // instant recording starts - a widely-recognized "click to stop" cue,
      // not just a color change.
      expect(screen.getByTestId('voice-recording-icon')).toBeInTheDocument()
      // One oscillator, at the start-cue's pitch (see RECORDING_START_BEEP_HZ).
      expect(recordedOscillatorFrequencies).toEqual([880])
    })

    it('stopping the recording shows a transcribing state, then APPENDS the transcribed text to an existing draft (joined by a space)', async () => {
      stubMessagesAndTranscribe(() => jsonResponse({ text: 'hello' }))
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      // Seed the input with prior text first, to prove the transcribed text
      // is APPENDED (space-joined) rather than replacing it - revised
      // 2026-08-14 per explicit request, see handleRecordingStopped's own
      // comment.
      const input = screen.getByRole('textbox', { name: /message/i })
      fireEvent.change(input, { target: { value: 'existing draft text' } })

      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }))

      // FakeMediaRecorder.stop() fires onstop synchronously, which sets
      // micState to 'transcribing' before the (mocked, but still
      // microtask-async) transcribeVoice call resolves.
      expect(screen.getByTestId('voice-transcribing')).toBeInTheDocument()

      await waitFor(() => {
        expect(input).toHaveValue('existing draft text hello')
      })
      expect(screen.queryByTestId('voice-transcribing')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /start voice input/i })).toBeInTheDocument()
    })

    it('sets the transcribed text directly (no leading space) when the draft was empty', async () => {
      stubMessagesAndTranscribe(() => jsonResponse({ text: 'hello' }))
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      const input = screen.getByRole('textbox', { name: /message/i })
      expect(input).toHaveValue('')

      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }))

      await waitFor(() => {
        expect(input).toHaveValue('hello')
      })
    })

    it('plays a lower-pitched beep when the recording stops, distinct from the start beep', async () => {
      stubMessagesAndTranscribe(() => jsonResponse({ text: 'hello' }))
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }))

      // FakeMediaRecorder.stop() fires onstop synchronously (see its own
      // comment above), so the stop beep has already played by the time
      // this assertion runs, no waitFor needed - same reasoning the
      // 'voice-transcribing' assertion right after this uses elsewhere in
      // this file. Start beep first (880Hz), then a distinctly lower stop
      // beep (440Hz) - see RECORDING_START_BEEP_HZ/RECORDING_STOP_BEEP_HZ.
      expect(recordedOscillatorFrequencies).toEqual([880, 440])
    })

    it('shows the voice-unavailable message when the backend has no model configured', async () => {
      stubMessagesAndTranscribe(() => jsonResponse({ detail: 'voice_model_not_configured' }, 503))
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }))

      expect(
        await screen.findByText("Voice recognition isn't set up on the server yet - see the README's Voice Recognition section."),
      ).toBeInTheDocument()
    })

    it('shows a generic error message when transcription fails for any other reason', async () => {
      stubMessagesAndTranscribe(() => jsonResponse({ detail: 'audio_processing_failed' }, 400))
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }))

      expect(await screen.findByText("Couldn't transcribe that - try again.")).toBeInTheDocument()
    })

    it('shows the generic error and stays idle when getUserMedia rejects (no mic, permission denied, unsupported)', async () => {
      getUserMediaMock.mockRejectedValue(new Error('permission denied'))
      stubMessagesAndTranscribe(() => jsonResponse({ text: 'hello' }))
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }))

      expect(await screen.findByText("Couldn't transcribe that - try again.")).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /start voice input/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /stop recording/i })).not.toBeInTheDocument()
    })
  })

  // The separate, dedicated voice-conversation-mode button/session (see
  // useVoiceConversationSession.ts) - deliberately different stubbing shape
  // than 'Voice input (mic button)' above: this feature owns a PERSISTENT
  // WebSocket, not just getUserMedia/MediaRecorder, so FakeWebSocket is
  // duplicated here rather than shared with useVoiceConversationSession's own
  // test file, matching that file's own "small setup, fine to duplicate"
  // call.
  describe('Voice conversation mode', () => {
    class FakeMediaRecorder {
      stream: MediaStream
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(stream: MediaStream) {
        this.stream = stream
      }
      start(): void {}
      stop(): void {}
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

    // jsdom never actually decodes/plays a real clip - same hand-driven-
    // events stubbing style useVoiceConversationSession.test.ts already
    // established for the hook's own reveal-pacing tests (ontimeupdate/
    // onended are fired manually by test code, currentTime/duration are
    // plain settable fields, not real media metadata).
    class FakeAudio {
      static instances: FakeAudio[] = []
      src: string
      currentTime = 0
      duration = 0
      ontimeupdate: (() => void) | null = null
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      play = vi.fn()
      pause = vi.fn()
      constructor(src: string) {
        this.src = src
        FakeAudio.instances.push(this)
      }
    }

    let getUserMediaMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      FakeWebSocket.instances = []
      FakeAudio.instances = []
      getUserMediaMock = vi.fn().mockResolvedValue({ getTracks: () => [] } as unknown as MediaStream)
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: getUserMediaMock },
      })
      vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
      vi.stubGlobal('WebSocket', FakeWebSocket)
      vi.stubGlobal('Audio', FakeAudio)
      vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake-url'), revokeObjectURL: vi.fn() })
    })

    async function startVoiceConversation(): Promise<void> {
      fireEvent.click(screen.getByRole('button', { name: /start voice conversation/i }))
      await waitFor(() => {
        expect(FakeWebSocket.instances).toHaveLength(1)
      })
      act(() => {
        FakeWebSocket.instances[0].onopen?.()
      })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /end voice conversation/i })).toBeInTheDocument()
      })
    }

    it('clicking the button shows the listening state and disables the message input, Send button, and dictation mic button', async () => {
      stubFetch()
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      await startVoiceConversation()

      expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /start voice input/i })).toBeDisabled()
    })

    it("a 'user_message' event appends a user ChatMessage to the transcript", async () => {
      stubFetch()
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      await startVoiceConversation()

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'user_message', id: 'voice-msg-1', content: 'what is the refund policy' }),
        })
      })

      expect(await screen.findByText('what is the refund policy')).toBeInTheDocument()
    })

    it("'reply_delta' events after that render a growing assistant bubble with the accumulated text once paired with an audio_chunk and revealed", async () => {
      // Paced text reveal (see useVoiceConversationSession.ts's own tests
      // for the full pacing mechanism) buffers reply_delta text until it's
      // paired with the next audio_chunk, then reveals it as that clip's
      // FakeAudio reports playback progress via ontimeupdate - matching
      // the hook's own test file's stubbing style (a real Audio instance
      // never actually gets constructed/played in jsdom).
      stubFetch()
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      await startVoiceConversation()

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'user_message', id: 'voice-msg-1', content: 'what is the refund policy' }),
        })
      })

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'reply_delta', content: 'The refund' }) })
      })
      // Still buffered, not yet revealed - no audio_chunk has claimed it yet.
      expect(screen.queryByText('The refund')).not.toBeInTheDocument()
      expect(screen.getByTestId('voice-streaming-reply')).toBeInTheDocument()

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('first-clip') }),
        })
      })
      const firstAudio = FakeAudio.instances[0]
      act(() => {
        firstAudio.duration = 4
        firstAudio.currentTime = 4
        firstAudio.ontimeupdate?.()
      })
      expect(await screen.findByText('The refund')).toBeInTheDocument()

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'reply_delta', content: ' policy is 30 days.' }),
        })
      })
      act(() => {
        firstAudio.onended?.()
      })
      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'audio_chunk', audioBase64: btoa('second-clip') }),
        })
      })
      const secondAudio = FakeAudio.instances[1]
      act(() => {
        secondAudio.duration = 3
        secondAudio.currentTime = 3
        secondAudio.ontimeupdate?.()
      })
      expect(await screen.findByText('The refund policy is 30 days.')).toBeInTheDocument()
    })

    it("'reply_done' finalizes the streaming bubble into a real assistant message and the transient bubble disappears", async () => {
      stubFetch()
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      await startVoiceConversation()

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'user_message', id: 'voice-msg-1', content: 'what is the refund policy' }),
        })
      })
      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'reply_delta', content: 'The refund policy is 30 days.' }),
        })
      })
      await screen.findByTestId('voice-streaming-reply')

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'reply_done', id: 'voice-reply-1', noAnswerFound: false }),
        })
      })

      expect(await screen.findByText('The refund policy is 30 days.')).toBeInTheDocument()
      expect(screen.queryByTestId('voice-streaming-reply')).not.toBeInTheDocument()
    })

    it("an 'error' event with detail 'voice_model_not_configured' shows the existing voice-unavailable alert", async () => {
      stubFetch()
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      await startVoiceConversation()

      act(() => {
        FakeWebSocket.instances[0].onmessage?.({
          data: JSON.stringify({ type: 'error', detail: 'voice_model_not_configured' }),
        })
      })

      expect(
        await screen.findByText("Voice recognition isn't set up on the server yet - see the README's Voice Recognition section."),
      ).toBeInTheDocument()
    })

    it('clicking the button again while active ends the session: input/Send/mic re-enable and the button returns to idle', async () => {
      stubFetch()
      renderWithProviders(<ChatPage />)
      await screen.findByText('How do I upload a new document?')

      await startVoiceConversation()

      fireEvent.click(screen.getByRole('button', { name: /end voice conversation/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start voice conversation/i })).toBeInTheDocument()
      })
      expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('textbox', { name: /message/i })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: /start voice input/i })).not.toBeDisabled()
    })
  })
})
