import type { Chunk, DocumentSummary } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MantineProvider } from '@mantine/core'
import { fireEvent, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { ChunkPreviewPage } from './ChunkPreviewPage'
import { screen } from '../test-utils'

// ChunkPreviewPage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - so, same as httpClient.test.ts, UploadPage.test.tsx,
// and DashboardPage.test.tsx, stub global `fetch` rather than relying on
// mockClient.ts's seeded in-memory data.

const documentId = 'doc-1'
const filename = 'architecture-guide.pdf'

const PROCESSING_MESSAGE = 'This document is still processing - please wait for it to finish before editing.'

const chunks: Chunk[] = [
  { id: 'chunk-1', documentId, originalContent: 'Intro paragraph.', editedContent: 'Intro paragraph.', isDirty: false },
  { id: 'chunk-2', documentId, originalContent: 'Second paragraph.', editedContent: 'Second paragraph.', isDirty: false },
]

function documentWithStatus(status: DocumentSummary['status']): DocumentSummary[] {
  return [{ id: documentId, filename, status, uploadedAt: '2026-07-20T09:15:00.000Z' }]
}

// ChunkPreviewPage reads :documentId via useParams, so, unlike the other page
// tests, it needs an actual Route match (renderWithProviders only wraps in a
// bare MemoryRouter with no Routes/Route) rather than the shared test-utils helper.
function renderChunkPreviewPage(): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[`/upload/${documentId}/chunks`]}>
        <Routes>
          <Route path="/upload/:documentId/chunks" element={<ChunkPreviewPage />} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  )
}

describe('ChunkPreviewPage', () => {
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

  function emptyResponse(status = 202): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new Error('no body')
      },
    } as unknown as Response
  }

  function stubFetch(options: { status: DocumentSummary['status']; saveResult?: 'success' | 'conflict' }): void {
    const { status, saveResult = 'success' } = options
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.endsWith('/internal/documents')) {
        return Promise.resolve(jsonResponse(documentWithStatus(status)))
      }
      if (method === 'GET' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
        return Promise.resolve(jsonResponse(chunks))
      }
      if (method === 'POST' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
        if (saveResult === 'conflict') {
          return Promise.resolve(jsonResponse({ detail: 'document_processing' }, 409))
        }
        return Promise.resolve(emptyResponse(202))
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })
  }

  it('disables Save and shows the "still processing" message while the document is chunking', async () => {
    stubFetch({ status: 'chunking' })

    renderChunkPreviewPage()

    expect(await screen.findByText(PROCESSING_MESSAGE)).toBeInTheDocument()
    const saveButton = screen.getByRole('button', { name: 'Save' })
    expect(saveButton).toBeDisabled()
  })

  it('disables Save and shows the message while the document is uploaded (not yet chunked)', async () => {
    stubFetch({ status: 'uploaded' })

    renderChunkPreviewPage()

    expect(await screen.findByText(PROCESSING_MESSAGE)).toBeInTheDocument()
    const saveButton = screen.getByRole('button', { name: 'Save' })
    expect(saveButton).toBeDisabled()
  })

  it('enables Save and hides the message once the document is ready', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    // "Intro paragraph." renders twice (the main text column plus the
    // minimap's miniature copy) - assert at least one is present rather than
    // pinning to a single match.
    expect((await screen.findAllByText('Intro paragraph.')).length).toBeGreaterThan(0)
    const saveButton = screen.getByRole('button', { name: 'Save' })
    expect(saveButton).toBeEnabled()
    expect(screen.queryByText(PROCESSING_MESSAGE)).not.toBeInTheDocument()
  })

  it('shows the processing message without navigating away when Save races a status flip to busy', async () => {
    stubFetch({ status: 'ready', saveResult: 'conflict' })

    renderChunkPreviewPage()

    const saveButton = await screen.findByRole('button', { name: 'Save' })
    expect(saveButton).toBeEnabled()
    expect(screen.queryByText(PROCESSING_MESSAGE)).not.toBeInTheDocument()

    fireEvent.click(saveButton)

    // Rejection is handled (no unhandled rejection failing the test) and the
    // page stays put - still showing the chunk preview, not navigated to /upload.
    expect(await screen.findByText(PROCESSING_MESSAGE)).toBeInTheDocument()
    expect(screen.getByText(filename)).toBeInTheDocument()
    expect(screen.getAllByText('Intro paragraph.').length).toBeGreaterThan(0)
  })
})
