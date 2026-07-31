import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { FileInput, Stack, Table, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import type { DocumentSummary } from '../api/types'

export function UploadPage(): JSX.Element {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])

  useEffect(() => {
    void apiClient.listDocuments().then(setDocuments)
  }, [])

  async function handleFileChange(file: File | null): Promise<void> {
    if (!file) {
      return
    }

    const uploaded = await apiClient.uploadDocument(file)
    setDocuments((current) => [...current, uploaded])
  }

  return (
    <Stack gap="md">
      <Title order={2}>Upload</Title>

      <FileInput label="Upload document" placeholder="Choose a file" onChange={handleFileChange} clearable />

      <Table>
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
              <Table.Td>{document.filename}</Table.Td>
              <Table.Td>{document.status}</Table.Td>
              <Table.Td>{document.uploadedAt}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  )
}
