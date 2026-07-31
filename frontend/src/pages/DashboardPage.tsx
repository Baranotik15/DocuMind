import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { Stack, Table, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import type { DashboardEvent } from '../api/types'

export function DashboardPage(): JSX.Element {
  const [events, setEvents] = useState<DashboardEvent[]>([])

  useEffect(() => {
    void apiClient.getDashboardEvents().then(setEvents)
  }, [])

  return (
    <Stack gap="md">
      <Title order={2}>Dashboard</Title>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Timestamp</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Detail</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((event) => (
            <Table.Tr key={event.id}>
              <Table.Td>{event.timestamp}</Table.Td>
              <Table.Td>{event.type}</Table.Td>
              <Table.Td>{event.detail}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  )
}
