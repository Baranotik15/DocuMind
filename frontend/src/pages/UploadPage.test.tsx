import type { DocumentSummary } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor } from '@testing-library/react'

import { UploadPage } from './UploadPage'
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
})
