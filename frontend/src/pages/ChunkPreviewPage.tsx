import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react'

import { useEffect, useMemo, useRef, useState } from 'react'

import { ActionIcon, Alert, Box, Button, Group, Modal, Stack, Text, Textarea, Title } from '@mantine/core'
import { useNavigate, useParams } from 'react-router-dom'

import classes from './ChunkPreviewPage.module.css'
import { apiClient } from '../api/client'
import { ApiConflictError } from '../api/httpClient'
import type { Chunk, DocumentSummary } from '../api/types'
import { CHUNK_BOUNDARY_MARKER } from '../utils/chunkBoundaryMarker'
import { redistributeLines } from '../utils/redistributeLines'

const PROCESSING_MESSAGE = 'This document is still processing - please wait for it to finish before editing.'

// Cycles through the three brand accents at low opacity so each chunk reads
// as a distinct highlighted rectangle within the reconstructed document, per
// the user's explicit request: semi-transparent rectangles, not inline
// text-highlight/underline. Every chunk stays this color AT ALL TIMES,
// whether or not its text is currently focused - there is no separate
// "read mode" vs "edit mode" anymore (see the 2026-08-02 revision note
// below): nothing about a chunk's appearance changes on click, only where
// the text cursor happens to be.
const HIGHLIGHT_COLORS = [
  'rgba(61, 107, 255, 0.18)',
  'rgba(255, 167, 38, 0.18)',
  'rgba(255, 61, 113, 0.15)',
]

// Documents longer than this (by total chunk-text character count) are
// paginated so a single huge document doesn't render as one endless scroll.
const PAGE_CHAR_LIMIT = 15000

// Converts a boundary-drag's raw pixel distance into a whole-line count. An
// approximation (not read off real rendered layout via getBoundingClientRect)
// deliberately - it means the drag interaction has zero dependency on actual
// DOM geometry, so it can be exercised with plain simulated mouse events in
// tests without jsdom's layout limitations getting in the way.
const BOUNDARY_DRAG_LINE_HEIGHT_PX = 28

/**
 * Commits a completed boundary-drag gesture: redistributes lines between the
 * two chunks the dragged handle sits between, in the FULL `chunks` array (not
 * just the current page's slice - chunk objects carry no page information of
 * their own, so this only ever needs the two specific ids involved). A
 * module-level pure function (not a component closure) so the mouseup effect
 * below can call it without needing to be listed as a `useEffect` dependency
 * that's recreated every render (avoids an exhaustive-deps churn/memoization
 * fight for something that's naturally stateless anyway).
 *
 * Returns the original `chunks` array by reference (no new array allocated)
 * when `lineDelta` ends up moving zero lines even after clamping (e.g.
 * dragged toward a neighbor that's already empty on the giving side) - lets
 * the caller cheaply tell "did anything actually change" via reference
 * equality, same pattern already used elsewhere on this page.
 */
function applyBoundaryDrag(chunks: Chunk[], upperChunkId: string, lowerChunkId: string, lineDelta: number): Chunk[] {
  if (lineDelta === 0) {
    return chunks
  }
  const upperIndex = chunks.findIndex((chunk) => chunk.id === upperChunkId)
  const lowerIndex = chunks.findIndex((chunk) => chunk.id === lowerChunkId)
  if (upperIndex === -1 || lowerIndex === -1) {
    return chunks
  }

  const [newUpperText, newLowerText] = redistributeLines(
    chunks[upperIndex].editedContent,
    chunks[lowerIndex].editedContent,
    lineDelta,
  )
  if (newUpperText === chunks[upperIndex].editedContent && newLowerText === chunks[lowerIndex].editedContent) {
    return chunks
  }

  const next = [...chunks]
  next[upperIndex] = { ...next[upperIndex], editedContent: newUpperText, isDirty: true }
  next[lowerIndex] = { ...next[lowerIndex], editedContent: newLowerText, isDirty: true }
  return next
}

/** Hand-rolled back-arrow glyph - no icon library installed (see design-principles.md). */
function BackIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

/** Hand-rolled grip/handle glyph for the boundary-drag control - no icon library installed (see design-principles.md). */
function GripIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
    </svg>
  )
}

interface BoundaryHandleProps {
  upperChunkId: string
  lowerChunkId: string
  onDragStart: (upperChunkId: string, lowerChunkId: string, clientY: number) => void
  onKeyboardMove: (upperChunkId: string, lowerChunkId: string, lineDelta: number) => void
}

/**
 * The persistent divider between every pair of adjacent chunks - shown at
 * ALL times (not just while something is being edited, since there's no such
 * separate mode anymore), displaying the literal boundary-marker word plus a
 * small draggable grip. Dragging it (or, for keyboard operability - see
 * design-principles.md's accessibility rule - focusing it and pressing
 * ArrowUp/ArrowDown) moves whole lines across the boundary via
 * `redistributeLines`, for future chunk resizing.
 */
function BoundaryHandle({ upperChunkId, lowerChunkId, onDragStart, onKeyboardMove }: BoundaryHandleProps): JSX.Element {
  return (
    <Group
      role="separator"
      aria-orientation="horizontal"
      aria-label="Drag to resize the chunks on either side"
      tabIndex={0}
      gap={6}
      justify="center"
      className={classes.boundaryHandle}
      onMouseDown={(event) => onDragStart(upperChunkId, lowerChunkId, event.clientY)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          onKeyboardMove(upperChunkId, lowerChunkId, -1)
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          onKeyboardMove(upperChunkId, lowerChunkId, 1)
        }
      }}
    >
      <GripIcon />
      <Text size="xs" c="dimmed" ff="monospace">
        {CHUNK_BOUNDARY_MARKER}
      </Text>
      <GripIcon />
    </Group>
  )
}

export function ChunkPreviewPage(): JSX.Element {
  const { documentId } = useParams<{ documentId: string }>()
  const navigate = useNavigate()
  const [filename, setFilename] = useState('')
  const [status, setStatus] = useState<DocumentSummary['status'] | null>(null)
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  // True once a boundary drag has actually moved at least one line during
  // this editing session - never reset back to false afterward, per the
  // spec: once the operator has manually adjusted a boundary, Save should
  // keep sending the exact chunk array as final for the rest of this
  // session, not silently fall back to a fresh algorithmic re-chunk. See
  // handleSave and .claude/specs/manual-chunk-boundaries.md.
  const [boundariesManuallyAdjusted, setBoundariesManuallyAdjusted] = useState(false)
  const [viewport, setViewport] = useState({ topPct: 0, heightPct: 100 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const minimapRef = useRef<HTMLDivElement>(null)
  // In-flight drag state - a ref (not component state) since it's written
  // and read entirely within the mousedown/mousemove/mouseup lifecycle of a
  // single gesture and only its downstream effect (the redistributed chunk
  // text) needs to trigger a re-render, not the drag state itself.
  // `baseUpperText`/`baseLowerText` snapshot the two chunks' content at the
  // moment the drag starts, so every mousemove recomputes the redistribution
  // fresh from that fixed starting point (via `redistributeLines`) instead
  // of compounding on top of the previous mousemove's result - the same
  // total drag distance always produces the same result regardless of how
  // many intermediate mousemove events fired. `lastLineDelta` dedupes those
  // events: most fire without crossing a whole-line threshold, and this
  // skips the no-op `setChunks` call for those instead of re-rendering on
  // every single pixel of mouse movement.
  const dragStateRef = useRef<{
    upperChunkId: string
    lowerChunkId: string
    startY: number
    baseUpperText: string
    baseLowerText: string
    lastLineDelta: number
  } | null>(null)
  // Native <textarea> elements keyed by chunk id, so ArrowUp/Down/Left/Right
  // at a chunk's edge can hand focus + caret off to the neighboring chunk's
  // textarea (see handleChunkKeyDown) - there's no single continuous input
  // to navigate within, since every chunk is its own always-mounted
  // Textarea, so this stitches them into one seamless-feeling document for
  // keyboard navigation without changing that per-chunk structure.
  const chunkTextareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map())

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

  // Every chunk's Textarea is always mounted (see the component-level
  // comment on HIGHLIGHT_COLORS) - typing in one updates its own
  // editedContent/isDirty directly and immediately, exactly like a normal
  // text file, with no separate "commit" step and nothing else on the page
  // changing appearance.
  function handleChunkTextChange(chunkId: string, value: string): void {
    setChunks((current) =>
      current.map((chunk) =>
        chunk.id === chunkId ? { ...chunk, editedContent: value, isDirty: value !== chunk.originalContent } : chunk,
      ),
    )
  }

  // Moves focus + caret into an adjacent chunk's textarea, at a position
  // that continues naturally from wherever the caret just left. `column`
  // (for the two line-relative modes) is clamped to the target line's
  // actual length, so jumping from a long line into a short first/last line
  // never lands past the end of that line.
  function focusChunkCaret(
    chunkId: string,
    target: { mode: 'firstLineColumn' | 'lastLineColumn'; column: number } | { mode: 'documentStart' | 'documentEnd' },
  ): void {
    const el = chunkTextareaRefs.current.get(chunkId)
    if (!el) {
      return
    }
    // Snapshot the scroll column's position and pin it back after the
    // focus + caret change below. `preventScroll` alone stops the big
    // jump-to-element scroll, but Chrome still nudges the scroll column by
    // a few px on its own to keep the new caret position "in view" (a
    // separate mechanism `preventScroll` doesn't cover) - visible as a
    // residual micro-scroll/settle on every boundary crossing even when
    // the target chunk was already fully on screen. Restoring the exact
    // prior scrollTop synchronously, before the browser paints, cancels
    // that out regardless of which internal mechanism caused it.
    const scrollEl = scrollRef.current
    const previousScrollTop = scrollEl?.scrollTop
    // preventScroll: true - without it, the browser's default focus
    // behavior snaps the scroll column to wherever it thinks the newly
    // focused textarea "should" be, fighting the custom minimap-driven
    // scroll position and reading as an abrupt jerk on every boundary
    // crossing, even when the neighboring chunk was already fully visible.
    el.focus({ preventScroll: true })
    let position: number
    if (target.mode === 'firstLineColumn') {
      const firstLineEnd = el.value.indexOf('\n')
      const firstLineLength = firstLineEnd === -1 ? el.value.length : firstLineEnd
      position = Math.min(target.column, firstLineLength)
    } else if (target.mode === 'lastLineColumn') {
      const lastLineStart = el.value.lastIndexOf('\n') + 1
      position = lastLineStart + Math.min(target.column, el.value.length - lastLineStart)
    } else if (target.mode === 'documentStart') {
      position = 0
    } else {
      position = el.value.length
    }
    el.setSelectionRange(position, position)
    if (scrollEl && previousScrollTop !== undefined) {
      scrollEl.scrollTop = previousScrollTop
    }
  }

  // Lets ArrowUp/Down/Left/Right cross out of the current chunk's textarea
  // into the neighboring one once the caret is already at that edge -
  // otherwise, with N separate <textarea> elements, the caret is trapped
  // inside whichever one currently has focus (native browser behavior),
  // which read as the page "not letting you out of a chunk". Only fires
  // with no active selection (selectionStart === selectionEnd) so it never
  // interferes with extending a selection via Shift+Arrow. Navigation is
  // scoped to the current page's chunks (`pageChunks`), matching the
  // boundary handle's own scope - crossing a pagination page break is not
  // handled here.
  function handleChunkKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>, chunkId: string): void {
    const el = event.currentTarget
    const { selectionStart, selectionEnd, value } = el
    if (selectionStart !== selectionEnd) {
      return
    }
    const index = pageChunks.findIndex((chunk) => chunk.id === chunkId)

    if (event.key === 'ArrowUp') {
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
      if (lineStart === 0 && index > 0) {
        event.preventDefault()
        focusChunkCaret(pageChunks[index - 1].id, { mode: 'lastLineColumn', column: selectionStart - lineStart })
      }
    } else if (event.key === 'ArrowDown') {
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
      const onLastLine = value.indexOf('\n', selectionStart) === -1
      if (onLastLine && index < pageChunks.length - 1) {
        event.preventDefault()
        focusChunkCaret(pageChunks[index + 1].id, { mode: 'firstLineColumn', column: selectionStart - lineStart })
      }
    } else if (event.key === 'ArrowLeft' && selectionStart === 0 && index > 0) {
      event.preventDefault()
      focusChunkCaret(pageChunks[index - 1].id, { mode: 'documentEnd' })
    } else if (event.key === 'ArrowRight' && selectionStart === value.length && index < pageChunks.length - 1) {
      event.preventDefault()
      focusChunkCaret(pageChunks[index + 1].id, { mode: 'documentStart' })
    }
  }

  function handleBoundaryDragStart(upperChunkId: string, lowerChunkId: string, clientY: number): void {
    const upperChunk = chunks.find((chunk) => chunk.id === upperChunkId)
    const lowerChunk = chunks.find((chunk) => chunk.id === lowerChunkId)
    if (!upperChunk || !lowerChunk) {
      return
    }
    dragStateRef.current = {
      upperChunkId,
      lowerChunkId,
      startY: clientY,
      baseUpperText: upperChunk.editedContent,
      baseLowerText: lowerChunk.editedContent,
      lastLineDelta: 0,
    }
  }

  function handleBoundaryKeyboardMove(upperChunkId: string, lowerChunkId: string, lineDelta: number): void {
    const next = applyBoundaryDrag(chunks, upperChunkId, lowerChunkId, lineDelta)
    if (next !== chunks) {
      setChunks(next)
      setBoundariesManuallyAdjusted(true)
    }
  }

  // Document-wide mousemove + mouseup listeners (rather than scoped to each
  // thin handle) so a drag still tracks correctly even if the cursor drifts
  // off the handle mid-gesture - matching how real drag interactions are
  // expected to behave. Live preview: every mousemove recomputes the
  // redistribution from the drag's fixed base text and applies it
  // immediately, so the two chunks visibly reflow WHILE dragging, not only
  // once the mouse button is released - mouseup just applies the same
  // computation one final time (using its own event's clientY) and ends
  // the gesture.
  useEffect(() => {
    function applyDragLineDelta(lineDelta: number): void {
      const drag = dragStateRef.current
      if (!drag || lineDelta === drag.lastLineDelta) {
        return
      }
      drag.lastLineDelta = lineDelta
      const [newUpperText, newLowerText] = redistributeLines(drag.baseUpperText, drag.baseLowerText, lineDelta)
      if (newUpperText !== drag.baseUpperText || newLowerText !== drag.baseLowerText) {
        setBoundariesManuallyAdjusted(true)
      }
      setChunks((current) =>
        current.map((chunk) => {
          if (chunk.id === drag.upperChunkId && chunk.editedContent !== newUpperText) {
            return { ...chunk, editedContent: newUpperText, isDirty: newUpperText !== chunk.originalContent }
          }
          if (chunk.id === drag.lowerChunkId && chunk.editedContent !== newLowerText) {
            return { ...chunk, editedContent: newLowerText, isDirty: newLowerText !== chunk.originalContent }
          }
          return chunk
        }),
      )
    }

    function handleMouseMove(event: MouseEvent): void {
      const drag = dragStateRef.current
      if (!drag) {
        return
      }
      applyDragLineDelta(Math.round((event.clientY - drag.startY) / BOUNDARY_DRAG_LINE_HEIGHT_PX))
    }

    function handleMouseUp(event: MouseEvent): void {
      const drag = dragStateRef.current
      if (!drag) {
        return
      }
      applyDragLineDelta(Math.round((event.clientY - drag.startY) / BOUNDARY_DRAG_LINE_HEIGHT_PX))
      dragStateRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

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
      // manualBoundaries is only ever true once a boundary drag has actually
      // moved at least one line this session (see boundariesManuallyAdjusted
      // above) - an ordinary Save where no boundary was ever touched sends
      // exactly what it always has, unchanged default backend behavior
      // (full re-chunk).
      await apiClient.saveChunks(documentId, chunks, boundariesManuallyAdjusted)
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
  // separate revert API call needed.
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
  // function recreated fresh every render). While the confirm Modal is
  // already open, this listener is a no-op: Mantine's Modal closes itself on
  // Escape by default, so acting here too would fire two things from one
  // keypress.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || showDiscardConfirm) {
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
  }, [showDiscardConfirm, chunks, navigate])

  return (
    // userSelect 'none' at this page-wide scope (rather than one-off fixes on
    // individual elements) stops a click-drag ANYWHERE on this page's
    // non-editing chrome (pagination label, boundary marker word, buttons,
    // ...) from starting a text selection, which was triggering the
    // browser's translate-selection popup. Every descendant inherits `none`
    // by default; every chunk's Textarea explicitly overrides it back to
    // 'text' (see below) - that's genuine text-editing surface, unlike
    // everything else on the page.
    <Stack
      gap="lg"
      style={{
        height: 'calc(100dvh - var(--app-shell-header-height, 68px) - 2 * var(--mantine-spacing-lg))',
        userSelect: 'none',
      }}
    >
      <Group gap="sm">
        <ActionIcon aria-label="Back to Upload" variant="subtle" color="signalBlue" size="lg" onClick={() => navigate('/upload')}>
          <BackIcon />
        </ActionIcon>
        <Title order={2}>{filename}</Title>
      </Group>

      <Text size="sm" c="dimmed">
        This is the document as it was split into chunks. Edit any chunk's text directly, or drag a boundary to
        resize the chunks on either side of it.
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
          <Group align="stretch" gap="sm" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
            <Stack
              ref={scrollRef}
              onScroll={updateViewport}
              gap={0}
              className={classes.scrollArea}
              style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
            >
              {pageChunks.map((chunk, index) => (
                <div key={chunk.id}>
                  {/* Each chunk is its own always-mounted, always-editable,
                      always-colored block - nothing about its appearance
                      changes on click/focus, only where the text cursor is.
                      variant="unstyled" plus a transparent background keeps
                      the Textarea visually identical to plain text sitting
                      directly on the colored Box - no border, no separate
                      "edit mode" chrome. */}
                  <Box p={0} bg={colorByChunkId.get(chunk.id) ?? HIGHLIGHT_COLORS[0]} style={{ boxShadow: chunk.isDirty ? 'var(--doc-mark-glow)' : 'none' }}>
                    <Textarea
                      ref={(el) => {
                        if (el) {
                          chunkTextareaRefs.current.set(chunk.id, el)
                        } else {
                          chunkTextareaRefs.current.delete(chunk.id)
                        }
                      }}
                      value={chunk.editedContent}
                      onChange={(event) => handleChunkTextChange(chunk.id, event.currentTarget.value)}
                      onKeyDown={(event) => handleChunkKeyDown(event, chunk.id)}
                      autosize
                      minRows={1}
                      variant="unstyled"
                      styles={{
                        input: {
                          fontFamily: 'var(--mantine-font-family-monospace)',
                          fontSize: 'var(--mantine-font-size-lg)',
                          // Direct override of the page-wide userSelect:
                          // 'none' above - an inline style on the element
                          // itself always wins over an inherited value,
                          // regardless of the ancestor's own specificity.
                          userSelect: 'text',
                        },
                      }}
                    />
                  </Box>
                  {index < pageChunks.length - 1 ? (
                    <BoundaryHandle
                      upperChunkId={chunk.id}
                      lowerChunkId={pageChunks[index + 1].id}
                      onDragStart={handleBoundaryDragStart}
                      onKeyboardMove={handleBoundaryKeyboardMove}
                    />
                  ) : null}
                </div>
              ))}
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
             * triggering the browser's translate-selection popup). It DOES
             * live-update per keystroke now, unlike the earlier
             * commit-on-blur design - there's no separate commit step
             * anymore, chunk edits land in `chunks` immediately.
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
                        whiteSpace: 'pre-wrap',
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
        </>
      )}

      {/* Pagination (when present) and the Cancel/Save actions share this
          one bottom-anchored row - pagination truly centered in the row,
          Cancel/Save right-aligned - rather than pagination floating in its
          own row above it. Centering the pagination `Group` via
          `position: absolute` + `left: 50%` + `translate(-50%, -50%)` (not a
          plain `justify="space-between"` two-flex-children trick) is
          deliberate: it centers relative to the row's own width regardless
          of how wide the Cancel/Save cluster on the right happens to be,
          rather than only "looking centered" when both sides happen to be
          similar widths. */}
      <Box style={{ position: 'relative', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
        {pages.length > 1 ? (
          <Group gap="md" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
            {/* Hidden (not disabled) at each boundary - see the pageIndex
                checks below - rather than rendered-but-grayed-out, per
                explicit user direction. The "Page X of Y" label just sits
                between whichever of the two buttons is currently present. */}
            {pageIndex > 0 ? (
              <Button
                className={classes.paginationButton}
                variant="filled"
                color="sparkOrange"
                onClick={() => setPageIndex((index) => index - 1)}
              >
                Previous
              </Button>
            ) : null}
            <Text size="sm" c="dimmed">
              Page {pageIndex + 1} of {pages.length}
            </Text>
            {pageIndex < pages.length - 1 ? (
              <Button
                className={classes.paginationButton}
                variant="filled"
                color="sparkOrange"
                onClick={() => setPageIndex((index) => index + 1)}
              >
                Next
              </Button>
            ) : null}
          </Group>
        ) : null}

        <Group gap="sm">
          {/* Bold filled/alertMagenta by explicit user direction (a red/pink
              "leave this page" action), not the quieter subtle/signalBlue
              treatment the Buttons section otherwise recommends for a plain
              Cancel - see design-principles.md's Chunk Preview subsection.
              The discard-confirmation flow itself (handleCancelClick) is
              unaffected: nothing is confirmed here directly, the Modal below
              still only appears when a chunk is actually dirty. */}
          <Button onClick={handleCancelClick} variant="filled" color="alertMagenta" radius="xl" size="md" px="xl">
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
      </Box>

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
