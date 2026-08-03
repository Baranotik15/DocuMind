import type { RelevantChunkMatch } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor } from '@testing-library/react'

import { RelevancePage } from './RelevancePage'
import { renderWithProviders, screen } from '../test-utils'

// RelevancePage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - same convention as ChatPage.test.tsx and the
// other rewritten page tests, rather than relying on mockClient.ts's seeded
// in-memory data.

describe('RelevancePage', () => {
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

  function stubSearch(matches: RelevantChunkMatch[], status = 200): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.endsWith('/internal/chat/top-chunks')) {
        return Promise.resolve(jsonResponse(matches, status))
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })
  }

  const matches: RelevantChunkMatch[] = [
    { chunkId: 'chunk-1', documentId: 'doc-1', filename: 'architecture-guide.pdf', content: 'The backend uses FastAPI.', matchPercent: 87.3 },
    { chunkId: 'chunk-2', documentId: 'doc-1', filename: 'architecture-guide.pdf', content: 'Celery handles background jobs.', matchPercent: 54.1 },
  ]

  it('renders a question field and a Search button', () => {
    renderWithProviders(<RelevancePage />)

    expect(screen.getByRole('textbox', { name: /question/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
  })

  it('searching posts the question and renders the matches in order with filename, percent, and content', async () => {
    stubSearch(matches)

    renderWithProviders(<RelevancePage />)

    fireEvent.change(screen.getByRole('textbox', { name: /question/i }), {
      target: { value: 'What does the backend use?' },
    })
    fireEvent.click(screen.getByRole('button', { name: /search/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8000/internal/chat/top-chunks',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ content: 'What does the backend use?' }),
        }),
      )
    })

    const results = await screen.findAllByText('architecture-guide.pdf')
    expect(results).toHaveLength(2)
    expect(screen.getByText('87.3%')).toBeInTheDocument()
    expect(screen.getByText('54.1%')).toBeInTheDocument()
    expect(screen.getByText('The backend uses FastAPI.')).toBeInTheDocument()
    expect(screen.getByText('Celery handles background jobs.')).toBeInTheDocument()

    // Order: the higher-match result renders before the lower one.
    const contentNodes = screen.getAllByText(/FastAPI|Celery/)
    expect(contentNodes[0]).toHaveTextContent('FastAPI')
    expect(contentNodes[1]).toHaveTextContent('Celery')
  })

  it('shows an empty-state message when there are no matches', async () => {
    stubSearch([])

    renderWithProviders(<RelevancePage />)

    fireEvent.change(screen.getByRole('textbox', { name: /question/i }), { target: { value: 'anything' } })
    fireEvent.click(screen.getByRole('button', { name: /search/i }))

    expect(await screen.findByText(/no matching chunks/i)).toBeInTheDocument()
  })

  it('shows an error alert when the search fails', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.endsWith('/internal/chat/top-chunks')) {
        return Promise.resolve(jsonResponse({ detail: 'chat_completion_failed' }, 502))
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    renderWithProviders(<RelevancePage />)

    fireEvent.change(screen.getByRole('textbox', { name: /question/i }), { target: { value: 'anything' } })
    fireEvent.click(screen.getByRole('button', { name: /search/i }))

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument()
  })

  it('pressing Enter in the question field triggers a search', async () => {
    stubSearch(matches)

    renderWithProviders(<RelevancePage />)

    const input = screen.getByRole('textbox', { name: /question/i })
    fireEvent.change(input, { target: { value: 'What does the backend use?' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findAllByText('architecture-guide.pdf')).toHaveLength(2)
  })

  it('does not search on an empty question', () => {
    renderWithProviders(<RelevancePage />)

    fireEvent.click(screen.getByRole('button', { name: /search/i }))

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
