import type { ChatMessage } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor, within } from '@testing-library/react'

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
})
