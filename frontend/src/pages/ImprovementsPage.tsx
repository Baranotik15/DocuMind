import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { ActionIcon, Box, Button, Group, Paper, Stack, Table, Text, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import type { DislikedMessage, ImprovementsRange, NoAnswerMessage } from '../api/types'
import { SegmentedToggle } from '../components/SegmentedToggle'
import { formatDateTime } from '../utils/formatDateTime'

type ImprovementsTab = 'lists' | 'analysis'

// Same loadActiveTab/saveActiveTab-to-localStorage idiom as DashboardPage.tsx's
// own Stats/Logs tab - a dedicated key so it never collides with that page's
// own ACTIVE_TAB_STORAGE_KEY.
const ACTIVE_TAB_STORAGE_KEY = 'documind:improvements:activeTab'

function loadActiveTab(): ImprovementsTab {
  try {
    const raw = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)
    return raw === 'lists' || raw === 'analysis' ? raw : 'lists'
  } catch {
    return 'lists'
  }
}

function saveActiveTab(tab: ImprovementsTab): void {
  try {
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab)
  } catch {
    // Failing to persist just means the choice won't survive a reload - not
    // worth surfacing to the user over.
  }
}

// Shared by both list panels' own time-range toggle - independent of
// DashboardStatsRange (a different, unrelated set of string values).
const RANGE_OPTIONS: { value: ImprovementsRange; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'day', label: 'Day' },
  { value: '7days', label: '7 Days' },
  { value: '30days', label: '30 Days' },
]

// The Lists sub-tab's two panels stretch down to roughly this much of the
// viewport height - deliberately short of 100% so the panels visibly stop
// before the very bottom of the page rather than flushing against it.
const PANEL_AREA_HEIGHT = '80vh'

/** Plain "x" glyph - same no-icon-library rationale as this app's other hand-rolled SVGs (see UploadPage.tsx's ClearIcon/TrashIcon). Used for both panels' own per-row remove action - removal here never deletes anything (just un-flags it), so a lighter "dismiss" glyph reads more accurately than a trash can. */
function RemoveIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

/** Minimal shape shared by both DislikedMessage and NoAnswerMessage - everything ImprovementsListPanel itself actually reads off an entry, regardless of which endpoint it came from. */
interface ImprovementsEntry {
  id: string
  content: string
  questionContent: string | null
}

interface ImprovementsListPanelProps<T extends ImprovementsEntry> {
  title: string
  /** A stable apiClient method reference (e.g. `apiClient.getDislikedMessages`) - passed as-is (not wrapped in a new arrow function per render) so this panel's own fetch effect below can safely depend on it without refetching on every render. */
  fetchList: (range: ImprovementsRange) => Promise<T[]>
  /** Same stable-reference requirement as fetchList - `apiClient.dislikeMessage` (toggles disliked back off) for the Dislikes panel, `apiClient.dismissNoAnswerMessage` (one-way) for the No Answer panel. */
  removeEntry: (id: string) => Promise<void>
  getTimestamp: (item: T) => string
  timestampLabel: string
  emptyMessage: string
  removeAriaLabel: string
}

/**
 * One of the two Lists sub-tab panels (Dislikes, No Answer) - its own
 * Day/7 Days/30 Days/All time SegmentedToggle drives its own fetch,
 * entirely independent of the other panel. Removing a row calls `removeEntry`
 * then filters it out of local state immediately (optimistic - same idiom as
 * UploadPage.tsx's attemptDelete) rather than waiting on a refetch; removal
 * here is lower-stakes than Upload's delete (nothing is deleted, just
 * un-flagged), so there's no confirm modal.
 */
function ImprovementsListPanel<T extends ImprovementsEntry>({
  title,
  fetchList,
  removeEntry,
  getTimestamp,
  timestampLabel,
  emptyMessage,
  removeAriaLabel,
}: ImprovementsListPanelProps<T>): JSX.Element {
  const [range, setRange] = useState<ImprovementsRange>('all')
  const [items, setItems] = useState<T[]>([])

  useEffect(() => {
    let cancelled = false
    void fetchList(range).then((result) => {
      if (!cancelled) {
        setItems(result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [fetchList, range])

  async function handleRemove(id: string): Promise<void> {
    await removeEntry(id)
    setItems((current) => current.filter((item) => item.id !== id))
  }

  return (
    // height: '100%' + flex column - fills whatever height the page-level
    // Group hands it (see ImprovementsPage's own PANEL_AREA_HEIGHT below),
    // with only the scroll area (the Box below) growing/scrolling - the
    // header (title + range toggle) stays put at a fixed natural height,
    // same split DashboardPage.tsx's Logs tab uses for its own filter row
    // vs. table.
    <Paper
      radius="lg"
      p="md"
      bg="var(--doc-surface)"
      withBorder
      style={{ boxShadow: '0 24px 48px -24px rgba(0, 0, 0, 0.55)', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <Stack gap="md" style={{ height: '100%', minHeight: 0 }}>
        <Group justify="space-between" align="center" wrap="wrap">
          <Title order={3}>{title}</Title>
          <SegmentedToggle options={RANGE_OPTIONS} value={range} onChange={setRange} />
        </Group>

        {/* minHeight: 0 is load-bearing (not decorative) - a flex item's
            default min-height is `auto` (its content's natural size), which
            for a potentially-tall table would push this box past its `flex:
            1` share instead of actually scrolling internally.
            `overflowY: auto` is what puts the app-wide custom scrollbar
            (global.css) on THIS box specifically, rather than the whole
            page scrolling. */}
        <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {items.length === 0 ? (
            <Box style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Text c="dimmed" ta="center">
                {emptyMessage}
              </Text>
            </Box>
          ) : (
            <Table fz="md" verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Question</Table.Th>
                  <Table.Th>Reply</Table.Th>
                  <Table.Th>{timestampLabel}</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((item) => (
                  <Table.Tr key={item.id}>
                    <Table.Td c={item.questionContent ? undefined : 'dimmed'}>{item.questionContent ?? '—'}</Table.Td>
                    <Table.Td>{item.content}</Table.Td>
                    <Table.Td ff="monospace">{formatDateTime(getTimestamp(item))}</Table.Td>
                    <Table.Td>
                      <ActionIcon
                        size="lg"
                        aria-label={removeAriaLabel}
                        variant="subtle"
                        color="alertMagenta"
                        onClick={() => void handleRemove(item.id)}
                      >
                        <RemoveIcon />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Box>
      </Stack>
    </Paper>
  )
}

function getDislikedAt(item: DislikedMessage): string {
  return item.dislikedAt
}

function getCreatedAt(item: NoAnswerMessage): string {
  return item.createdAt
}

/**
 * Sub-tab 2's placeholder shell - a future documentation-gap-analysis
 * feature, not implemented yet (see .claude/specs/improvements-page.md's
 * Non-Goals). `disabled` (and no `onClick` at all) makes it visibly read as
 * "not wired up yet" rather than a button that silently does nothing.
 */
function AnalysisPlaceholder(): JSX.Element {
  return (
    <Paper radius="lg" p="xl" bg="var(--doc-surface)" withBorder style={{ boxShadow: '0 24px 48px -24px rgba(0, 0, 0, 0.55)' }}>
      <Stack gap="md" align="center" py="xl">
        <Title order={3}>Documentation Gap Analysis</Title>
        <Text c="dimmed" ta="center" maw={480}>
          Automatically review dislikes and no-answer questions to suggest documentation improvements. Not available yet.
        </Text>
        <Button variant="filled" color="sparkOrange" radius="xl" disabled>
          Analyze with AI
        </Button>
      </Stack>
    </Paper>
  )
}

export function ImprovementsPage(): JSX.Element {
  const [activeTab, setActiveTabState] = useState<ImprovementsTab>(loadActiveTab)

  function setActiveTab(tab: ImprovementsTab): void {
    setActiveTabState(tab)
    saveActiveTab(tab)
  }

  return (
    <Stack gap="xl">
      <SegmentedToggle
        options={[
          { value: 'lists' as const, label: 'Lists' },
          { value: 'analysis' as const, label: 'Analysis' },
        ]}
        value={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'lists' ? (
        // Stretched down toward the bottom of the page (vh-based, not a
        // literal 100% - PANEL_AREA_HEIGHT deliberately stops short so the
        // page itself never needs to scroll, only each panel's own content
        // area does - see ImprovementsListPanel's own overflowY: auto box).
        // align="stretch" (not flex-start) is what makes each panel's own
        // height: '100%' actually resolve to something - Side by side (not
        // stacked) on wide viewports; wrap="wrap" still stacks them on a
        // narrow viewport rather than squeezing the table illegibly.
        <Group align="stretch" gap="xl" wrap="wrap" style={{ height: PANEL_AREA_HEIGHT }}>
          <Box style={{ flex: 1, minWidth: 420, height: '100%' }}>
            <ImprovementsListPanel<DislikedMessage>
              title="Dislikes"
              fetchList={apiClient.getDislikedMessages}
              removeEntry={apiClient.dislikeMessage}
              getTimestamp={getDislikedAt}
              timestampLabel="Disliked At"
              emptyMessage="There are no dislikes yet."
              removeAriaLabel="Remove from Dislikes"
            />
          </Box>
          <Box style={{ flex: 1, minWidth: 420, height: '100%' }}>
            <ImprovementsListPanel<NoAnswerMessage>
              title="No Answer"
              fetchList={apiClient.getNoAnswerMessages}
              removeEntry={apiClient.dismissNoAnswerMessage}
              getTimestamp={getCreatedAt}
              timestampLabel="No Answer At"
              emptyMessage="There are no messages the bot couldn't answer yet."
              removeAriaLabel="Remove from No Answer"
            />
          </Box>
        </Group>
      ) : (
        <AnalysisPlaceholder />
      )}
    </Stack>
  )
}
