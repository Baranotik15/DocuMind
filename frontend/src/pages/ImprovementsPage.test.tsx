import type { DislikedMessage, NoAnswerMessage } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor } from '@testing-library/react'

import { ImprovementsPage } from './ImprovementsPage'
import { renderWithProviders, screen } from '../test-utils'

// ImprovementsPage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - so, same as DashboardPage.test.tsx/
// AppLayout.test.tsx, stub global `fetch` rather than mocking apiClient.

const dislikedMessages: DislikedMessage[] = [
  {
    id: 'dislike-1',
    content: "I'm not able to help with that request.",
    questionContent: 'How do I reset my password?',
    dislikedAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-07-31T09:00:00.000Z',
  },
]

const noAnswerMessages: NoAnswerMessage[] = [
  {
    id: 'no-answer-1',
    content: "That isn't covered in the uploaded documentation.",
    questionContent: 'What is the meaning of life?',
    createdAt: '2026-08-02T11:30:00.000Z',
  },
]

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('ImprovementsPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      if (url.includes('/internal/chat/dislikes')) {
        return Promise.resolve(jsonResponse(dislikedMessages))
      }
      if (url.includes('/internal/chat/no-answer-messages')) {
        return Promise.resolve(jsonResponse(noAnswerMessages))
      }
      if (url.includes('/dismiss-no-answer')) {
        return Promise.resolve(jsonResponse(null, 204))
      }
      if (url.includes('/dislike')) {
        return Promise.resolve(jsonResponse(null, 204))
      }
      return Promise.resolve(jsonResponse([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders with the sub-tab toggle, defaulting to Lists', async () => {
    renderWithProviders(<ImprovementsPage />)

    const listsButton = await screen.findByRole('button', { name: 'Lists' })
    const analysisButton = screen.getByRole('button', { name: 'Analysis' })

    expect(listsButton).toHaveAttribute('aria-pressed', 'true')
    expect(analysisButton).toHaveAttribute('aria-pressed', 'false')
  })

  it("shows both panels' seeded entries under the Lists sub-tab", async () => {
    renderWithProviders(<ImprovementsPage />)

    expect(await screen.findByText('How do I reset my password?')).toBeInTheDocument()
    expect(screen.getByText("I'm not able to help with that request.")).toBeInTheDocument()

    expect(await screen.findByText('What is the meaning of life?')).toBeInTheDocument()
    expect(screen.getByText("That isn't covered in the uploaded documentation.")).toBeInTheDocument()
  })

  it('refetches the Dislikes panel with the selected range when its own toggle changes', async () => {
    renderWithProviders(<ImprovementsPage />)
    await screen.findByText('How do I reset my password?')

    // index 0 - the Dislikes panel's own range toggle is rendered before the
    // No Answer panel's own (identical-labeled) toggle.
    fireEvent.click(screen.getAllByRole('button', { name: '7 Days' })[0])

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/internal/chat/dislikes?range=7days'), expect.anything())
    })
  })

  it('refetches the No Answer panel with the selected range when its own toggle changes', async () => {
    renderWithProviders(<ImprovementsPage />)
    await screen.findByText('What is the meaning of life?')

    // index 1 - the No Answer panel's own range toggle.
    fireEvent.click(screen.getAllByRole('button', { name: '30 Days' })[1])

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/internal/chat/no-answer-messages?range=30days'), expect.anything())
    })
  })

  it('removing a Dislikes row calls the dislike endpoint and removes it from view', async () => {
    renderWithProviders(<ImprovementsPage />)
    await screen.findByText('How do I reset my password?')

    fireEvent.click(screen.getByRole('button', { name: 'Remove from Dislikes' }))

    await waitFor(() => {
      expect(screen.queryByText('How do I reset my password?')).not.toBeInTheDocument()
    })

    const call = fetchMock.mock.calls.find((args: unknown[]) => (args[0] as string).includes('/dislike-1/dislike'))
    expect(call).toBeDefined()
    const [url, init] = call as [string, RequestInit]
    expect(url).toContain('/internal/chat/messages/dislike-1/dislike')
    expect(init.method).toBe('POST')
  })

  it('removing a No Answer row calls the dismiss endpoint and removes it from view', async () => {
    renderWithProviders(<ImprovementsPage />)
    await screen.findByText('What is the meaning of life?')

    fireEvent.click(screen.getByRole('button', { name: 'Remove from No Answer' }))

    await waitFor(() => {
      expect(screen.queryByText('What is the meaning of life?')).not.toBeInTheDocument()
    })

    const call = fetchMock.mock.calls.find((args: unknown[]) => (args[0] as string).includes('/no-answer-1/dismiss-no-answer'))
    expect(call).toBeDefined()
    const [url, init] = call as [string, RequestInit]
    expect(url).toContain('/internal/chat/messages/no-answer-1/dismiss-no-answer')
    expect(init.method).toBe('POST')
  })

  it('shows an empty-state message instead of an empty table when a panel has no entries for the current range', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/internal/chat/dislikes')) {
        return Promise.resolve(jsonResponse(dislikedMessages))
      }
      if (url.includes('/internal/chat/no-answer-messages')) {
        return Promise.resolve(jsonResponse([]))
      }
      return Promise.resolve(jsonResponse([]))
    })

    renderWithProviders(<ImprovementsPage />)

    expect(await screen.findByText('How do I reset my password?')).toBeInTheDocument()
    expect(await screen.findByText(/no messages the bot couldn't answer/i)).toBeInTheDocument()
    // Dislikes panel has an entry, so it must NOT also show its own
    // empty-state message alongside it.
    expect(screen.queryByText(/no dislikes yet/i)).not.toBeInTheDocument()
  })

  it('switching to the Analysis sub-tab shows an inert placeholder button that fires no request when clicked', async () => {
    renderWithProviders(<ImprovementsPage />)
    await screen.findByText('How do I reset my password?')

    const callCountBeforeSwitch = fetchMock.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))

    const analyzeButton = await screen.findByRole('button', { name: /analyze with ai/i })
    expect(screen.queryByText('How do I reset my password?')).not.toBeInTheDocument()

    fireEvent.click(analyzeButton)

    expect(fetchMock.mock.calls.length).toBe(callCountBeforeSwitch)
  })
})
