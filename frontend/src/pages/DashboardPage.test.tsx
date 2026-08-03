import type { DashboardEvent, DashboardStats, DashboardStatsRange, DocumentSummary } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor, within } from '@testing-library/react'

import { DashboardPage } from './DashboardPage'
import { renderWithProviders, screen } from '../test-utils'

// The Stats tab renders ChunkGraphPanel, which mounts a real 3d-force-graph
// (WebGL/Three.js) instance - jsdom has no WebGL, so the module is mocked
// the same way ChunkGraphPanel.test.tsx does. This file doesn't assert on
// the graph itself (that's ChunkGraphPanel's own test file's job), it just
// needs DashboardPage to mount without crashing.
vi.mock('3d-force-graph', () => ({
  default: vi.fn().mockImplementation(function ForceGraph3DMock() {
    const stub: Record<string, ReturnType<typeof vi.fn>> = {
      _destructor: vi.fn(),
      // Not chainable (unlike the methods below) - real 3d-force-graph
      // returns the underlying OrbitControls instance, not the graph - this
      // stub covers the members ChunkGraphPanel actually touches
      // (mouseButtons/panSpeed, plus target.set/update for the centroid
      // re-pivot).
      controls: vi.fn(() => ({ mouseButtons: {}, target: { set: vi.fn() }, update: vi.fn() })),
      // Also not chainable - real 3d-force-graph returns the actual
      // THREE.PerspectiveCamera (camera()) and a plain {x,y,z}
      // (cameraPosition(), called here with no args as a getter) rather
      // than the graph itself. A fixed fov/position is enough for the
      // zoom-to-fit math to run without throwing.
      camera: vi.fn(() => ({ fov: 50 })),
      cameraPosition: vi.fn(() => ({ x: 0, y: 0, z: 100 })),
    }
    for (const method of ['backgroundColor', 'width', 'height', 'nodeLabel', 'nodeRelSize', 'nodeColor', 'linkOpacity', 'linkColor', 'linkWidth', 'showNavInfo', 'enableNodeDrag', 'onNodeClick', 'graphData']) {
      stub[method] = vi.fn(() => stub)
    }
    return stub
  }),
}))

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

// Timezone-safe conversion from an ISO instant to the local date/time parts
// DashboardPage.tsx's From/To fields expect typed into them (DateInput's
// "DD.MM.YYYY" valueFormat, TimePicker's plain "HH:mm") - local getters
// match how `new Date(...)` (used both here and in the component's own
// fromMs/toMs computation) reads an offset-less string, so this lines up
// with the fixture's UTC timestamps regardless of the test runner's
// timezone.
function toLocalDateTimeParts(iso: string): { date: string; time: string } {
  const value = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${pad(value.getDate())}.${pad(value.getMonth() + 1)}.${value.getFullYear()}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  }
}

const STATS_BUCKET_COUNTS: Record<DashboardStatsRange, number> = { day: 12, '7days': 7, month: 5, year: 12 }

function makeStatsFixture(range: DashboardStatsRange): DashboardStats {
  const bucketCount = STATS_BUCKET_COUNTS[range]
  return {
    totalUsers: 0,
    totalChunks: 42,
    totalDocuments: documents.length,
    totalDislikes: 7,
    messageBuckets: Array.from({ length: bucketCount }, (_, index) => ({
      bucketStart: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      count: index + 1,
    })),
    dislikeBuckets: Array.from({ length: bucketCount }, (_, index) => ({
      bucketStart: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      count: index,
    })),
  }
}

describe('DashboardPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/internal/dashboard/events')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => events } as Response)
      }
      if (url.includes('/internal/dashboard/stats')) {
        const range = new URL(url).searchParams.get('range') as DashboardStatsRange
        return Promise.resolve({ ok: true, status: 200, json: async () => makeStatsFixture(range) } as Response)
      }
      if (url.endsWith('/internal/dashboard/chunk-graph')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ nodes: [] }) } as Response)
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => documents } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists all seeded dashboard events with their type and detail', async () => {
    renderWithProviders(<DashboardPage />)

    // Stats is the default tab now, so switch to Logs first to reach the table.
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))

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

    expect(await within(table).findByText('document.chunking_started')).toBeInTheDocument()
    expect(await screen.findByText('release-plan.md chunking started.')).toBeInTheDocument()
  })

  it('excludes non-document events (e.g. chat.message_sent) from the Logs view', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))

    await screen.findByText('document.uploaded')
    expect(screen.queryByText('chat.message')).not.toBeInTheDocument()
    expect(screen.queryByText('A user asked how to upload a new document.')).not.toBeInTheDocument()
  })

  it('shows Logs and Stats toggle buttons, with Stats active by default', async () => {
    renderWithProviders(<DashboardPage />)

    const logsButton = await screen.findByRole('button', { name: 'Logs' })
    const statsButton = screen.getByRole('button', { name: 'Stats' })

    expect(statsButton).toHaveAttribute('aria-pressed', 'true')
    expect(logsButton).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('switching to the Logs tab shows the events table and hides stats, and back again', async () => {
    renderWithProviders(<DashboardPage />)
    await screen.findByText('Documents')

    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))

    expect(screen.queryByText('Documents')).not.toBeInTheDocument()
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Stats' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Stats' }))

    expect(await screen.findByText('Documents')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('remembers the previously selected tab across remounts', async () => {
    const { unmount } = renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByRole('table')
    unmount()

    renderWithProviders(<DashboardPage />)

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('paginates the events table at 20 rows a page instead of rendering every event at once', async () => {
    const manyEvents: DashboardEvent[] = Array.from({ length: 25 }, (_, index) => ({
      id: `event-${index + 1}`,
      type: `document.type_${index + 1}`,
      timestamp: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      detail: `Detail ${index + 1}`,
    }))
    fetchMock.mockImplementation((url: string) => {
      const body = url.endsWith('/internal/dashboard/chunk-graph')
        ? { nodes: [] }
        : url.endsWith('/internal/dashboard/events')
          ? manyEvents
          : documents
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
    })

    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))

    // Default (unsorted) is this fixture's own insertion order (Detail 1,
    // 2, 3, ...), so pagination boundaries can be asserted directly.
    await screen.findByText('Detail 1')
    expect(screen.getByText('Detail 20')).toBeInTheDocument()
    expect(screen.queryByText('Detail 21')).not.toBeInTheDocument()
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Detail 21')).toBeInTheDocument()
    expect(screen.getByText('Detail 25')).toBeInTheDocument()
    expect(screen.queryByText('Detail 1')).not.toBeInTheDocument()
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))

    expect(await screen.findByText('Detail 1')).toBeInTheDocument()
    expect(screen.queryByText('Detail 21')).not.toBeInTheDocument()
  })

  it('hides pagination controls when everything fits on one page', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))

    await screen.findByRole('table')
    expect(screen.queryByText(/page \d+ of \d+/i)).not.toBeInTheDocument()
  })

  it('renders the full, untruncated detail text for a long event detail', async () => {
    const longDetail =
      'document_id=d11f8625-fff1-43de-a2d9-01f50d305490: docs/tasks-test-8e4f5a58-3447-4eb2-b982-9bb94475f018.txt'
    const longEvents: DashboardEvent[] = [
      { id: 'event-1', type: 'document.chunking_failed', timestamp: '2026-01-01T00:00:00.000Z', detail: longDetail },
    ]
    fetchMock.mockImplementation((url: string) => {
      const body = url.endsWith('/internal/dashboard/chunk-graph')
        ? { nodes: [] }
        : url.endsWith('/internal/dashboard/events')
          ? longEvents
          : documents
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
    })

    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))

    expect(await screen.findByText(longDetail)).toBeInTheDocument()
  })

  it('filters the Logs table by text match in Detail, only once Search is clicked', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('document.uploaded')

    fireEvent.change(screen.getByRole('textbox', { name: /search in details/i }), { target: { value: 'chunks' } })

    // Typing alone doesn't filter yet - it's a draft until Search is clicked.
    expect(screen.getByText('onboarding-notes.docx was uploaded.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('architecture-guide.pdf was split into 3 chunks.')).toBeInTheDocument()
    expect(screen.queryByText('onboarding-notes.docx was uploaded.')).not.toBeInTheDocument()
    expect(screen.queryByText('A user asked how to upload a new document.')).not.toBeInTheDocument()
    expect(screen.queryByText('release-plan.md chunking started.')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: /search in details/i }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('onboarding-notes.docx was uploaded.')).toBeInTheDocument()
  })

  it('pressing Enter in the search field also applies the filter', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('document.uploaded')

    const searchInput = screen.getByRole('textbox', { name: /search in details/i })
    fireEvent.change(searchInput, { target: { value: 'chunks' } })
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    expect(await screen.findByText('architecture-guide.pdf was split into 3 chunks.')).toBeInTheDocument()
    expect(screen.queryByText('onboarding-notes.docx was uploaded.')).not.toBeInTheDocument()
  })

  it('sorts by clicking the Timestamp header, cycling unsorted -> newest -> oldest -> unsorted', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    const table = await screen.findByRole('table')

    // Type is the 3rd column (ID, Timestamp, Type, Detail) - read by
    // position rather than by text match, since some fixture Detail
    // sentences ("...a new document.") happen to contain other rows' Type
    // values ("document.*") as substrings.
    const firstRowTypeCell = () => within(within(table).getAllByRole('row')[1]).getAllByRole('cell')[2]
    const timestampHeaderCell = within(table).getAllByRole('columnheader')[1]
    const timestampHeaderButton = screen.getByRole('button', { name: 'Timestamp' })

    // Unsorted (default): this fixture's own fetch/insertion order.
    expect(timestampHeaderCell).toHaveAttribute('aria-sort', 'none')
    expect(firstRowTypeCell()).toHaveTextContent('document.uploaded')

    fireEvent.click(timestampHeaderButton)
    expect(timestampHeaderCell).toHaveAttribute('aria-sort', 'descending')
    expect(firstRowTypeCell()).toHaveTextContent('document.chunking_started')

    fireEvent.click(timestampHeaderButton)
    expect(timestampHeaderCell).toHaveAttribute('aria-sort', 'ascending')
    expect(firstRowTypeCell()).toHaveTextContent('document.uploaded')

    fireEvent.click(timestampHeaderButton)
    expect(timestampHeaderCell).toHaveAttribute('aria-sort', 'none')
  })

  it('filters the Logs table by a From/To date-time range', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('document.uploaded')

    const from = toLocalDateTimeParts(events[1].timestamp)
    const to = toLocalDateTimeParts(events[3].timestamp)

    const [fromHours, fromMinutes] = from.time.split(':')
    const [toHours, toMinutes] = to.time.split(':')

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: from.date } })
    fireEvent.blur(screen.getByLabelText('From date'))
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: to.date } })
    fireEvent.blur(screen.getByLabelText('To date'))
    // TimePicker is hours/minutes as two separate segment inputs, not one
    // combined "HH:mm" field - see hoursInputLabel/minutesInputLabel on
    // DashboardPage.tsx's TimePicker instances.
    fireEvent.change(screen.getByLabelText('From hours'), { target: { value: fromHours } })
    fireEvent.change(screen.getByLabelText('From minutes'), { target: { value: fromMinutes } })
    fireEvent.change(screen.getByLabelText('To hours'), { target: { value: toHours } })
    fireEvent.change(screen.getByLabelText('To minutes'), { target: { value: toMinutes } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('document.chunked')).toBeInTheDocument()
    expect(screen.getByText('document.chunking_started')).toBeInTheDocument()
    expect(screen.queryByText('document.uploaded')).not.toBeInTheDocument()
  })

  it('shows a "no matching entries" message instead of an empty table when the filters match nothing', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('document.uploaded')

    fireEvent.change(screen.getByRole('textbox', { name: /search in details/i }), {
      target: { value: 'no such detail text exists' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText(/no matching entries found/i)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('clears search, sort, and date-range filters via the Clear filters button', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('document.uploaded')

    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: /search in details/i }), { target: { value: 'chunks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await screen.findByText('architecture-guide.pdf was split into 3 chunks.')
    expect(screen.queryByText('onboarding-notes.docx was uploaded.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    expect(screen.getByRole('textbox', { name: /search in details/i })).toHaveValue('')
    expect(await screen.findByText('onboarding-notes.docx was uploaded.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('shows Users, Chunks, and Dislikes stat cards sourced from the stats endpoint', async () => {
    renderWithProviders(<DashboardPage />)

    expect(await screen.findByText('Chunks')).toBeInTheDocument()
    expect(screen.getByText('Users')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    // "Dislikes" also labels the bar chart title below - the stat card is
    // one of two matches, not the only one.
    expect(screen.getAllByText('Dislikes')).toHaveLength(2)
  })

  it('shows Messages sent and Dislikes bar charts with a Day/7 Days/Month/Year range toggle', async () => {
    renderWithProviders(<DashboardPage />)

    expect(await screen.findByText('Messages sent')).toBeInTheDocument()
    expect(screen.getAllByText('Dislikes')).toHaveLength(2)
    for (const label of ['Day', 'Week', 'Month', 'Year']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true')

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/internal/dashboard/stats?range=day'), expect.anything())
    })
  })

  it('refetches Messages/Dislikes buckets for the selected range when the toggle changes', async () => {
    renderWithProviders(<DashboardPage />)
    await screen.findByText('Messages sent')

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/internal/dashboard/stats?range=7days'), expect.anything())
    })
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'false')
  })
})
