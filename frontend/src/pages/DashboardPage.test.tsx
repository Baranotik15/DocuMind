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
    for (const method of ['backgroundColor', 'width', 'height', 'nodeLabel', 'nodeThreeObject', 'linkMaterial', 'linkWidth', 'showNavInfo', 'enableNodeDrag', 'onNodeClick', 'graphData']) {
      stub[method] = vi.fn(() => stub)
    }
    return stub
  }),
}))

// DashboardPage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - so, same as httpClient.test.ts, stub global
// `fetch` rather than relying on mockClient.ts's seeded in-memory data.

const documents: DocumentSummary[] = [
  { id: 'doc-1', filename: 'onboarding-notes.docx', status: 'ready', uploadedAt: '2026-01-01T00:00:00.000Z', fileSizeBytes: 51_200 },
]

const events: DashboardEvent[] = [
  {
    id: 'event-1',
    type: 'document.uploaded',
    timestamp: '2026-01-01T00:00:00.000Z',
    detail: 'onboarding-notes.docx was uploaded.',
    userEmail: 'admin@documind.dev',
  },
  {
    id: 'event-2',
    type: 'document.chunked',
    timestamp: '2026-01-01T00:01:00.000Z',
    detail: 'architecture-guide.pdf was split into 3 chunks.',
    userEmail: 'admin@documind.dev',
  },
  {
    id: 'event-3',
    type: 'chat.message',
    timestamp: '2026-01-01T00:02:00.000Z',
    detail: 'A user asked how to upload a new document.',
    userEmail: null,
  },
  {
    id: 'event-4',
    type: 'document.chunking_started',
    timestamp: '2026-01-01T00:03:00.000Z',
    detail: 'release-plan.md chunking started.',
    userEmail: null,
  },
  {
    id: 'event-5',
    type: 'analysis.run_completed',
    timestamp: '2026-01-01T00:04:00.000Z',
    detail: 'Documentation analysis completed - 842 tokens used.',
    userEmail: 'admin@documind.dev',
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

const STATS_BUCKET_COUNTS: Record<DashboardStatsRange, number> = { day: 24, '7days': 7, month: 5, year: 12 }

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
      if (url.endsWith('/internal/dashboard/openai-spend')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            day: 0,
            week: 0,
            month: 0,
            year: 0,
            tokens: {
              day: { input: 0, output: 0 },
              week: { input: 0, output: 0 },
              month: { input: 0, output: 0 },
              year: { input: 0, output: 0 },
            },
            currency: 'usd',
            configured: false,
          }),
        } as Response)
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

    // Stats is the default tab now, so switch to Logs first to reach the
    // card list.
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByTestId('logs-event-list')

    expect(await screen.findByText('Upload Document')).toBeInTheDocument()
    expect(await screen.findByText('onboarding-notes.docx was uploaded.')).toBeInTheDocument()

    // 'document.chunked' isn't a real backend event type (this fixture's
    // own placeholder) - not in EVENT_TYPE_LABELS, so formatEventType falls
    // back to rendering it verbatim.
    expect(await screen.findByText('document.chunked')).toBeInTheDocument()
    expect(await screen.findByText('architecture-guide.pdf was split into 3 chunks.')).toBeInTheDocument()

    expect(await screen.findByText('Rechunk Document — Started')).toBeInTheDocument()
    expect(await screen.findByText('release-plan.md chunking started.')).toBeInTheDocument()

    // 'analysis.*' events (from the Documentation Analysis feature) also
    // belong on the Logs tab, alongside 'document.*' - not just the latter.
    expect(await screen.findByText('Documentation Analysis — Completed')).toBeInTheDocument()
    expect(await screen.findByText('Documentation analysis completed - 842 tokens used.')).toBeInTheDocument()
  })

  it('excludes non-document events (e.g. chat.message_sent) from the Logs view', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))

    await screen.findByText('Upload Document')
    expect(screen.queryByText('chat.message')).not.toBeInTheDocument()
    expect(screen.queryByText('A user asked how to upload a new document.')).not.toBeInTheDocument()
  })

  it('shows Logs and Stats toggle buttons, with Stats active by default', async () => {
    renderWithProviders(<DashboardPage />)

    const logsButton = await screen.findByRole('button', { name: 'Logs' })
    const statsButton = screen.getByRole('button', { name: 'Stats' })

    expect(statsButton).toHaveAttribute('aria-pressed', 'true')
    expect(logsButton).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByText('Total Documents')).toBeInTheDocument()
    expect(screen.queryByTestId('logs-event-list')).not.toBeInTheDocument()
  })

  it('switching to the Logs tab shows the events list and hides stats, and back again', async () => {
    renderWithProviders(<DashboardPage />)
    await screen.findByText('Total Documents')

    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))

    expect(screen.queryByText('Total Documents')).not.toBeInTheDocument()
    expect(await screen.findByTestId('logs-event-list')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Stats' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Stats' }))

    expect(await screen.findByText('Total Documents')).toBeInTheDocument()
    expect(screen.queryByTestId('logs-event-list')).not.toBeInTheDocument()
  })

  it('remembers the previously selected tab across remounts', async () => {
    const { unmount } = renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByTestId('logs-event-list')
    unmount()

    renderWithProviders(<DashboardPage />)

    expect(await screen.findByTestId('logs-event-list')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('paginates the events table at 20 rows a page instead of rendering every event at once', async () => {
    const manyEvents: DashboardEvent[] = Array.from({ length: 25 }, (_, index) => ({
      id: `event-${index + 1}`,
      type: `document.type_${index + 1}`,
      timestamp: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      detail: `Detail ${index + 1}`,
      userEmail: null,
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

    await screen.findByTestId('logs-event-list')
    expect(screen.queryByText(/page \d+ of \d+/i)).not.toBeInTheDocument()
  })

  it('renders the full, untruncated detail text for a long event detail', async () => {
    const longDetail =
      'document_id=d11f8625-fff1-43de-a2d9-01f50d305490: docs/tasks-test-8e4f5a58-3447-4eb2-b982-9bb94475f018.txt'
    const longEvents: DashboardEvent[] = [
      { id: 'event-1', type: 'document.chunking_failed', timestamp: '2026-01-01T00:00:00.000Z', detail: longDetail, userEmail: null },
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

  it('renders a raw SQL/exception detail line as plain text, not a mis-parsed key/value chip', async () => {
    // Regression test for a live bug: a FAILED analysis event's own detail
    // is the raw SQLAlchemy/asyncpg exception text, which routinely
    // contains " = " itself (SQL JOIN/WHERE equality) - naively splitting
    // on the first " = " in the line treated the entire multi-hundred-
    // character SQL dump as one giant chip "key", rendering as a hugely
    // distorted pill instead of small tags/plain text.
    const sqlDetail =
      '[SQL: SELECT c1.id FROM chunks AS c1 JOIN documents AS d1 ON d1.id = c1.document_id WHERE d1.status = $1]'
    const sqlEvents: DashboardEvent[] = [
      { id: 'event-1', type: 'analysis.run_failed', timestamp: '2026-01-01T00:00:00.000Z', detail: sqlDetail, userEmail: null },
    ]
    fetchMock.mockImplementation((url: string) => {
      const body = url.endsWith('/internal/dashboard/chunk-graph')
        ? { nodes: [] }
        : url.endsWith('/internal/dashboard/events')
          ? sqlEvents
          : documents
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
    })

    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))

    // Renders as one plain text node, not split into a "key" (everything up
    // to the first " = ") and a separate "value" chip.
    expect(await screen.findByText(sqlDetail)).toBeInTheDocument()
  })

  it('filters the Logs table by text match in Detail, only once Search is clicked', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('Upload Document')

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
    await screen.findByText('Upload Document')

    const searchInput = screen.getByRole('textbox', { name: /search in details/i })
    fireEvent.change(searchInput, { target: { value: 'chunks' } })
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    expect(await screen.findByText('architecture-guide.pdf was split into 3 chunks.')).toBeInTheDocument()
    expect(screen.queryByText('onboarding-notes.docx was uploaded.')).not.toBeInTheDocument()
  })

  it('sorts via the Sort by time button, cycling unsorted -> newest -> oldest -> unsorted', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByTestId('logs-event-list')

    // The event's own Type text, read off the first card in the currently
    // rendered order - not a fixed DOM position (unlike the old table's own
    // row/cell indices), since each event is now its own card.
    const firstCardType = () => within(screen.getAllByTestId('log-event-card')[0]).getByText(/^(Upload Document|Documentation Analysis — Completed)$/)
    const sortButton = () => screen.getByRole('button', { name: /sort by time/i })

    // Unsorted (default): this fixture's own fetch/insertion order. The
    // accessible name (not just the arrow icon, which is aria-hidden) spells
    // out the current state, so it doubles as the assertion target here.
    expect(sortButton()).toHaveAccessibleName('Sort by time (currently unsorted)')
    expect(firstCardType()).toHaveTextContent('Upload Document')

    fireEvent.click(sortButton())
    expect(sortButton()).toHaveAccessibleName('Sort by time (currently newest first)')
    // event-5 (analysis.run_completed) is now the fixture's newest event.
    expect(firstCardType()).toHaveTextContent('Documentation Analysis — Completed')

    fireEvent.click(sortButton())
    expect(sortButton()).toHaveAccessibleName('Sort by time (currently oldest first)')
    expect(firstCardType()).toHaveTextContent('Upload Document')

    fireEvent.click(sortButton())
    expect(sortButton()).toHaveAccessibleName('Sort by time (currently unsorted)')
  })

  it('filters the Logs table by a From/To date-time range', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('Upload Document')

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
    expect(screen.getByText('Rechunk Document — Started')).toBeInTheDocument()
    expect(screen.queryByText('Upload Document')).not.toBeInTheDocument()
  })

  it('shows a "no matching entries" message instead of an empty list when the filters match nothing', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('Upload Document')

    fireEvent.change(screen.getByRole('textbox', { name: /search in details/i }), {
      target: { value: 'no such detail text exists' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText(/no matching entries found/i)).toBeInTheDocument()
    expect(screen.queryByTestId('logs-event-list')).not.toBeInTheDocument()
  })

  it('clears search, sort, and date-range filters via the Clear filters button', async () => {
    renderWithProviders(<DashboardPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByText('Upload Document')

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

    expect(await screen.findByText('Total Chunks')).toBeInTheDocument()
    expect(screen.getByText('Total Users')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    // Unlike the stat card's own "Total Dislikes" label, the bar chart
    // title below is still the bare "Dislikes" - only one match now.
    expect(screen.getByText('Total Dislikes')).toBeInTheDocument()
  })

  it('shows an explicit "not configured" message in both OpenAI spend blocks when the backend has no admin key set', async () => {
    // beforeEach's own default openai-spend stub already returns
    // configured: false - this is that default case, not an override.
    renderWithProviders(<DashboardPage />)

    expect(await screen.findByText('Tokens Spend')).toBeInTheDocument()
    expect(screen.getByText('Money Spend')).toBeInTheDocument()
    // One "not configured" message per block (Tokens + Spend), not a
    // single shared one.
    expect(screen.getAllByText('Admin key not configured')).toHaveLength(2)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('shows the selected period\'s tokens/spend, switching via the Tokens/Spend blocks\' own Day/Week/Month/Year toggle', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/internal/dashboard/openai-spend')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            day: 0.42,
            week: 3.1,
            month: 12.55,
            year: 87.2,
            tokens: {
              day: { input: 800, output: 400 },
              week: { input: 5600, output: 2800 },
              month: { input: 23000, output: 12000 },
              year: { input: 270000, output: 140000 },
            },
            currency: 'usd',
            configured: true,
          }),
        } as Response)
      }
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

    renderWithProviders(<DashboardPage />)

    // Defaults to the "Day" period. Tokens Spend now renders as two
    // separate Input/Output sub-values (see SpendBlock's `split` prop)
    // rather than one combined count.
    expect(await screen.findByText('800')).toBeInTheDocument()
    expect(screen.getByText('400')).toBeInTheDocument()
    expect(screen.getByText('$0.42')).toBeInTheDocument()
    expect(screen.queryByText('Admin key not configured')).not.toBeInTheDocument()

    // The spend toggle's "Month" button is distinct from the charts'
    // Day/Week/Month/Year toggle further down the page (two separate
    // SegmentedToggle instances, both currently on "Day"/its own default -
    // getAllByRole picks the first, which is this spend block's own one,
    // rendered first in the page).
    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])

    expect(await screen.findByText('23,000')).toBeInTheDocument()
    expect(screen.getByText('12,000')).toBeInTheDocument()
    expect(screen.getByText('$12.55')).toBeInTheDocument()
  })

  it('shows Messages sent and Dislikes bar charts with a Day/7 Days/Month/Year range toggle', async () => {
    renderWithProviders(<DashboardPage />)

    expect(await screen.findByText('Messages sent')).toBeInTheDocument()
    expect(screen.getByText('Dislikes')).toBeInTheDocument()
    // Day/Week/Month/Year now also labels the OpenAI spend blocks' own,
    // separate toggle (added in this same session) - every label below is
    // a two-match ambiguity, not a typo.
    for (const label of ['Day', 'Week', 'Month', 'Year']) {
      expect(screen.getAllByRole('button', { name: label })).toHaveLength(2)
    }
    // getAllByRole(...)[1] is this chart toggle specifically - the spend
    // blocks' own toggle (see the "OpenAI Spend" block tests above) is
    // rendered first in the page/DOM, so index 0 belongs to it, not this
    // one.
    expect(screen.getAllByRole('button', { name: 'Day' })[1]).toHaveAttribute('aria-pressed', 'true')

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/internal/dashboard/stats?range=day'), expect.anything())
    })
  })

  it('refetches Messages/Dislikes buckets for the selected range when the toggle changes', async () => {
    renderWithProviders(<DashboardPage />)
    await screen.findByText('Messages sent')

    // [1] - this chart toggle specifically, not the OpenAI spend blocks'
    // own separate Day/Week/Month/Year toggle (index 0 - see this file's
    // other Day/Week/Month/Year tests for the same disambiguation).
    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[1])

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/internal/dashboard/stats?range=7days'), expect.anything())
    })
    expect(screen.getAllByRole('button', { name: 'Week' })[1]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button', { name: 'Day' })[1]).toHaveAttribute('aria-pressed', 'false')
  })
})
