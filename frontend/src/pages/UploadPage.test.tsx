import type { DocumentSummary } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act } from 'react'

import { fireEvent, waitFor, within } from '@testing-library/react'

import { POLL_INTERVAL_MS, UploadPage } from './UploadPage'
import { renderWithProviders, screen } from '../test-utils'

// UploadPage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - so, same as httpClient.test.ts and
// DashboardPage.test.tsx, stub global `fetch` rather than relying on
// mockClient.ts's seeded in-memory data.

const seededDocuments: DocumentSummary[] = [
  { id: 'doc-1', filename: 'architecture-guide.pdf', status: 'ready', uploadedAt: '2026-07-20T09:15:00.000Z' },
  { id: 'doc-2', filename: 'onboarding-notes.docx', status: 'uploaded', uploadedAt: '2026-07-28T14:02:00.000Z' },
  { id: 'doc-3', filename: 'release-plan.md', status: 'chunking', uploadedAt: '2026-07-30T11:47:00.000Z' },
]

// Deliberately not already sorted by any column, so clicking a header
// visibly changes row order (unlike `seededDocuments`, whose filenames
// happen to already be alphabetical).
const sortTestDocuments: DocumentSummary[] = [
  { id: 'doc-1', filename: 'zeta.pdf', status: 'ready', uploadedAt: '2026-07-20T09:15:00.000Z' },
  { id: 'doc-2', filename: 'alpha.docx', status: 'uploaded', uploadedAt: '2026-07-28T14:02:00.000Z' },
  { id: 'doc-3', filename: 'mid.md', status: 'chunking', uploadedAt: '2026-07-30T11:47:00.000Z' },
]

/** The table's filename column, in row order - reads the DOM directly since assertions here care about row *order*, not just presence. */
function getFilenameOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map((row) => row.querySelector('td')?.textContent ?? '')
}

describe('UploadPage', () => {
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

  function dropFile(container: HTMLElement, file: File): void {
    const input = container.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } })
  }

  it('lists seeded documents and appends a newly uploaded document', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(seededDocuments)) // GET on mount
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'doc-4', filename: 'new-report.pdf', status: 'uploaded', uploadedAt: '2026-08-01T00:00:00.000Z' }),
    ) // POST upload

    const { container } = renderWithProviders(<UploadPage />)

    // Seeded documents load asynchronously.
    expect(await screen.findByText('architecture-guide.pdf')).toBeInTheDocument()
    expect(await screen.findByText('onboarding-notes.docx')).toBeInTheDocument()
    expect(await screen.findByText('release-plan.md')).toBeInTheDocument()

    const file = new File(['contents'], 'new-report.pdf', { type: 'application/pdf' })
    // @mantine/dropzone's <Dropzone> renders a visually-hidden native
    // <input type="file"> (via react-dropzone's getInputProps()) behind the
    // large styled drop area, so the accessible-name query used above for
    // the seeded rows doesn't apply here - the hidden input carries no label
    // of its own, only the drop area's visible copy does.
    dropFile(container, file)

    expect(await screen.findByText('new-report.pdf')).toBeInTheDocument()
  })

  it('shows an overwrite confirmation on a duplicate-filename conflict, and re-uploads with overwrite=true on confirm', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(seededDocuments)) // GET on mount
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'duplicate_filename' }, 409)) // first upload attempt
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'doc-1', filename: 'architecture-guide.pdf', status: 'uploaded', uploadedAt: '2026-08-01T00:00:00.000Z' }),
    ) // confirmed overwrite upload

    const { container } = renderWithProviders(<UploadPage />)
    expect(await screen.findByText('architecture-guide.pdf')).toBeInTheDocument()

    const file = new File(['contents'], 'architecture-guide.pdf', { type: 'application/pdf' })
    dropFile(container, file)

    expect(
      await screen.findByText('A document named architecture-guide.pdf already exists - overwrite it?'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    const [, firstUploadInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((firstUploadInit.body as FormData).has('overwrite')).toBe(false)

    const [, secondUploadInit] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect((secondUploadInit.body as FormData).get('overwrite')).toBe('true')

    // Dialog closes and the local row is updated in place (same id).
    await waitFor(() => expect(screen.queryByText(/already exists - overwrite it\?/)).not.toBeInTheDocument())
  })

  it('closes the overwrite dialog without uploading when Cancel is clicked', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(seededDocuments)) // GET on mount
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'duplicate_filename' }, 409)) // upload attempt

    const { container } = renderWithProviders(<UploadPage />)
    expect(await screen.findByText('architecture-guide.pdf')).toBeInTheDocument()

    const file = new File(['contents'], 'architecture-guide.pdf', { type: 'application/pdf' })
    dropFile(container, file)

    expect(
      await screen.findByText('A document named architecture-guide.pdf already exists - overwrite it?'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByText(/already exists - overwrite it\?/)).not.toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shows a dismissable "still processing" message on a document_processing conflict, with no confirm dialog', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(seededDocuments)) // GET on mount
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'document_processing' }, 409)) // upload attempt

    const { container } = renderWithProviders(<UploadPage />)
    expect(await screen.findByText('release-plan.md')).toBeInTheDocument()

    const file = new File(['contents'], 'release-plan.md', { type: 'text/markdown' })
    dropFile(container, file)

    expect(
      await screen.findByText('release-plan.md is still processing - please wait for it to finish before overwriting it.'),
    ).toBeInTheDocument()

    expect(screen.queryByText(/already exists - overwrite it\?/)).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deletes a document when Delete is confirmed, calling the DELETE endpoint and removing the row', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(seededDocuments)) // GET on mount
    fetchMock.mockResolvedValueOnce(jsonResponse(null, 204)) // DELETE

    renderWithProviders(<UploadPage />)
    expect(await screen.findByText('architecture-guide.pdf')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete architecture-guide.pdf' }))
    expect(
      await screen.findByText('Are you sure you want to delete architecture-guide.pdf?'),
    ).toBeInTheDocument()

    // The modal's own "Delete" button (distinct from the row-level
    // "Delete architecture-guide.pdf" ActionIcon queried above).
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('http://localhost:8000/internal/documents/doc-1')
    expect(init.method).toBe('DELETE')

    await waitFor(() => expect(screen.queryByText('architecture-guide.pdf')).not.toBeInTheDocument())
    // Other rows are untouched.
    expect(screen.getByText('onboarding-notes.docx')).toBeInTheDocument()
    expect(screen.queryByText('Are you sure you want to delete architecture-guide.pdf?')).not.toBeInTheDocument()
  })

  it('shows a "still processing" message and keeps the row when Delete conflicts with an in-progress pipeline run', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(seededDocuments)) // GET on mount
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'document_processing' }, 409)) // DELETE

    renderWithProviders(<UploadPage />)
    expect(await screen.findByText('release-plan.md')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete release-plan.md' }))
    expect(await screen.findByText('Are you sure you want to delete release-plan.md?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(
      await screen.findByText('release-plan.md is still processing - please wait for it to finish before deleting it.'),
    ).toBeInTheDocument()

    // Dialog closes, but the row itself is still there (deletion didn't happen).
    expect(screen.queryByText('Are you sure you want to delete release-plan.md?')).not.toBeInTheDocument()
    expect(screen.getByText('release-plan.md')).toBeInTheDocument()
  })

  it('sorts by filename when the Filename header is clicked, toggling direction on a repeat click', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sortTestDocuments)) // GET on mount

    const { container } = renderWithProviders(<UploadPage />)
    expect(await screen.findByText('zeta.pdf')).toBeInTheDocument()

    // No sort applied yet - original fetch order.
    expect(getFilenameOrder(container)).toEqual(['zeta.pdf', 'alpha.docx', 'mid.md'])

    const filenameHeader = screen.getByRole('button', { name: 'Filename' })
    fireEvent.click(filenameHeader)
    expect(getFilenameOrder(container)).toEqual(['alpha.docx', 'mid.md', 'zeta.pdf'])

    fireEvent.click(filenameHeader)
    expect(getFilenameOrder(container)).toEqual(['zeta.pdf', 'mid.md', 'alpha.docx'])

    // Switching to a different column resets to ascending on that column,
    // rather than continuing to toggle the previous column's direction.
    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    expect(getFilenameOrder(container)).toEqual(['alpha.docx', 'mid.md', 'zeta.pdf']) // uploaded, chunking, ready
  })

  it('sorts by status in pipeline-stage order when the Status header is clicked, toggling direction on a repeat click', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sortTestDocuments)) // GET on mount

    const { container } = renderWithProviders(<UploadPage />)
    expect(await screen.findByText('zeta.pdf')).toBeInTheDocument()

    const statusHeader = screen.getByRole('button', { name: 'Status' })
    fireEvent.click(statusHeader)
    // uploaded (alpha) -> chunking (mid) -> ready (zeta)
    expect(getFilenameOrder(container)).toEqual(['alpha.docx', 'mid.md', 'zeta.pdf'])

    fireEvent.click(statusHeader)
    expect(getFilenameOrder(container)).toEqual(['zeta.pdf', 'mid.md', 'alpha.docx'])
  })

  it('sorts chronologically by uploaded date when the Uploaded at header is clicked, toggling direction on a repeat click', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sortTestDocuments)) // GET on mount

    const { container } = renderWithProviders(<UploadPage />)
    expect(await screen.findByText('zeta.pdf')).toBeInTheDocument()

    const uploadedAtHeader = screen.getByRole('button', { name: 'Uploaded at' })
    fireEvent.click(uploadedAtHeader)
    // zeta (07-20, oldest) -> alpha (07-28) -> mid (07-30, newest)
    expect(getFilenameOrder(container)).toEqual(['zeta.pdf', 'alpha.docx', 'mid.md'])

    fireEvent.click(uploadedAtHeader)
    expect(getFilenameOrder(container)).toEqual(['mid.md', 'alpha.docx', 'zeta.pdf'])
  })

  it('shows a colored ascending/descending sort indicator on the active column and a neutral one elsewhere', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sortTestDocuments)) // GET on mount

    renderWithProviders(<UploadPage />)
    expect(await screen.findByText('zeta.pdf')).toBeInTheDocument()

    const filenameTh = screen.getByRole('columnheader', { name: 'Filename' })
    const statusTh = screen.getByRole('columnheader', { name: 'Status' })

    // Nothing sorted yet - both columns show the neutral (muted) indicator.
    expect(filenameTh).toHaveAttribute('aria-sort', 'none')
    expect(statusTh).toHaveAttribute('aria-sort', 'none')
    expect(filenameTh.querySelector('span')?.style.color).toBe('var(--doc-text-muted)')

    fireEvent.click(within(filenameTh).getByRole('button'))
    expect(filenameTh).toHaveAttribute('aria-sort', 'ascending')
    expect(filenameTh.querySelector('span')?.style.color).toBe('var(--mantine-color-signalBlue-6)')
    // The non-active column stays neutral, not just the active one changing.
    expect(statusTh).toHaveAttribute('aria-sort', 'none')
    expect(statusTh.querySelector('span')?.style.color).toBe('var(--doc-text-muted)')

    fireEvent.click(within(filenameTh).getByRole('button'))
    expect(filenameTh).toHaveAttribute('aria-sort', 'descending')
    expect(filenameTh.querySelector('span')?.style.color).toBe('var(--mantine-color-alertMagenta-6)')
  })

  it('shows an in-progress indicator for uploaded/chunking documents but not for ready/failed', async () => {
    const documents: DocumentSummary[] = [
      { id: 'doc-1', filename: 'ready-doc.pdf', status: 'ready', uploadedAt: '2026-07-20T09:15:00.000Z' },
      { id: 'doc-2', filename: 'uploaded-doc.pdf', status: 'uploaded', uploadedAt: '2026-07-28T14:02:00.000Z' },
      { id: 'doc-3', filename: 'chunking-doc.pdf', status: 'chunking', uploadedAt: '2026-07-30T11:47:00.000Z' },
      { id: 'doc-4', filename: 'failed-doc.pdf', status: 'failed', uploadedAt: '2026-07-31T08:00:00.000Z' },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(documents)) // GET on mount
    // Polling is active (doc-2/doc-3 are unsettled) - keep it satisfied with
    // the same snapshot so it doesn't affect this test's assertions.
    fetchMock.mockResolvedValue(jsonResponse(documents))

    renderWithProviders(<UploadPage />)

    const readyRow = (await screen.findByText('ready-doc.pdf')).closest('tr') as HTMLElement
    const uploadedRow = screen.getByText('uploaded-doc.pdf').closest('tr') as HTMLElement
    const chunkingRow = screen.getByText('chunking-doc.pdf').closest('tr') as HTMLElement
    const failedRow = screen.getByText('failed-doc.pdf').closest('tr') as HTMLElement

    expect(within(readyRow).queryByRole('status')).not.toBeInTheDocument()
    expect(within(uploadedRow).getByRole('status')).toBeInTheDocument()
    expect(within(chunkingRow).getByRole('status')).toBeInTheDocument()
    expect(within(failedRow).queryByRole('status')).not.toBeInTheDocument()
  })

  it('polls the document list again while a document is unsettled, and stops once everything settles', async () => {
    vi.useFakeTimers()
    try {
      const unsettled: DocumentSummary[] = [
        { id: 'doc-1', filename: 'release-plan.md', status: 'chunking', uploadedAt: '2026-07-30T11:47:00.000Z' },
      ]
      const settled: DocumentSummary[] = [{ ...unsettled[0], status: 'ready' }]

      fetchMock.mockResolvedValueOnce(jsonResponse(unsettled)) // GET on mount
      fetchMock.mockResolvedValueOnce(jsonResponse(settled)) // first poll: settles

      renderWithProviders(<UploadPage />)

      // Flush the mount effect's fetch + resulting state update before
      // asserting anything about the poll interval it schedules.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Advancing by the poll interval should trigger exactly one more GET.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)

      // The document is now 'ready' (settled) - polling should have stopped,
      // so advancing well past another interval triggers no further calls.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
