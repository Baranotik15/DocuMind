import type { FileWithPath } from '@mantine/dropzone'
import type { JSX } from 'react'

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import { useNavigate } from 'react-router-dom'

import classes from './UploadPage.module.css'
import { apiClient } from '../api/client'
import { ApiConflictError } from '../api/httpClient'
import type { DocumentSummary } from '../api/types'
import { formatDateTime } from '../utils/formatDateTime'

// While any listed document is still 'uploaded'/'chunking', re-fetch the
// document list on this cadence so the status genuinely progresses to
// 'ready'/'failed' on its own, instead of requiring a manual page refresh.
// Exported so UploadPage.test.tsx can advance fake timers by exactly this
// amount rather than duplicating the literal.
export const POLL_INTERVAL_MS = 5000

/**
 * 'uploaded' (queued, not yet chunking) and 'chunking' (actively being
 * chunked) are the two "still processing" statuses - not yet settled into a
 * terminal 'ready'/'failed' state.
 */
function isUnsettled(document: DocumentSummary): boolean {
  return document.status === 'uploaded' || document.status === 'chunking'
}

// The document table's three sortable columns. Sorting is client-side over
// whatever `listDocuments()` already returned (no backend involvement) - the
// operator clicks a column header to sort by it, rather than typing into
// separate filter inputs.
type SortColumn = 'filename' | 'status' | 'uploadedAt'
type SortDirection = 'asc' | 'desc'
interface SortState {
  column: SortColumn
  direction: SortDirection
}

// Pipeline-stage order (not alphabetical) - reads more usefully than
// alphabetical for an operator scanning the table, and groups the two
// "still processing" statuses together at one end.
const STATUS_SORT_RANK: Record<DocumentSummary['status'], number> = {
  uploaded: 0,
  chunking: 1,
  ready: 2,
  failed: 3,
}

function compareDocuments(a: DocumentSummary, b: DocumentSummary, column: SortColumn): number {
  if (column === 'filename') {
    return a.filename.localeCompare(b.filename)
  }
  if (column === 'status') {
    return STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status]
  }
  return new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime()
}

/** Hand-rolled chevron glyph - no icon library installed (see design-principles.md). Points down for 'desc', rotated to point up for 'asc'. */
function ChevronIcon({ direction }: { direction: SortDirection }): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ transform: direction === 'asc' ? 'rotate(180deg)' : undefined }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

interface SortableHeaderProps {
  label: string
  column: SortColumn
  sort: SortState | null
  onSort: (column: SortColumn) => void
}

/**
 * A clickable `Table.Th` - clicking sorts the table by this column (toggling
 * direction on a repeat click of the same column, resetting to ascending
 * when switching to a different column), with a chevron indicating the
 * active column's current direction. `aria-sort` on the `<th>` itself is the
 * standard ARIA pattern for sortable table headers.
 */
function SortableHeader({ label, column, sort, onSort }: SortableHeaderProps): JSX.Element {
  const isActive = sort?.column === column
  return (
    <Table.Th aria-sort={isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <UnstyledButton onClick={() => onSort(column)} fw={700} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {label}
        {isActive ? <ChevronIcon direction={sort.direction} /> : null}
      </UnstyledButton>
    </Table.Th>
  )
}

const STATUS_META: Record<DocumentSummary['status'], { label: string; color: string; inProgress: boolean }> = {
  // Queued - not yet actively processing, so a quieter neutral tone than 'chunking'.
  uploaded: { label: 'Uploaded', color: 'gray', inProgress: true },
  // Actively processing - the primary accent plus a spinner makes this the
  // most visually "alive" state, per the request.
  chunking: { label: 'Chunking', color: 'signalBlue', inProgress: true },
  // Success tone - same stock `teal` the header's decorative "system ok"
  // indicator uses for a generic "ok" signal (see design-principles.md).
  ready: { label: 'Ready', color: 'teal', inProgress: false },
  failed: { label: 'Failed', color: 'alertMagenta', inProgress: false },
}

/**
 * Combines point 2 (status display) and point 3 ("still processing"
 * animation) into one piece: a color-coded `Badge` per status, with a small
 * `Loader` alongside it for the two unsettled statuses so it's visually
 * unmistakable that something is actively happening - not just a static
 * word. `role="status"` on the wrapping `Group` (rather than relying on the
 * `Loader`'s own markup) is what tests key off of to assert the indicator is
 * present/absent per row.
 */
function StatusBadge({ status }: { status: DocumentSummary['status'] }): JSX.Element {
  const meta = STATUS_META[status]
  return (
    <Group
      gap={6}
      wrap="nowrap"
      role={meta.inProgress ? 'status' : undefined}
      aria-label={meta.inProgress ? `${meta.label} - in progress` : undefined}
    >
      <Badge color={meta.color} variant={meta.inProgress ? 'light' : 'filled'} radius="sm">
        {meta.label}
      </Badge>
      {meta.inProgress ? <Loader size={12} color={meta.color} aria-hidden="true" /> : null}
    </Group>
  )
}

/** Simple cloud-upload glyph - no icon library is installed (see design-principles.md), so this is a small hand-rolled SVG rather than a new dependency. */
function UploadIcon(): JSX.Element {
  return (
    <svg
      width="52"
      height="52"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--mantine-color-sparkOrange-5)"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 18a4 4 0 0 1-.6-7.96 5 5 0 0 1 9.6-1.54A3.5 3.5 0 0 1 15.5 15" />
      <path d="M12 12v8" />
      <path d="m9 15 3-3 3 3" />
    </svg>
  )
}

/** Hand-rolled pencil/trash glyphs - same no-icon-library rationale as UploadIcon above. */
function PencilIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function TrashIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

export function UploadPage(): JSX.Element {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [deleteTarget, setDeleteTarget] = useState<DocumentSummary | null>(null)
  // Set when an upload attempt comes back 409 duplicate_filename - holds the
  // File so Confirm can re-issue the same upload with overwrite=true.
  const [overwriteTarget, setOverwriteTarget] = useState<File | null>(null)
  // Set when an upload/overwrite attempt comes back 409 document_processing -
  // there's nothing to confirm in that case, just a message to dismiss.
  const [processingMessage, setProcessingMessage] = useState<string | null>(null)
  // No sort applied until a header is clicked - the table starts in
  // whatever order `listDocuments()` returned it in.
  const [sort, setSort] = useState<SortState | null>(null)
  const navigate = useNavigate()

  // Timestamp of the most recent local optimistic update (attemptUpload's
  // in-place row update below) - guards the poll effect against clobbering a
  // more recent local change with a now-stale response (see the effect
  // below for the full explanation).
  const lastLocalMutationRef = useRef(0)

  useEffect(() => {
    void apiClient.listDocuments().then(setDocuments)
  }, [])

  // Light polling: while any listed document is still 'uploaded'/'chunking',
  // periodically re-fetch the document list so the status genuinely
  // progresses to 'ready'/'failed' on its own, rather than requiring a
  // manual page refresh. Stops as soon as nothing is unsettled.
  useEffect(() => {
    if (!documents.some(isUnsettled)) {
      return
    }

    const intervalId = setInterval(() => {
      const requestStartedAt = Date.now()
      void apiClient.listDocuments().then((fetched) => {
        // A local optimistic update (attemptUpload's in-place row update)
        // may have landed after this poll was dispatched but before it
        // resolved - applying this now-stale snapshot on top of it would
        // revert/flicker that more recent change, so it's discarded instead.
        // The next poll tick (or the next local mutation) will pick up the
        // correct state.
        if (requestStartedAt < lastLocalMutationRef.current) {
          return
        }
        setDocuments(fetched)
      })
    }, POLL_INTERVAL_MS)

    return () => clearInterval(intervalId)
  }, [documents])

  const sortedDocuments = useMemo(() => {
    if (!sort) {
      return documents
    }
    const multiplier = sort.direction === 'asc' ? 1 : -1
    return [...documents].sort((a, b) => multiplier * compareDocuments(a, b, sort.column))
  }, [documents, sort])

  function handleSort(column: SortColumn): void {
    setSort((current) => {
      if (current?.column === column) {
        return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { column, direction: 'asc' }
    })
  }

  async function attemptUpload(file: File, overwrite: boolean): Promise<void> {
    try {
      const uploaded = await apiClient.uploadDocument(file, overwrite)
      lastLocalMutationRef.current = Date.now()
      setDocuments((current) => {
        const index = current.findIndex((document) => document.id === uploaded.id)
        if (index === -1) {
          return [...current, uploaded]
        }
        // Overwrite: the backend reuses the same id, so update the existing
        // row in place rather than appending a duplicate.
        const next = [...current]
        next[index] = uploaded
        return next
      })
    } catch (error) {
      if (error instanceof ApiConflictError) {
        if (error.reason === 'duplicate_filename') {
          setOverwriteTarget(file)
          return
        }
        setProcessingMessage(`${file.name} is still processing - please wait for it to finish before overwriting it.`)
        return
      }
      throw error
    }
  }

  async function handleFilesDrop(files: FileWithPath[]): Promise<void> {
    const file = files[0]
    if (!file) {
      return
    }

    await attemptUpload(file, false)
  }

  function handleConfirmOverwrite(): void {
    const file = overwriteTarget
    setOverwriteTarget(null)
    if (file) {
      void attemptUpload(file, true)
    }
  }

  return (
    <Stack gap="xl">
      <Title order={2}>Upload</Title>

      {processingMessage ? (
        <Alert
          color="alertMagenta"
          variant="light"
          radius="lg"
          title="Still processing"
          withCloseButton
          onClose={() => setProcessingMessage(null)}
        >
          {processingMessage}
        </Alert>
      ) : null}

      <Dropzone
        onDrop={(files) => void handleFilesDrop(files)}
        multiple={false}
        maxFiles={1}
        radius="lg"
        p="xl"
        acceptColor="sparkOrange"
        rejectColor="alertMagenta"
        classNames={{ root: classes.dropzone }}
        // Mantine's own Dropzone stylesheet sets a hardcoded white
        // background for [data-mantine-color-scheme='light'] inside
        // `@layer mantine` - it was winning the cascade over our CSS
        // module override. Inline styles always beat stylesheet rules
        // regardless of layers/specificity, so the idle background is
        // pinned here instead of fighting that rule in CSS.
        styles={{ root: { backgroundColor: 'var(--doc-surface)' } }}
      >
        <Group justify="center" gap="lg" mih={160} style={{ pointerEvents: 'none' }}>
          <UploadIcon />
          <Stack gap={4} align="flex-start">
            <Text size="lg" fw={700}>
              Drop a document here or click to browse
            </Text>
            <Text size="sm" c="dimmed">
              PDF, DOCX, or Markdown - added to your knowledge base for chunking and chat.
            </Text>
          </Stack>
        </Group>
      </Dropzone>

      <Table fz="md" verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            {/* Sortable headers, not separate filter inputs: click a column
                to sort the already-fetched document list by it (client-side,
                no backend involvement) - click again to reverse direction. */}
            <SortableHeader label="Filename" column="filename" sort={sort} onSort={handleSort} />
            <SortableHeader label="Status" column="status" sort={sort} onSort={handleSort} />
            <SortableHeader label="Uploaded at" column="uploadedAt" sort={sort} onSort={handleSort} />
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sortedDocuments.length === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={4}>
                <Text c="dimmed" ta="center" py="md">
                  No documents uploaded yet.
                </Text>
              </Table.Td>
            </Table.Tr>
          ) : (
            sortedDocuments.map((document) => (
              <Table.Tr key={document.id}>
                <Table.Td ff="monospace">{document.filename}</Table.Td>
                <Table.Td>
                  <StatusBadge status={document.status} />
                </Table.Td>
                <Table.Td ff="monospace">{formatDateTime(document.uploadedAt)}</Table.Td>
                <Table.Td>
                  {/* Delete is still a stub - not yet designed. Edit navigates
                      to the full-page chunk preview for this document (see
                      ChunkPreviewPage.tsx) instead of a "Chunks" tab. */}
                  <Group gap="xs" wrap="nowrap">
                    <ActionIcon
                      size="lg"
                      aria-label={`Edit ${document.filename}`}
                      variant="subtle"
                      color="signalBlue"
                      onClick={() => navigate(`/upload/${document.id}/chunks`)}
                    >
                      <PencilIcon />
                    </ActionIcon>
                    <ActionIcon
                      size="lg"
                      aria-label={`Delete ${document.filename}`}
                      variant="subtle"
                      color="alertMagenta"
                      onClick={() => setDeleteTarget(document)}
                    >
                      <TrashIcon />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))
          )}
        </Table.Tbody>
      </Table>

      {/* Delete itself is still a stub (see the Actions column comment
          above) - Confirm here intentionally does nothing yet beyond
          closing the dialog, until deletion is actually designed. */}
      <Modal opened={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete document" radius="lg">
        <Stack gap="lg">
          <Text>Are you sure you want to delete {deleteTarget?.filename}?</Text>
          <Group justify="flex-end">
            <Button variant="subtle" color="signalBlue" radius="xl" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="filled" color="alertMagenta" radius="xl" onClick={() => setDeleteTarget(null)}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={overwriteTarget !== null}
        onClose={() => setOverwriteTarget(null)}
        title="Overwrite document"
        radius="lg"
      >
        <Stack gap="lg">
          <Text>A document named {overwriteTarget?.name} already exists - overwrite it?</Text>
          <Group justify="flex-end">
            <Button variant="subtle" color="signalBlue" radius="xl" onClick={() => setOverwriteTarget(null)}>
              Cancel
            </Button>
            <Button variant="filled" color="sparkOrange" radius="xl" onClick={handleConfirmOverwrite}>
              Overwrite
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}
