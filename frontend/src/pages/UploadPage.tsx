import type { FileWithPath } from '@mantine/dropzone'
import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { ActionIcon, Alert, Button, Group, Modal, Stack, Table, Text, Title } from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import { useNavigate } from 'react-router-dom'

import classes from './UploadPage.module.css'
import { apiClient } from '../api/client'
import { ApiConflictError } from '../api/httpClient'
import type { DocumentSummary } from '../api/types'

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
  const navigate = useNavigate()

  useEffect(() => {
    void apiClient.listDocuments().then(setDocuments)
  }, [])

  async function attemptUpload(file: File, overwrite: boolean): Promise<void> {
    try {
      const uploaded = await apiClient.uploadDocument(file, overwrite)
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
            <Table.Th>Filename</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Uploaded at</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {documents.map((document) => (
            <Table.Tr key={document.id}>
              <Table.Td ff="monospace">{document.filename}</Table.Td>
              <Table.Td ff="monospace">{document.status}</Table.Td>
              <Table.Td ff="monospace">{document.uploadedAt}</Table.Td>
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
          ))}
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
