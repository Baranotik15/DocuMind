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

  it('renders seeded messages and the context-indicator placeholder', async () => {
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

    // Placeholder slot for the future context-switch indicator feature - no
    // behavior expected yet, per .claude/specs/phase-1-frontend-shell.md's
    // Non-Goals.
    expect(screen.getByTestId('context-indicator')).toBeInTheDocument()
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
})
