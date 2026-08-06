import type { AnalysisReportDetail, AnalysisReportSummary, DislikedMessage, NoAnswerMessage } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act } from 'react'

import { fireEvent, waitFor } from '@testing-library/react'

import { ImprovementsPage } from './ImprovementsPage'
import { POLL_INTERVAL_MS } from './UploadPage'
import { renderWithProviders, screen } from '../test-utils'
import { formatDateTime } from '../utils/formatDateTime'

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

// Newest first, per GET /internal/analysis/reports' own contract - distinct
// calendar days (not just distinct times) so formatDateTime's own DD.MM.YYYY
// output never accidentally collides between the two seeded rows.
const analysisReports: AnalysisReportSummary[] = [
  {
    id: 'analysis-1',
    status: 'completed',
    startedAt: '2026-08-05T09:00:00.000Z',
    completedAt: '2026-08-05T09:02:00.000Z',
    startedByEmail: 'admin@documind.dev',
  },
  {
    id: 'analysis-2',
    status: 'completed',
    startedAt: '2026-08-04T09:00:00.000Z',
    completedAt: '2026-08-04T09:02:00.000Z',
    startedByEmail: 'admin@documind.dev',
  },
]

const analysisReportDetails: Record<string, AnalysisReportDetail> = {
  'analysis-1': {
    ...analysisReports[0],
    gapAnalysis: 'Consider documenting the refund policy in more detail.',
    conflicts: [
      {
        documentAId: 'doc-1',
        documentAFilename: 'architecture-guide.pdf',
        chunkAId: 'chunk-1',
        chunkAContent: 'DocuMind is composed of four cooperating services.',
        documentBId: 'doc-2',
        documentBFilename: 'onboarding-notes.docx',
        chunkBId: 'chunk-2',
        chunkBContent: 'DocuMind runs as three services, with no separate database service.',
        description: 'These two passages disagree on how many services DocuMind is composed of.',
      },
    ],
    totalTokens: 512,
    errorDetail: null,
  },
  'analysis-2': {
    ...analysisReports[1],
    gapAnalysis: 'No recurring gaps found.',
    conflicts: [],
    totalTokens: 200,
    errorDetail: null,
  },
}

/**
 * Builds a fetch mock implementation covering both the Lists sub-tab's
 * endpoints (dislikes/no-answer, same seeded fixtures as this file's own
 * beforeEach) and the Analysis sub-tab's three endpoints, backed by
 * `options.reports`/`options.details` - mutate those objects in place from a
 * test (e.g. inside `onStart`) to change what a later call returns, same
 * "closures over mutable fixture state" idiom mockClient.ts itself uses.
 */
function analysisFetchImplementation(options: {
  reports: AnalysisReportSummary[]
  details: Record<string, AnalysisReportDetail>
  onStart?: () => AnalysisReportSummary
}) {
  return (url: string, init?: RequestInit) => {
    if (url.includes('/internal/chat/dislikes')) {
      return Promise.resolve(jsonResponse(dislikedMessages))
    }
    if (url.includes('/internal/chat/no-answer-messages')) {
      return Promise.resolve(jsonResponse(noAnswerMessages))
    }
    if (url.includes('/internal/analysis/reports/') && init?.method === 'DELETE') {
      // Mutates options.reports in place (same "closures over mutable
      // fixture state" idiom as onStart above) so a later GET reflects the
      // deletion too, even though the component itself removes the row
      // optimistically without waiting on a refetch.
      const id = url.split('/internal/analysis/reports/')[1]
      const index = options.reports.findIndex((report) => report.id === id)
      if (index !== -1) {
        options.reports.splice(index, 1)
      }
      return Promise.resolve(jsonResponse(null, 204))
    }
    if (url.includes('/internal/analysis/reports/')) {
      const id = url.split('/internal/analysis/reports/')[1]
      return Promise.resolve(jsonResponse(options.details[id]))
    }
    if (url.endsWith('/internal/analysis/reports')) {
      if (init?.method === 'POST' && options.onStart) {
        return Promise.resolve(jsonResponse(options.onStart(), 201))
      }
      return Promise.resolve(jsonResponse(options.reports))
    }
    return Promise.resolve(jsonResponse([]))
  }
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

  describe('Analysis sub-tab', () => {
    it("switching to the Analysis sub-tab fetches and shows the report history list and the most recent report's content", async () => {
      fetchMock.mockImplementation(analysisFetchImplementation({ reports: analysisReports, details: { ...analysisReportDetails } }))

      renderWithProviders(<ImprovementsPage />)
      await screen.findByText('How do I reset my password?')

      fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'http://localhost:8000/internal/analysis/reports',
          expect.objectContaining({ method: 'GET' }),
        )
      })

      expect(await screen.findByText(formatDateTime(analysisReports[0].startedAt))).toBeInTheDocument()
      expect(screen.getByText(formatDateTime(analysisReports[1].startedAt))).toBeInTheDocument()
      expect(await screen.findByText('Consider documenting the refund policy in more detail.')).toBeInTheDocument()
    })

    it('clicking "Analyze with AI" starts a run, shows an in-progress state, and disables the button', async () => {
      const details: Record<string, AnalysisReportDetail> = { ...analysisReportDetails }
      fetchMock.mockImplementation(
        analysisFetchImplementation({
          reports: analysisReports,
          details,
          onStart: () => {
            const summary: AnalysisReportSummary = {
              id: 'analysis-new',
              status: 'running',
              startedAt: '2026-08-06T00:00:00.000Z',
              completedAt: null,
              startedByEmail: 'admin@documind.dev',
            }
            details[summary.id] = { ...summary, gapAnalysis: null, conflicts: null, totalTokens: null, errorDetail: null }
            return summary
          },
        }),
      )

      renderWithProviders(<ImprovementsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
      await screen.findByText('Consider documenting the refund policy in more detail.')

      const analyzeButton = screen.getByRole('button', { name: /analyze with ai/i })
      fireEvent.click(analyzeButton)

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'http://localhost:8000/internal/analysis/reports',
          expect.objectContaining({ method: 'POST' }),
        )
      })

      expect(await screen.findByText(/analysis in progress/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /analyze with ai/i })).toBeDisabled()
    })

    it("selecting a different report from the history sidebar fetches and shows that report's own detail", async () => {
      fetchMock.mockImplementation(analysisFetchImplementation({ reports: analysisReports, details: { ...analysisReportDetails } }))

      renderWithProviders(<ImprovementsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
      await screen.findByText('Consider documenting the refund policy in more detail.')

      fireEvent.click(screen.getByText(formatDateTime(analysisReports[1].startedAt)))

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'http://localhost:8000/internal/analysis/reports/analysis-2',
          expect.objectContaining({ method: 'GET' }),
        )
      })
      expect(await screen.findByText('No recurring gaps found.')).toBeInTheDocument()
      expect(screen.queryByText('Consider documenting the refund policy in more detail.')).not.toBeInTheDocument()
    })

    it('polls for updates while the most recent report is running, and stops once it settles', async () => {
      vi.useFakeTimers()
      try {
        const runningReport: AnalysisReportSummary = {
          id: 'analysis-running',
          status: 'running',
          startedAt: '2026-08-06T00:00:00.000Z',
          completedAt: null,
          startedByEmail: 'admin@documind.dev',
        }
        const completedReport: AnalysisReportSummary = { ...runningReport, status: 'completed', completedAt: '2026-08-06T00:05:00.000Z' }
        const runningDetail: AnalysisReportDetail = { ...runningReport, gapAnalysis: null, conflicts: null, totalTokens: null, errorDetail: null }
        const completedDetail: AnalysisReportDetail = { ...completedReport, gapAnalysis: 'All caught up.', conflicts: [], totalTokens: 100, errorDetail: null }

        let listCallCount = 0
        fetchMock.mockImplementation((url: string) => {
          if (url.includes('/internal/chat/dislikes')) {
            return Promise.resolve(jsonResponse(dislikedMessages))
          }
          if (url.includes('/internal/chat/no-answer-messages')) {
            return Promise.resolve(jsonResponse(noAnswerMessages))
          }
          if (url.endsWith(`/internal/analysis/reports/${runningReport.id}`)) {
            return Promise.resolve(jsonResponse(listCallCount === 1 ? runningDetail : completedDetail))
          }
          if (url.endsWith('/internal/analysis/reports')) {
            listCallCount += 1
            return Promise.resolve(jsonResponse(listCallCount === 1 ? [runningReport] : [completedReport]))
          }
          return Promise.resolve(jsonResponse([]))
        })

        renderWithProviders(<ImprovementsPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))

        // Flush the mount effect's fetch + resulting state updates before
        // asserting anything about the poll interval it schedules.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0)
        })
        expect(listCallCount).toBe(1)

        // Advancing by the poll interval should trigger exactly one more
        // GET of the report list (the run is still 'running' at this point).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        })
        expect(listCallCount).toBe(2)

        // The run is now 'completed' (settled) - polling should have
        // stopped, so advancing well past another interval triggers no
        // further calls.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
        })
        expect(listCallCount).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("renders a selected report's conflicts with links to each side's chunk-preview page", async () => {
      fetchMock.mockImplementation(analysisFetchImplementation({ reports: analysisReports, details: { ...analysisReportDetails } }))

      renderWithProviders(<ImprovementsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
      await screen.findByText('Consider documenting the refund policy in more detail.')

      const linkA = await screen.findByRole('link', { name: /architecture-guide\.pdf/i })
      expect(linkA).toHaveAttribute('href', '/upload/doc-1/chunks')

      const linkB = screen.getByRole('link', { name: /onboarding-notes\.docx/i })
      expect(linkB).toHaveAttribute('href', '/upload/doc-2/chunks')
    })

    describe('deleting a report from the history sidebar', () => {
      it("clicking a history card's delete icon opens a confirm modal without deleting anything or changing the selection", async () => {
        fetchMock.mockImplementation(analysisFetchImplementation({ reports: [...analysisReports], details: { ...analysisReportDetails } }))

        renderWithProviders(<ImprovementsPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
        await screen.findByText('Consider documenting the refund policy in more detail.')

        fireEvent.click(screen.getByRole('button', { name: `Delete report from ${formatDateTime(analysisReports[1].startedAt)}` }))

        expect(await screen.findByText(/are you sure you want to delete this analysis report/i)).toBeInTheDocument()

        // No DELETE call happened yet.
        expect(fetchMock.mock.calls.some((args: unknown[]) => (args[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
        // Selection is untouched - report 1's content is still showing.
        expect(screen.getByText('Consider documenting the refund policy in more detail.')).toBeInTheDocument()
        // Report 2 is still in the history list.
        expect(screen.getByText(formatDateTime(analysisReports[1].startedAt))).toBeInTheDocument()
      })

      it('clicking Cancel in the confirm modal leaves the report in the history list', async () => {
        fetchMock.mockImplementation(analysisFetchImplementation({ reports: [...analysisReports], details: { ...analysisReportDetails } }))

        renderWithProviders(<ImprovementsPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
        await screen.findByText('Consider documenting the refund policy in more detail.')

        fireEvent.click(screen.getByRole('button', { name: `Delete report from ${formatDateTime(analysisReports[1].startedAt)}` }))
        await screen.findByText(/are you sure you want to delete this analysis report/i)

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        await waitFor(() => {
          expect(screen.queryByText(/are you sure you want to delete this analysis report/i)).not.toBeInTheDocument()
        })
        expect(fetchMock.mock.calls.some((args: unknown[]) => (args[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
        expect(screen.getByText(formatDateTime(analysisReports[1].startedAt))).toBeInTheDocument()
      })

      it('confirming the modal calls DELETE on the right report and removes it from the history list', async () => {
        const reports = [...analysisReports]
        fetchMock.mockImplementation(analysisFetchImplementation({ reports, details: { ...analysisReportDetails } }))

        renderWithProviders(<ImprovementsPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
        await screen.findByText('Consider documenting the refund policy in more detail.')

        fireEvent.click(screen.getByRole('button', { name: `Delete report from ${formatDateTime(analysisReports[1].startedAt)}` }))
        await screen.findByText(/are you sure you want to delete this analysis report/i)

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

        await waitFor(() => {
          expect(screen.queryByText(formatDateTime(analysisReports[1].startedAt))).not.toBeInTheDocument()
        })

        const deleteCall = fetchMock.mock.calls.find((args: unknown[]) => (args[1] as RequestInit | undefined)?.method === 'DELETE')
        expect(deleteCall).toBeDefined()
        const [url] = deleteCall as [string, RequestInit]
        expect(url).toBe(`http://localhost:8000/internal/analysis/reports/${analysisReports[1].id}`)

        // Report 1 (untouched) is still in the list and still selected.
        expect(screen.getByText(formatDateTime(analysisReports[0].startedAt))).toBeInTheDocument()
        expect(screen.getByText('Consider documenting the refund policy in more detail.')).toBeInTheDocument()
      })

      it('deleting the currently selected report clears the stale content instead of leaving it visible', async () => {
        const reports = [...analysisReports]
        fetchMock.mockImplementation(analysisFetchImplementation({ reports, details: { ...analysisReportDetails } }))

        renderWithProviders(<ImprovementsPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
        // Report 1 (newest) is selected by default.
        await screen.findByText('Consider documenting the refund policy in more detail.')

        fireEvent.click(screen.getByRole('button', { name: `Delete report from ${formatDateTime(analysisReports[0].startedAt)}` }))
        await screen.findByText(/are you sure you want to delete this analysis report/i)
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

        await waitFor(() => {
          expect(screen.queryByText('Consider documenting the refund policy in more detail.')).not.toBeInTheDocument()
        })
        // Its own history card is gone too.
        expect(screen.queryByText(formatDateTime(analysisReports[0].startedAt))).not.toBeInTheDocument()
      })
    })
  })
})
