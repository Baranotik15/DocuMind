import type { FileWithPath } from '@mantine/dropzone'
import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { Group, Stack, Table, Text, Title } from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'

import classes from './UploadPage.module.css'
import { apiClient } from '../api/client'
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

export function UploadPage(): JSX.Element {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])

  useEffect(() => {
    void apiClient.listDocuments().then(setDocuments)
  }, [])

  async function handleFilesDrop(files: FileWithPath[]): Promise<void> {
    const file = files[0]
    if (!file) {
      return
    }

    const uploaded = await apiClient.uploadDocument(file)
    setDocuments((current) => [...current, uploaded])
  }

  return (
    <Stack gap="xl">
      <Title order={2}>Upload</Title>

      <Dropzone
        onDrop={(files) => void handleFilesDrop(files)}
        multiple={false}
        maxFiles={1}
        radius="lg"
        p="xl"
        acceptColor="sparkOrange"
        rejectColor="alertMagenta"
        classNames={{ root: classes.dropzone }}
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

      <Table fz="md" verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Filename</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Uploaded at</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {documents.map((document) => (
            <Table.Tr key={document.id}>
              <Table.Td ff="monospace">{document.filename}</Table.Td>
              <Table.Td ff="monospace">{document.status}</Table.Td>
              <Table.Td ff="monospace">{document.uploadedAt}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  )
}
