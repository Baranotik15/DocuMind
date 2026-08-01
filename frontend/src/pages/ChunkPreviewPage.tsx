import type { JSX, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react'

import { useEffect, useMemo, useRef, useState } from 'react'

import { ActionIcon, Alert, Box, Button, Group, Modal, Stack, Text, Textarea, Title } from '@mantine/core'
import { useNavigate, useParams } from 'react-router-dom'

import classes from './ChunkPreviewPage.module.css'
import { apiClient } from '../api/client'
import { ApiConflictError } from '../api/httpClient'
import type { Chunk, DocumentSummary } from '../api/types'

const PROCESSING_MESSAGE = 'This document is still processing - please wait for it to finish before editing.'

// Cycles through the three brand accents at low opacity so each chunk reads
// as a distinct highlighted rectangle within the reconstructed document, per
// the user's explicit request: semi-transparent rectangles, not inline
// text-highlight/underline.
const HIGHLIGHT_COLORS = [
  'rgba(61, 107, 255, 0.18)',
  'rgba(255, 167, 38, 0.18)',
  'rgba(255, 61, 113, 0.15)',
]

// Documents longer than this (by total chunk-text character count) are
// paginated so a single huge document doesn't render as one endless scroll.
const PAGE_CHAR_LIMIT = 15000

/** Hand-rolled back-arrow glyph - no icon library installed (see design-principles.md). */
function BackIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

export function ChunkPreviewPage(): JSX.Element {
  const { documentId } = useParams<{ documentId: string }>()
  const navigate = useNavigate()
  const [filename, setFilename] = useState('')
  const [status, setStatus] = useState<DocumentSummary['status'] | null>(null)
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [viewport, setViewport] = useState({ topPct: 0, heightPct: 100 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const minimapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!documentId) {
      return
    }
    void apiClient.listDocuments().then((documents) => {
      const match = documents.find((document) => document.id === documentId)
      setFilename(match?.filename ?? '')
      setStatus(match?.status ?? null)
    })
    void apiClient.getChunks(documentId).then(setChunks)
    setPageIndex(0)
  }, [documentId])

  // Groups chunks into pages so no single page holds more than
  // PAGE_CHAR_LIMIT characters of text - a document short enough to fit
  // under the limit ends up as a single page (pagination controls hidden).
  const pages = useMemo(() => {
    const grouped: Chunk[][] = []
    let currentPage: Chunk[] = []
    let currentLength = 0

    for (const chunk of chunks) {
      if (currentLength + chunk.editedContent.length > PAGE_CHAR_LIMIT && currentPage.length > 0) {
        grouped.push(currentPage)
        currentPage = []
        currentLength = 0
      }
      currentPage.push(chunk)
      currentLength += chunk.editedContent.length
    }
    if (currentPage.length > 0) {
      grouped.push(currentPage)
    }
    return grouped
  }, [chunks])

  const pageChunks = useMemo(() => pages[pageIndex] ?? [], [pages, pageIndex])
  // Color assignment is based on each chunk's position in the whole
  // document (not its position within the current page), so a chunk's
  // color stays stable across pagination.
  const colorByChunkId = useMemo(() => {
    const map = new Map<string, string>()
    chunks.forEach((chunk, index) => map.set(chunk.id, HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length]))
    return map
  }, [chunks])

  // Tracks how much of the text column is currently visible, so the
  // minimap can show a "you are here" rectangle - recomputed on every
  // scroll of the text column, and whenever the page's content changes.
  function updateViewport(): void {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const maxScroll = el.scrollHeight - el.clientHeight
    const topPct = maxScroll > 0 ? (el.scrollTop / maxScroll) * 100 : 0
    const heightPct = Math.min(100, (el.clientHeight / el.scrollHeight) * 100)
    setViewport({ topPct, heightPct })
  }

  useEffect(() => {
    updateViewport()
  }, [pageChunks])

  // Clicking the minimap jumps the text column to the corresponding
  // position: the click's fraction of the minimap's own height maps
  // directly onto the text column's scrollable range.
  function handleMinimapClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const minimapEl = minimapRef.current
    const scrollEl = scrollRef.current
    if (!minimapEl || !scrollEl) {
      return
    }
    const rect = minimapEl.getBoundingClientRect()
    const fraction = (event.clientY - rect.top) / rect.height
    scrollEl.scrollTop = fraction * (scrollEl.scrollHeight - scrollEl.clientHeight)
    updateViewport()
  }

  // Scrolling (mouse wheel) while hovering the minimap scrolls the text
  // column instead of the page - the minimap has no scroll of its own.
  function handleMinimapWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    const scrollEl = scrollRef.current
    if (!scrollEl) {
      return
    }
    event.preventDefault()
    scrollEl.scrollTop += event.deltaY
    updateViewport()
  }

  function handleChunkContentChange(chunkId: string, value: string): void {
    setChunks((current) =>
      current.map((chunk) =>
        chunk.id === chunkId ? { ...chunk, editedContent: value, isDirty: value !== chunk.originalContent } : chunk,
      ),
    )
  }

  // Save is only reachable when the document is 'ready' or 'failed' - a
  // fresh upload still 'uploaded', or a re-chunk already 'chunking', has no
  // settled chunk set to reconstruct from (see the spec's Chunk retrieval &
  // save requirements).
  const isBusy = status === 'uploaded' || status === 'chunking'

  async function handleSave(): Promise<void> {
    if (!documentId) {
      return
    }
    try {
      await apiClient.saveChunks(documentId, chunks)
    } catch (error) {
      if (error instanceof ApiConflictError && error.reason === 'document_processing') {
        // Race: status flipped to busy after the page loaded, before this
        // click reached the backend's CAS guard. Reflect that locally (this
        // also disables Save and surfaces the same message below) instead
        // of navigating away or letting the rejection go unhandled.
        setStatus('chunking')
        return
      }
      throw error
    }
    navigate('/upload')
  }

  // Local edits (in `chunks` state) are never persisted until Save calls
  // apiClient.saveChunks, so "discarding" is just a navigation away - no
  // separate revert API call needed. Only prompt when something would
  // actually be lost; a page with no dirty chunks navigates immediately,
  // same as before this confirmation was added.
  function handleCancelClick(): void {
    if (chunks.some((chunk) => chunk.isDirty)) {
      setShowDiscardConfirm(true)
      return
    }
    navigate('/upload')
  }

  function handleDiscardConfirm(): void {
    setShowDiscardConfirm(false)
    navigate('/upload')
  }

  // Escape mirrors the Cancel button's own dirty-check logic (deliberately
  // inlined here, rather than calling handleCancelClick, so this effect's
  // dependency array can list the actual state it reads instead of a
  // function recreated fresh every render), with one extra case: if a
  // chunk's Textarea is actively focused, Escape exits just that chunk's
  // edit mode first (matching its existing onBlur-closes-editing behavior)
  // rather than jumping straight to the page-level Cancel/discard flow - an
  // operator mid-edit pressing Escape is far more likely reaching for "stop
  // editing this chunk" than "leave the page." While the confirm Modal is
  // already open, this listener is a no-op: Mantine's Modal closes itself on
  // Escape by default, so acting here too would fire two things from one
  // keypress.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || showDiscardConfirm) {
        return
      }
      if (activeChunkId !== null) {
        setActiveChunkId(null)
        return
      }
      if (chunks.some((chunk) => chunk.isDirty)) {
        setShowDiscardConfirm(true)
        return
      }
      navigate('/upload')
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showDiscardConfirm, activeChunkId, chunks, navigate])

  return (
    <Stack gap="lg" style={{ height: 'calc(100dvh - var(--app-shell-header-height, 68px) - 2 * var(--mantine-spacing-lg))' }}>
      <Group gap="sm">
        <ActionIcon aria-label="Back to Upload" variant="subtle" color="signalBlue" size="lg" onClick={() => navigate('/upload')}>
          <BackIcon />
        </ActionIcon>
        <Title order={2}>{filename}</Title>
      </Group>

      <Text size="sm" c="dimmed">
        This is the document as it was split into chunks. Click a highlighted rectangle to edit it.
      </Text>

      {isBusy ? (
        <Alert color="alertMagenta" variant="light" radius="lg" title="Still processing">
          {PROCESSING_MESSAGE}
        </Alert>
      ) : null}

      {chunks.length === 0 ? (
        <Text c="dimmed">No chunks yet for this document.</Text>
      ) : (
        <>
          {/*
           * Each chunk is its own block-level colored rectangle, flush
           * against its neighbors (no gap, no padding added around the
           * text) so the whole thing reads as one continuous document with
           * color-coded regions - not a list of separated cards.
           */}
          <Group align="stretch" gap="sm" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
            <Stack
              ref={scrollRef}
              onScroll={updateViewport}
              gap={0}
              className={classes.scrollArea}
              style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
            >
              {pageChunks.map((chunk) => {
                const color = colorByChunkId.get(chunk.id) ?? HIGHLIGHT_COLORS[0]

                return (
                  <Box
                    key={chunk.id}
                    p={0}
                    bg={color}
                    style={{ boxShadow: chunk.isDirty ? 'var(--doc-mark-glow)' : 'none' }}
                    onClick={() => setActiveChunkId(chunk.id)}
                  >
                    {activeChunkId === chunk.id ? (
                      <Textarea
                        value={chunk.editedContent}
                        onChange={(event) => handleChunkContentChange(chunk.id, event.currentTarget.value)}
                        onBlur={() => setActiveChunkId(null)}
                        autoFocus
                        autosize
                        minRows={2}
                        variant="unstyled"
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 'var(--mantine-font-size-lg)' } }}
                      />
                    ) : (
                      <Text ff="monospace" size="lg" style={{ cursor: 'text' }}>
                        {chunk.editedContent}
                      </Text>
                    )}
                  </Box>
                )
              })}
            </Stack>

            {/*
             * VS Code-style minimap: a miniature stack of the same colored
             * chunk rectangles, each showing its own text at a tiny
             * illegible-but-textured size, proportional to that chunk's
             * share of the current page. This IS the scroll control now -
             * the native scrollbar on the text column is hidden (see
             * ChunkPreviewPage.module.css): clicking here jumps the text
             * column to that position, the wheel here scrolls it too, and
             * the gray rectangle overlay tracks what's currently visible.
             * The mini text is decorative only - userSelect 'none' stops
             * click-drag here from starting a text selection (which was
             * triggering the browser's translate-selection popup).
             */}
            <Box
              ref={minimapRef}
              onClick={handleMinimapClick}
              onWheel={handleMinimapWheel}
              style={{
                width: 190,
                alignSelf: 'stretch',
                flexShrink: 0,
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 4,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <Stack gap={0} style={{ height: '100%' }}>
                {pageChunks.map((chunk) => (
                  <Box
                    key={chunk.id}
                    bg={colorByChunkId.get(chunk.id) ?? HIGHLIGHT_COLORS[0]}
                    style={{ flex: chunk.editedContent.length || 1, padding: '0 4px' }}
                  >
                    <Text
                      ff="monospace"
                      style={{
                        fontSize: '4px',
                        lineHeight: 1.4,
                        color: 'var(--doc-text)',
                        overflowWrap: 'break-word',
                      }}
                    >
                      {chunk.editedContent}
                    </Text>
                  </Box>
                ))}
              </Stack>

              <Box
                style={{
                  position: 'absolute',
                  top: `${viewport.topPct * (1 - viewport.heightPct / 100)}%`,
                  height: `${viewport.heightPct}%`,
                  left: 0,
                  right: 0,
                  backgroundColor: 'rgba(124, 138, 173, 0.35)',
                  pointerEvents: 'none',
                }}
              />
            </Box>
          </Group>

          {pages.length > 1 ? (
            <Group justify="center" gap="md">
              <Button
                variant="subtle"
                color="signalBlue"
                disabled={pageIndex === 0}
                onClick={() => setPageIndex((index) => index - 1)}
              >
                Previous
              </Button>
              <Text size="sm" c="dimmed">
                Page {pageIndex + 1} of {pages.length}
              </Text>
              <Button
                variant="subtle"
                color="signalBlue"
                disabled={pageIndex === pages.length - 1}
                onClick={() => setPageIndex((index) => index + 1)}
              >
                Next
              </Button>
            </Group>
          ) : null}
        </>
      )}

      <Group justify="flex-end">
        {/* No confirmation needed when nothing is dirty - see
            handleCancelClick. When something is dirty, the confirm Modal
            below (not this button) is the genuinely destructive/confirming
            action, hence the quiet subtle/signalBlue treatment here rather
            than a bold filled/alertMagenta one. */}
        <Button onClick={handleCancelClick} variant="subtle" color="signalBlue" radius="xl" size="md" px="xl">
          Cancel
        </Button>
        <Button
          onClick={() => void handleSave()}
          disabled={isBusy}
          color="sparkOrange"
          radius="xl"
          size="md"
          px="xl"
        >
          Save
        </Button>
      </Group>

      <Modal
        opened={showDiscardConfirm}
        onClose={() => setShowDiscardConfirm(false)}
        title="Discard changes?"
        radius="lg"
      >
        <Stack gap="lg">
          <Text>You have unsaved edits - are you sure you want to discard them?</Text>
          <Group justify="flex-end">
            <Button variant="subtle" color="signalBlue" radius="xl" onClick={() => setShowDiscardConfirm(false)}>
              Keep editing
            </Button>
            <Button variant="filled" color="alertMagenta" radius="xl" onClick={handleDiscardConfirm}>
              Discard changes
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}
