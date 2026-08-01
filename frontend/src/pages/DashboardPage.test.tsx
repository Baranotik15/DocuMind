import type { DashboardEvent, DocumentSummary } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { within } from '@testing-library/react'

import { DashboardPage } from './DashboardPage'
import { renderWithProviders, screen } from '../test-utils'

// DashboardPage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - so, same as httpClient.test.ts, stub global
// `fetch` rather than relying on mockClient.ts's seeded in-memory data.

const documents: DocumentSummary[] = [
  { id: 'doc-1', filename: 'onboarding-notes.docx', status: 'ready', uploadedAt: '2026-01-01T00:00:00.000Z' },
]

const events: DashboardEvent[] = [
  {
    id: 'event-1',
    type: 'document.uploaded',
    timestamp: '2026-01-01T00:00:00.000Z',
    detail: 'onboarding-notes.docx was uploaded.',
  },
  {
    id: 'event-2',
    type: 'document.chunked',
    timestamp: '2026-01-01T00:01:00.000Z',
    detail: 'architecture-guide.pdf was split into 3 chunks.',
  },
  {
    id: 'event-3',
    type: 'chat.message',
    timestamp: '2026-01-01T00:02:00.000Z',
    detail: 'A user asked how to upload a new document.',
  },
  {
    id: 'event-4',
    type: 'document.chunking_started',
    timestamp: '2026-01-01T00:03:00.000Z',
    detail: 'release-plan.md chunking started.',
  },
]

describe('DashboardPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      const body = url.endsWith('/internal/dashboard/events') ? events : documents
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists all seeded dashboard events with their type and detail', async () => {
    renderWithProviders(<DashboardPage />)

    // The new "events by type" bar visualization also renders each event
    // `type` string as a bar label, so `type` values now appear twice on the
    // page (once as a bar label, once as a table cell) - queries are scoped
    // to the detail table (the same element/assertion as before, just
    // disambiguated) rather than the whole document. `detail` sentences
    // remain unique to the table, so those queries are unchanged.
    const table = await screen.findByRole('table')

    expect(await within(table).findByText('document.uploaded')).toBeInTheDocument()
    expect(await screen.findByText('onboarding-notes.docx was uploaded.')).toBeInTheDocument()

    expect(await within(table).findByText('document.chunked')).toBeInTheDocument()
    expect(await screen.findByText('architecture-guide.pdf was split into 3 chunks.')).toBeInTheDocument()

    expect(await within(table).findByText('chat.message')).toBeInTheDocument()
    expect(await screen.findByText('A user asked how to upload a new document.')).toBeInTheDocument()

    expect(await within(table).findByText('document.chunking_started')).toBeInTheDocument()
    expect(await screen.findByText('release-plan.md chunking started.')).toBeInTheDocument()
  })
})
