import type { Chunk, DocumentSummary } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MantineProvider } from '@mantine/core'
import { fireEvent, render, waitFor } from '@testing-library/react'
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

// Stands in for the real UploadPage - navigation is asserted by checking this
// sentinel renders (and the chunk preview's own content is gone), same
// approach as adding a second real Route rather than mocking react-router-dom.
const UPLOAD_PLACEHOLDER = 'Upload page placeholder'

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
          <Route path="/upload" element={<div>{UPLOAD_PLACEHOLDER}</div>} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  )
}

// Every chunk's Textarea is always mounted (no click-to-enter-edit-mode step
// anymore) - this just types directly into the first one, making it dirty,
// matching the state Cancel/Escape are meant to guard.
async function makeFirstChunkDirty(): Promise<void> {
  const [firstTextarea] = await screen.findAllByRole('textbox')
  fireEvent.change(firstTextarea, { target: { value: 'Intro paragraph edited.' } })
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

    expect(await screen.findAllByRole('textbox')).toHaveLength(2)
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
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
  })

  it('navigates to Upload immediately when Cancel is clicked and no chunk is dirty', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await screen.findAllByRole('textbox')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(await screen.findByText(UPLOAD_PLACEHOLDER)).toBeInTheDocument()
    expect(screen.queryByText(filename)).not.toBeInTheDocument()
  })

  it('shows a discard-changes confirmation instead of navigating when Cancel is clicked with a dirty chunk', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await makeFirstChunkDirty()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(await screen.findByText('Discard changes?')).toBeInTheDocument()
    expect(screen.getByText(/unsaved edits/)).toBeInTheDocument()
    expect(screen.getByText(filename)).toBeInTheDocument()
    expect(screen.queryByText(UPLOAD_PLACEHOLDER)).not.toBeInTheDocument()
  })

  it('"Keep editing" closes the confirmation without navigating, leaving the edit intact', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await makeFirstChunkDirty()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('Discard changes?')

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))

    // Mantine's Modal unmounts via an exit transition rather than instantly,
    // same as the confirm dialogs in UploadPage.test.tsx - wait for it.
    await waitFor(() => expect(screen.queryByText('Discard changes?')).not.toBeInTheDocument())
    expect(screen.queryByText(UPLOAD_PLACEHOLDER)).not.toBeInTheDocument()
    expect(screen.getAllByDisplayValue('Intro paragraph edited.').length).toBeGreaterThan(0)
  })

  it('"Discard changes" navigates to Upload, discarding the edit', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await makeFirstChunkDirty()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('Discard changes?')

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(await screen.findByText(UPLOAD_PLACEHOLDER)).toBeInTheDocument()
  })

  it('pressing Escape with a dirty chunk shows the same discard-changes confirmation as Cancel', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await makeFirstChunkDirty()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(await screen.findByText('Discard changes?')).toBeInTheDocument()
    expect(screen.queryByText(UPLOAD_PLACEHOLDER)).not.toBeInTheDocument()
  })

  it('typing into a chunk updates it immediately with no click-to-enter-edit-mode step, and every chunk stays mounted and visible throughout', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    const [firstTextarea, secondTextarea] = await screen.findAllByRole('textbox')
    expect(firstTextarea).toHaveValue('Intro paragraph.')
    expect(secondTextarea).toHaveValue('Second paragraph.')

    fireEvent.change(firstTextarea, { target: { value: 'Intro paragraph edited.' } })

    // Nothing disappears or swaps - both textareas are still there, still
    // showing their own content, immediately reflecting the edit with no
    // separate commit/blur step.
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
    expect(firstTextarea).toHaveValue('Intro paragraph edited.')
    expect(secondTextarea).toHaveValue('Second paragraph.')
  })

  it('disables text selection page-wide, but explicitly re-enables it on every chunk Textarea', async () => {
    stubFetch({ status: 'ready' })

    const { container } = renderChunkPreviewPage()

    const textareas = await screen.findAllByRole('textbox')

    // The page root carries the broad userSelect: 'none' every other element
    // on the page inherits (the boundary marker label, pagination label,
    // buttons, etc.) - asserted directly on this element's own inline style
    // rather than via jsdom's limited getComputedStyle inheritance support.
    // MantineProvider injects its own <style> tags as earlier siblings
    // within `container` (emotion's style-injection point), so the page's
    // actual root element isn't reliably `container.firstChild` - find the
    // first non-<style> child instead.
    const pageRoot = Array.from(container.children).find((el) => el.tagName !== 'STYLE')
    expect(pageRoot).toHaveStyle({ userSelect: 'none' })

    // Every chunk's Textarea carries a direct override back to 'text' - not
    // just one "actively edited" chunk, since there's no such distinction
    // anymore.
    for (const textarea of textareas) {
      expect(textarea).toHaveStyle({ userSelect: 'text' })
    }
  })

  it('renders a boundary handle between adjacent chunks at all times - never hidden, since there is no separate edit mode to hide it during', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await screen.findAllByRole('textbox')

    // Exactly one boundary between this fixture's two chunks.
    expect(screen.getAllByRole('separator')).toHaveLength(1)

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Intro paragraph edited.' } })

    // Still there - editing a chunk's text doesn't hide the handle, unlike
    // the superseded design where a page-wide edit surface replaced
    // everything.
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  it('dragging a boundary handle redistributes lines between the two chunks, and Save includes manualBoundaries: true afterward', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await screen.findAllByRole('textbox')
    const handle = screen.getByRole('separator')

    // Real mouse-drag pixel geometry doesn't work reliably in jsdom, but
    // this doesn't depend on any actual layout measurement (no
    // getBoundingClientRect) - only on the raw clientY values on the mouse
    // events themselves, which jsdom handles fine as plain data. A large
    // downward delta is used deliberately so the exact line-height constant
    // doesn't need to leak into this test: however many lines it rounds to,
    // redistributeLines clamps to what's actually available (this fixture's
    // second chunk has exactly one line), so the observable result is the
    // same either way.
    fireEvent.mouseDown(handle, { clientY: 0 })
    fireEvent.mouseUp(document, { clientY: 500 })

    // The lower chunk's one line moved into the end of the upper chunk.
    const [firstTextarea, secondTextarea] = screen.getAllByRole('textbox')
    expect(firstTextarea).toHaveValue('Intro paragraph.\nSecond paragraph.')
    expect(secondTextarea).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // GET /internal/documents, GET .../chunks, then this POST.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const [, saveInit] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
    const body = JSON.parse(saveInit.body as string) as { manualBoundaries?: boolean }
    expect(body.manualBoundaries).toBe(true)
  })

  it('a boundary handle is keyboard-operable via ArrowUp/ArrowDown, for accessibility', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await screen.findAllByRole('textbox')
    const handle = screen.getByRole('separator')

    fireEvent.keyDown(handle, { key: 'ArrowUp' })

    // ArrowUp moves one line from the end of the upper chunk to the start
    // of the lower chunk - this fixture's upper chunk has exactly one line,
    // so it fully empties.
    const [firstTextarea, secondTextarea] = screen.getAllByRole('textbox')
    expect(firstTextarea).toHaveValue('')
    expect(secondTextarea).toHaveValue('Intro paragraph.\nSecond paragraph.')
  })

  it('Save omits manualBoundaries when only chunk text was edited and no boundary was ever dragged', async () => {
    stubFetch({ status: 'ready' })

    renderChunkPreviewPage()

    await makeFirstChunkDirty()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const [, saveInit] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
    const body = JSON.parse(saveInit.body as string) as { manualBoundaries?: boolean }
    expect(body.manualBoundaries).toBeFalsy()
  })

  describe('Split/Delete tools', () => {
    it('clicking Split arms it (aria-pressed), clicking it again disarms it', async () => {
      stubFetch({ status: 'ready' })

      renderChunkPreviewPage()
      await screen.findAllByRole('textbox')

      const splitButton = screen.getByRole('button', { name: 'Split chunk' })
      expect(splitButton).toHaveAttribute('aria-pressed', 'false')

      fireEvent.click(splitButton)
      expect(splitButton).toHaveAttribute('aria-pressed', 'true')

      fireEvent.click(splitButton)
      expect(splitButton).toHaveAttribute('aria-pressed', 'false')
    })

    it('clicking Delete while Split is armed switches tools instead of both being active', async () => {
      stubFetch({ status: 'ready' })

      renderChunkPreviewPage()
      await screen.findAllByRole('textbox')

      const splitButton = screen.getByRole('button', { name: 'Split chunk' })
      const deleteButton = screen.getByRole('button', { name: 'Delete chunk' })

      fireEvent.click(splitButton)
      expect(splitButton).toHaveAttribute('aria-pressed', 'true')

      fireEvent.click(deleteButton)
      expect(splitButton).toHaveAttribute('aria-pressed', 'false')
      expect(deleteButton).toHaveAttribute('aria-pressed', 'true')
    })

    it('pressing Escape disarms an active tool without triggering the discard-changes confirmation', async () => {
      stubFetch({ status: 'ready' })

      renderChunkPreviewPage()
      await screen.findAllByRole('textbox')

      const splitButton = screen.getByRole('button', { name: 'Split chunk' })
      fireEvent.click(splitButton)
      expect(splitButton).toHaveAttribute('aria-pressed', 'true')

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(splitButton).toHaveAttribute('aria-pressed', 'false')
      expect(screen.queryByText('Discard changes?')).not.toBeInTheDocument()
    })

    it('clicking a chunk with Split armed cuts it into two at the hovered line, and Save includes manualBoundaries: true', async () => {
      stubFetch({ status: 'ready' })
      // jsdom's getBoundingClientRect always returns an all-zero rect by
      // default - pinning top: 0 and height: 84 here makes the hover math
      // predictable: relativeY = event.clientY - rect.top = clientY
      // directly, and lineHeightPx = rect.height / totalLines = 84 / 3 =
      // 28 for this fixture's 3-line chunk (height can't be left at the
      // jsdom default of 0 - computeSplitLineIndex divides by it).
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
        right: 0,
        bottom: 84,
        width: 0,
        height: 84,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)

      const multiLineChunks: Chunk[] = [
        {
          id: 'chunk-1',
          documentId,
          originalContent: 'Line one\nLine two\nLine three',
          editedContent: 'Line one\nLine two\nLine three',
          isDirty: false,
        },
      ]
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/documents')) {
          return Promise.resolve(jsonResponse(documentWithStatus('ready')))
        }
        if (method === 'GET' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
          return Promise.resolve(jsonResponse(multiLineChunks))
        }
        if (method === 'POST' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
          return Promise.resolve(emptyResponse(202))
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      renderChunkPreviewPage()
      const [textbox] = await screen.findAllByRole('textbox')

      fireEvent.click(screen.getByRole('button', { name: 'Split chunk' }))
      // clientY 56 = 2 line-heights (28px each) down from the (mocked)
      // top: 0 - lands the cut between "Line two" and "Line three".
      fireEvent.mouseEnter(textbox)
      fireEvent.mouseMove(textbox, { clientY: 56 })
      fireEvent.click(textbox)

      const textboxesAfter = screen.getAllByRole('textbox')
      expect(textboxesAfter).toHaveLength(2)
      expect(textboxesAfter[0]).toHaveValue('Line one\nLine two')
      expect(textboxesAfter[1]).toHaveValue('Line three')

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
      const [, saveInit] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
      const body = JSON.parse(saveInit.body as string) as { manualBoundaries?: boolean }
      expect(body.manualBoundaries).toBe(true)
    })

    it('splits at the line actually under the cursor even when the real rendered line height is not 28px', async () => {
      // Regression test: this page used to assume every line is exactly
      // BOUNDARY_DRAG_LINE_HEIGHT_PX (28px) tall for the Split tool's hover
      // math, not just the boundary-drag handle's relative-delta math -
      // wrong whenever the chunk's actual font/line-height renders taller
      // or shorter than that, and the error compounds the further down a
      // chunk you click. A 4-line, 160px-tall chunk (40px/line) clicked
      // dead center (clientY 80, i.e. exactly 2 line-heights down) must
      // split 2-and-2, matching the earlier "clicked in the middle"
      // reproduction. The old hardcoded-28px math would have computed
      // round(80 / 28) = 3, splitting 3-and-1 - one line lower than
      // clicked, exactly the reported symptom.
      stubFetch({ status: 'ready' })
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
        right: 0,
        bottom: 160,
        width: 0,
        height: 160,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)

      const fourLineChunks: Chunk[] = [
        {
          id: 'chunk-1',
          documentId,
          originalContent: 'Alpha\nBravo\nCharlie\nDelta',
          editedContent: 'Alpha\nBravo\nCharlie\nDelta',
          isDirty: false,
        },
      ]
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/documents')) {
          return Promise.resolve(jsonResponse(documentWithStatus('ready')))
        }
        if (method === 'GET' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
          return Promise.resolve(jsonResponse(fourLineChunks))
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      renderChunkPreviewPage()
      const [textbox] = await screen.findAllByRole('textbox')

      fireEvent.click(screen.getByRole('button', { name: 'Split chunk' }))
      fireEvent.mouseEnter(textbox)
      fireEvent.mouseMove(textbox, { clientY: 80 })
      fireEvent.click(textbox)

      const textboxesAfter = screen.getAllByRole('textbox')
      expect(textboxesAfter).toHaveLength(2)
      expect(textboxesAfter[0]).toHaveValue('Alpha\nBravo')
      expect(textboxesAfter[1]).toHaveValue('Charlie\nDelta')
    })

    it('clicking a chunk with Delete armed merges its text into the NEXT chunk, rather than destroying it', async () => {
      stubFetch({ status: 'ready' })

      renderChunkPreviewPage()
      const [firstTextbox] = await screen.findAllByRole('textbox')
      expect(screen.getAllByRole('textbox')).toHaveLength(2)

      fireEvent.click(screen.getByRole('button', { name: 'Delete chunk' }))
      fireEvent.mouseEnter(firstTextbox)
      fireEvent.click(firstTextbox)

      // The first chunk's own box is gone, but its text survives, merged
      // into the front of what's left - deleting a chunk removes a
      // boundary, it doesn't destroy content.
      const remaining = screen.getAllByRole('textbox')
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toHaveValue('Intro paragraph.\nSecond paragraph.')
    })

    it('refuses to act on the last chunk on the page - there is no next chunk to merge into', async () => {
      stubFetch({ status: 'ready' })
      const singleChunk: Chunk[] = [
        { id: 'chunk-1', documentId, originalContent: 'Only chunk.', editedContent: 'Only chunk.', isDirty: false },
      ]
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/documents')) {
          return Promise.resolve(jsonResponse(documentWithStatus('ready')))
        }
        if (method === 'GET' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
          return Promise.resolve(jsonResponse(singleChunk))
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      renderChunkPreviewPage()
      const [textbox] = await screen.findAllByRole('textbox')

      fireEvent.click(screen.getByRole('button', { name: 'Delete chunk' }))
      fireEvent.mouseEnter(textbox)
      fireEvent.click(textbox)

      expect(screen.getAllByRole('textbox')).toHaveLength(1)
      expect(textbox).toHaveValue('Only chunk.')
      expect(await screen.findByText(/needs at least one chunk/i)).toBeInTheDocument()
    })

    it('the "needs at least one chunk" toast disappears on its own after a few seconds', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      stubFetch({ status: 'ready' })
      const singleChunk: Chunk[] = [
        { id: 'chunk-1', documentId, originalContent: 'Only chunk.', editedContent: 'Only chunk.', isDirty: false },
      ]
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/documents')) {
          return Promise.resolve(jsonResponse(documentWithStatus('ready')))
        }
        if (method === 'GET' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
          return Promise.resolve(jsonResponse(singleChunk))
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      try {
        renderChunkPreviewPage()
        const [textbox] = await screen.findAllByRole('textbox')

        fireEvent.click(screen.getByRole('button', { name: 'Delete chunk' }))
        fireEvent.mouseEnter(textbox)
        fireEvent.click(textbox)
        expect(await screen.findByText(/needs at least one chunk/i)).toBeInTheDocument()

        vi.advanceTimersByTime(3000)

        await waitFor(() => expect(screen.queryByText(/needs at least one chunk/i)).not.toBeInTheDocument())
      } finally {
        vi.useRealTimers()
      }
    })

    it('clicking the last chunk with Delete armed merges its text into the chunk ABOVE it, since there is no next neighbor', async () => {
      stubFetch({ status: 'ready' })

      renderChunkPreviewPage()
      const [, secondTextbox] = await screen.findAllByRole('textbox')

      fireEvent.click(screen.getByRole('button', { name: 'Delete chunk' }))
      fireEvent.mouseEnter(secondTextbox)
      fireEvent.click(secondTextbox)

      const remaining = screen.getAllByRole('textbox')
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toHaveValue('Intro paragraph.\nSecond paragraph.')
    })

    it('deleting the last chunk of three merges it into the chunk above, leaving the first chunk untouched', async () => {
      stubFetch({ status: 'ready' })
      const threeChunks: Chunk[] = [
        { id: 'chunk-1', documentId, originalContent: 'Intro.', editedContent: 'Intro.', isDirty: false },
        { id: 'chunk-2', documentId, originalContent: 'Middle.', editedContent: 'Middle.', isDirty: false },
        { id: 'chunk-3', documentId, originalContent: 'End.', editedContent: 'End.', isDirty: false },
      ]
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/documents')) {
          return Promise.resolve(jsonResponse(documentWithStatus('ready')))
        }
        if (method === 'GET' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
          return Promise.resolve(jsonResponse(threeChunks))
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      renderChunkPreviewPage()
      const [, , thirdTextbox] = await screen.findAllByRole('textbox')

      fireEvent.click(screen.getByRole('button', { name: 'Delete chunk' }))
      fireEvent.mouseEnter(thirdTextbox)
      fireEvent.click(thirdTextbox)

      const remaining = screen.getAllByRole('textbox')
      expect(remaining).toHaveLength(2)
      expect(remaining[0]).toHaveValue('Intro.')
      expect(remaining[1]).toHaveValue('Middle.\nEnd.')
    })
  })

  describe('Undo/Redo', () => {
    it('Undo and Redo start disabled - there is no history yet on first load', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      await screen.findAllByRole('textbox')

      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
    })

    it('typing in a chunk enables Undo; clicking it reverts the edit and enables Redo', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      const [firstTextbox] = await screen.findAllByRole('textbox')

      fireEvent.change(firstTextbox, { target: { value: 'Intro paragraph edited.' } })
      expect(firstTextbox).toHaveValue('Intro paragraph edited.')

      const undoButton = screen.getByRole('button', { name: 'Undo' })
      expect(undoButton).toBeEnabled()
      fireEvent.click(undoButton)

      expect(firstTextbox).toHaveValue('Intro paragraph.')
      expect(undoButton).toBeDisabled()

      const redoButton = screen.getByRole('button', { name: 'Redo' })
      expect(redoButton).toBeEnabled()
      fireEvent.click(redoButton)

      expect(firstTextbox).toHaveValue('Intro paragraph edited.')
      expect(redoButton).toBeDisabled()
    })

    it('consecutive keystrokes in the same chunk coalesce into a single undo step', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      const [firstTextbox] = await screen.findAllByRole('textbox')

      fireEvent.change(firstTextbox, { target: { value: 'Intro paragraph A.' } })
      fireEvent.change(firstTextbox, { target: { value: 'Intro paragraph AB.' } })
      fireEvent.change(firstTextbox, { target: { value: 'Intro paragraph ABC.' } })

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

      // One Undo click jumps straight back past all three keystrokes, not
      // just the last one - typing without switching away is one continuous
      // undo step, so it doesn't take three clicks to get back to the start.
      expect(firstTextbox).toHaveValue('Intro paragraph.')
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    })

    it('switching to a different chunk starts a new undo step, so undo only reverts the most recent one', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      const [firstTextbox, secondTextbox] = await screen.findAllByRole('textbox')

      fireEvent.change(firstTextbox, { target: { value: 'Intro paragraph edited.' } })
      fireEvent.change(secondTextbox, { target: { value: 'Second paragraph edited.' } })

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(firstTextbox).toHaveValue('Intro paragraph edited.')
      expect(secondTextbox).toHaveValue('Second paragraph.')

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(firstTextbox).toHaveValue('Intro paragraph.')
      expect(secondTextbox).toHaveValue('Second paragraph.')
    })

    it('making a new edit after Undo discards the redo stack', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      const [firstTextbox] = await screen.findAllByRole('textbox')

      fireEvent.change(firstTextbox, { target: { value: 'Intro paragraph edited.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled()

      fireEvent.change(firstTextbox, { target: { value: 'A completely different edit.' } })

      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
    })

    it('Undo reverses a Split, Redo reapplies it', async () => {
      stubFetch({ status: 'ready' })
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
        right: 0,
        bottom: 84,
        width: 0,
        height: 84,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)

      const multiLineChunks: Chunk[] = [
        {
          id: 'chunk-1',
          documentId,
          originalContent: 'Line one\nLine two\nLine three',
          editedContent: 'Line one\nLine two\nLine three',
          isDirty: false,
        },
      ]
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.endsWith('/internal/documents')) {
          return Promise.resolve(jsonResponse(documentWithStatus('ready')))
        }
        if (method === 'GET' && url.endsWith(`/internal/documents/${documentId}/chunks`)) {
          return Promise.resolve(jsonResponse(multiLineChunks))
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      renderChunkPreviewPage()
      const [textbox] = await screen.findAllByRole('textbox')

      fireEvent.click(screen.getByRole('button', { name: 'Split chunk' }))
      fireEvent.mouseEnter(textbox)
      fireEvent.mouseMove(textbox, { clientY: 56 })
      fireEvent.click(textbox)

      expect(screen.getAllByRole('textbox')).toHaveLength(2)

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      const afterUndo = screen.getAllByRole('textbox')
      expect(afterUndo).toHaveLength(1)
      expect(afterUndo[0]).toHaveValue('Line one\nLine two\nLine three')

      fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
      const afterRedo = screen.getAllByRole('textbox')
      expect(afterRedo).toHaveLength(2)
      expect(afterRedo[0]).toHaveValue('Line one\nLine two')
      expect(afterRedo[1]).toHaveValue('Line three')
    })

    it('Undo reverses a Delete/merge, Redo reapplies it', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      const [firstTextbox] = await screen.findAllByRole('textbox')
      expect(screen.getAllByRole('textbox')).toHaveLength(2)

      fireEvent.click(screen.getByRole('button', { name: 'Delete chunk' }))
      fireEvent.mouseEnter(firstTextbox)
      fireEvent.click(firstTextbox)

      expect(screen.getAllByRole('textbox')).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      const afterUndo = screen.getAllByRole('textbox')
      expect(afterUndo).toHaveLength(2)
      expect(afterUndo[0]).toHaveValue('Intro paragraph.')
      expect(afterUndo[1]).toHaveValue('Second paragraph.')

      fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
      const afterRedo = screen.getAllByRole('textbox')
      expect(afterRedo).toHaveLength(1)
      expect(afterRedo[0]).toHaveValue('Intro paragraph.\nSecond paragraph.')
    })

    it('Undo reverses a dragged boundary', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      await screen.findAllByRole('textbox')
      const handle = screen.getByRole('separator')

      fireEvent.mouseDown(handle, { clientY: 0 })
      fireEvent.mouseUp(document, { clientY: 500 })

      const [firstTextarea, secondTextarea] = screen.getAllByRole('textbox')
      expect(firstTextarea).toHaveValue('Intro paragraph.\nSecond paragraph.')
      expect(secondTextarea).toHaveValue('')

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

      expect(firstTextarea).toHaveValue('Intro paragraph.')
      expect(secondTextarea).toHaveValue('Second paragraph.')
    })

    it('Ctrl+Z and Ctrl+Shift+Z trigger Undo/Redo the same as the buttons', async () => {
      stubFetch({ status: 'ready' })
      renderChunkPreviewPage()
      const [firstTextbox] = await screen.findAllByRole('textbox')

      fireEvent.change(firstTextbox, { target: { value: 'Intro paragraph edited.' } })

      fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
      expect(firstTextbox).toHaveValue('Intro paragraph.')

      fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true })
      expect(firstTextbox).toHaveValue('Intro paragraph edited.')
    })
  })
})
