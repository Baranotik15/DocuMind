import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { Box, Button, Group, Select, Stack, Textarea, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import type { Chunk, DocumentSummary } from '../api/types'

export function ChunksPage(): JSX.Element {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [chunks, setChunks] = useState<Chunk[]>([])

  useEffect(() => {
    void apiClient.listDocuments().then((fetchedDocuments) => {
      setDocuments(fetchedDocuments)
      if (fetchedDocuments.length > 0) {
        setSelectedDocumentId(fetchedDocuments[0].id)
      }
    })
  }, [])

  useEffect(() => {
    if (!selectedDocumentId) {
      setChunks([])
      return
    }

    void apiClient.getChunks(selectedDocumentId).then(setChunks)
  }, [selectedDocumentId])

  function handleChunkChange(chunkId: string, value: string): void {
    setChunks((current) =>
      current.map((chunk) =>
        chunk.id === chunkId
          ? { ...chunk, editedContent: value, isDirty: value !== chunk.originalContent }
          : chunk,
      ),
    )
  }

  async function handleSave(): Promise<void> {
    if (!selectedDocumentId) {
      return
    }

    await apiClient.saveChunks(selectedDocumentId, chunks)
  }

  return (
    <Stack gap="md" maw={900}>
      <Title order={2}>Chunks</Title>

      <Select
        label="Document"
        placeholder="Choose a document"
        data={documents.map((document) => ({ value: document.id, label: document.filename }))}
        value={selectedDocumentId}
        onChange={setSelectedDocumentId}
        allowDeselect={false}
      />

      <Stack gap="sm">
        {chunks.map((chunk) => (
          // The amber left border is DocuMind's "signature mark" - it appears
          // if, and only if, this chunk has unsaved edits (isDirty). It is
          // never used as a background fill, only this thin structural mark.
          <Box
            key={chunk.id}
            p="sm"
            bdrs="sm"
            style={{
              borderLeft: `3px solid ${chunk.isDirty ? 'var(--mantine-color-markAmber-6)' : 'transparent'}`,
            }}
          >
            <Textarea
              label={chunk.id}
              value={chunk.editedContent}
              onChange={(event) => handleChunkChange(chunk.id, event.currentTarget.value)}
              minRows={2}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
          </Box>
        ))}
      </Stack>

      <Group>
        <Button onClick={() => void handleSave()} disabled={!selectedDocumentId}>
          Save
        </Button>
      </Group>
    </Stack>
  )
}
