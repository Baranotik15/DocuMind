import type { JSX } from 'react'

import { useEffect, useMemo, useState } from 'react'

import { Box, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import type { DashboardEvent, DocumentSummary } from '../api/types'

interface StatCardProps {
  label: string
  value: number
}

/** Large-number stat card - the one place in the app that gets an explicit "big number" treatment, per the design brief. */
function StatCard({ label, value }: StatCardProps): JSX.Element {
  return (
    <Paper radius="lg" p="lg" bg="var(--doc-surface)" style={{ border: '1px solid var(--doc-hairline)' }}>
      <Stack gap={4}>
        <Text size="sm" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.04em' }}>
          {label}
        </Text>
        <Text fw={700} style={{ fontSize: '3rem', lineHeight: 1.1 }}>
          {value}
        </Text>
      </Stack>
    </Paper>
  )
}

// No charting library dependency (recharts/visx/chart.js/...) is introduced
// here - a handful of styled Box/Group elements is enough to render a small,
// fixed number of "events by type" bars, per the YAGNI rationale in
// .claude/plans/2026-07-31-phase-1-frontend-shell.md's Task 6 (charts are a
// later, dedicated feature if the real backend ever needs one).
const BAR_COLORS = ['var(--mantine-color-signalBlue-6)', 'var(--mantine-color-sparkOrange-6)']
const BAR_GLOWS = ['0 0 12px rgba(61, 107, 255, 0.55)', '0 0 12px rgba(255, 138, 0, 0.65)']

export function DashboardPage(): JSX.Element {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [events, setEvents] = useState<DashboardEvent[]>([])

  useEffect(() => {
    void apiClient.listDocuments().then(setDocuments)
    void apiClient.getDashboardEvents().then(setEvents)
  }, [])

  const eventsByType = useMemo(() => {
    const counts = new Map<string, number>()
    for (const event of events) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    }
    return Array.from(counts.entries())
  }, [events])

  const maxEventTypeCount = Math.max(1, ...eventsByType.map(([, count]) => count))

  return (
    <Stack gap="xl">
      <Title order={2}>Logs & Stats</Title>

      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg">
        <StatCard label="Documents" value={documents.length} />
        <StatCard label="Events" value={events.length} />
        <StatCard label="Event types" value={eventsByType.length} />
      </SimpleGrid>

      <Stack gap="sm">
        <Title order={4}>Events by type</Title>

        {eventsByType.length === 0 ? (
          <Text c="dimmed">No events yet.</Text>
        ) : (
          <Stack gap="sm">
            {eventsByType.map(([type, count], index) => {
              const colorIndex = index % BAR_COLORS.length
              return (
                <Group key={type} gap="md" wrap="nowrap">
                  <Text ff="monospace" size="sm" c="dimmed" w={220} style={{ flexShrink: 0 }}>
                    {type}
                  </Text>
                  <Box
                    style={{
                      flex: 1,
                      backgroundColor: 'rgba(232, 237, 250, 0.06)',
                      borderRadius: 'var(--mantine-radius-xl)',
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      h={18}
                      style={{
                        width: `${(count / maxEventTypeCount) * 100}%`,
                        minWidth: 10,
                        borderRadius: 'var(--mantine-radius-xl)',
                        backgroundColor: BAR_COLORS[colorIndex],
                        boxShadow: BAR_GLOWS[colorIndex],
                        transition: 'width 200ms ease',
                      }}
                    />
                  </Box>
                  <Text fw={700} size="md" w={32} ta="right">
                    {count}
                  </Text>
                </Group>
              )
            })}
          </Stack>
        )}
      </Stack>

      <Table fz="md" verticalSpacing="sm">
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
              <Table.Td ff="monospace">{event.timestamp}</Table.Td>
              <Table.Td ff="monospace">{event.type}</Table.Td>
              <Table.Td>{event.detail}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  )
}
