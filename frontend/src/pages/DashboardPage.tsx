import type { JSX } from 'react'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { Box, Button, Group, Paper, SimpleGrid, Stack, Table, Text, TextInput, Title, UnstyledButton } from '@mantine/core'
import { DateInput, TimePicker } from '@mantine/dates'

import { ChunkGraphPanel } from './ChunkGraphPanel'
import classes from './DashboardPage.module.css'
import { apiClient } from '../api/client'
import type { DashboardEvent, DashboardStats, DashboardStatsBucket, DashboardStatsRange } from '../api/types'
import { formatDateTime } from '../utils/formatDateTime'

type DashboardTab = 'logs' | 'stats'

// Remembers which tab was selected last, the same localStorage persistence
// pattern as ChatPage's hidden-message-ids and RelevancePage's last search -
// survives navigating away (the route unmounts this page) and a reload.
const ACTIVE_TAB_STORAGE_KEY = 'documind:dashboard:activeTab'

function loadActiveTab(): DashboardTab {
  try {
    const raw = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)
    return raw === 'logs' || raw === 'stats' ? raw : 'stats'
  } catch {
    return 'stats'
  }
}

function saveActiveTab(tab: DashboardTab): void {
  try {
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab)
  } catch {
    // Failing to persist just means the choice won't survive a reload -
    // not worth surfacing to the user over.
  }
}

interface TabButtonProps {
  label: string
  isActive: boolean
  onClick: () => void
}

/**
 * Reuses the app's one "active" glow device (`--doc-mark-glow` +
 * `sparkOrange`, see AppLayout's active nav link) instead of inventing a new
 * one - filled yellow-gold with an outer glow when selected, muted/no-glow
 * otherwise. `radius={0}` deliberately - this button fills its entire half
 * of the shared toggle edge-to-edge (see the wrapping Paper below, which
 * clips the two halves to its own rounded outline via `overflow: hidden`)
 * rather than floating as a smaller pill/circle inside a padded card.
 */
function TabButton({ label, isActive, onClick }: TabButtonProps): JSX.Element {
  return (
    <Button
      onClick={onClick}
      aria-pressed={isActive}
      variant={isActive ? 'filled' : 'subtle'}
      color="sparkOrange"
      radius={0}
      px="lg"
      className={classes.tabButton}
      style={{
        boxShadow: isActive ? 'var(--doc-mark-glow)' : 'none',
        color: isActive ? undefined : 'var(--doc-text-muted)',
      }}
    >
      {label}
    </Button>
  )
}

interface SegmentedToggleProps<T extends string> {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

/**
 * Generalizes the Stats/Logs toggle's own one shared Paper + hairline
 * dividers + TabButton device to any number of options (used here for that
 * 2-option toggle and for the 4-option Day/7 Days/Month/Year range toggle
 * below) - same edge-to-edge fill, only the Paper's own outer corners
 * rounded via `overflow: hidden`.
 */
function SegmentedToggle<T extends string>({ options, value, onChange }: SegmentedToggleProps<T>): JSX.Element {
  return (
    <Paper
      radius="lg"
      p={0}
      bg="var(--doc-surface)"
      withBorder
      style={{ boxShadow: '0 10px 20px -12px rgba(0, 0, 0, 0.5)', alignSelf: 'flex-start', overflow: 'hidden' }}
    >
      <Group gap={0} wrap="nowrap">
        {options.map((option, index) => (
          <Fragment key={option.value}>
            {index > 0 ? <Box aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', backgroundColor: 'var(--doc-hairline)' }} /> : null}
            <TabButton label={option.label} isActive={value === option.value} onClick={() => onChange(option.value)} />
          </Fragment>
        ))}
      </Group>
    </Paper>
  )
}

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

const STATS_RANGE_OPTIONS: { value: DashboardStatsRange; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: '7days', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
]

// How often the Stats tab's numbers/charts refresh themselves - frequent
// enough to feel live, not so frequent it hammers the backend for an
// internal admin dashboard's data volume.
const STATS_POLL_INTERVAL_MS = 10_000

/**
 * Bucket label shown under each bar - derived from `bucketStart` (a UTC ISO
 * timestamp the backend returns) in the viewer's own local time/locale via
 * `Intl.DateTimeFormat`, not hardcoded. Matches each range's own bucket
 * width (see GET /internal/dashboard/stats's contract): a 2-hour bucket
 * gets a clock time, a 1-day bucket gets a weekday, a 7-day bucket gets its
 * start date, a 1-month bucket gets a month name.
 */
function formatBucketLabel(bucketStart: string, range: DashboardStatsRange): string {
  const date = new Date(bucketStart)
  switch (range) {
    case 'day':
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
    case '7days':
      return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date)
    case 'month':
      return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit' }).format(date)
    case 'year':
      return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date)
  }
}

interface StatsBarChartProps {
  title: string
  data: DashboardStatsBucket[]
  range: DashboardStatsRange
  color: string
  glow: string
}

/**
 * A small hand-rolled vertical bar chart (no charting library, same YAGNI
 * rationale as the horizontal "events by type" bars below) - Grafana-styled:
 * dark panel, a glowing single-hue bar per bucket, the count above each bar,
 * a time label below, per explicit request ("grafana style, our palette").
 * Bar heights scale against the tallest bucket currently in `data`, with a
 * minimum sliver height so a genuine zero-count bucket still reads as
 * "present" (a real empty bar) rather than invisible.
 */
function StatsBarChart({ title, data, range, color, glow }: StatsBarChartProps): JSX.Element {
  const max = Math.max(1, ...data.map((bucket) => bucket.count))
  return (
    <Stack gap="sm">
      <Title order={4}>{title}</Title>
      <Group align="flex-end" gap="xs" wrap="nowrap" style={{ height: 160 }}>
        {data.map((bucket) => (
          <Stack key={bucket.bucketStart} gap={4} align="center" style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}>
            <Text size="xs" c="dimmed">
              {bucket.count}
            </Text>
            <Box
              style={{
                width: '100%',
                height: `${Math.max(4, (bucket.count / max) * 110)}px`,
                borderRadius: '4px 4px 0 0',
                backgroundColor: color,
                boxShadow: glow,
                transition: 'height 200ms ease',
              }}
            />
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {formatBucketLabel(bucket.bucketStart, range)}
            </Text>
          </Stack>
        ))}
      </Group>
    </Stack>
  )
}

// Caps how many event rows render at once on the Logs tab - an unbounded
// list grows the page tall enough to need a scrollbar as events pile up.
// Same Previous/Next + "Page X of Y" device as ChunkPreviewPage's own
// pagination (hidden entirely at one page, hidden - not disabled - at each
// boundary). The table itself also sits in its own fixed-height, custom-
// scrolled frame (see the Logs branch below) - between the two, a page
// never needs the page's own scrollbar to reach every row.
const LOGS_PAGE_SIZE = 20

// The Logs tab only cares about file-affecting activity - uploads, deletes,
// and (re)chunking - not every dashboard_events row. Every event type the
// backend ever records (see app/events.py's call sites: pipeline.py,
// routers/documents.py, routers/chat.py) is either "document.*" (uploaded/
// deleted/chunking_started/chunking_succeeded/chunking_failed - manual chunk
// edits from ChunkPreviewPage's Save re-run the same chunking pipeline, so
// they're already covered here too) or "chat.*" (chat.message_sent) -
// prefix-matching "document." is exactly this split, with no per-type
// allowlist to keep in sync if a new document.* event type is ever added.
// The Stats tab's own counts deliberately still use the full, unfiltered
// `events` list below - this restriction is Logs-only.
const LOG_EVENT_TYPE_PREFIX = 'document.'

/** Up/down arrow, same stroke/viewBox convention as ChunkPreviewPage's UndoIcon/RedoIcon - no icon library in this app (see design-principles.md). Only rendered inline in the Timestamp header when a sort direction is actually active - see cycleLogsSortDirection below. */
function SortDirectionIcon({ direction }: { direction: 'asc' | 'desc' }): JSX.Element {
  return direction === 'asc' ? (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  )
}

interface DateTimeFieldProps {
  /** Visible text above the shared card, e.g. "From date". */
  label: string
  /** Short prefix for the inner fields' own accessible names, e.g. "From" - kept separate from `label` so those names read "From date"/"From time"/"From hours" rather than duplicating "date" onto an already-"date"-suffixed label. */
  name: string
  dateValue: string | null
  onDateChange: (value: string | null) => void
  timeValue: string | null
  onTimeChange: (value: string | null) => void
}

/**
 * From/To as one shared card (one background, one border) rather than the
 * date and time inputs each carrying their own separate background - only a
 * single visible label sits above the pair, per explicit request. Each
 * inner field keeps its own accessible name via `aria-label` (DateInput) /
 * `hoursInputLabel`+`minutesInputLabel` (TimePicker) even though neither
 * renders its own visible label text anymore - both are `variant="unstyled"`
 * so they have no background/border of their own and sit flush inside the
 * shared Group's background.
 */
function DateTimeField({ label, name, dateValue, onDateChange, timeValue, onTimeChange }: DateTimeFieldProps): JSX.Element {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={600} c="dimmed" pl={4}>
        {label}
      </Text>
      <Group
        gap={0}
        wrap="nowrap"
        bg="var(--doc-surface)"
        style={{ border: '1px solid var(--doc-hairline)', borderRadius: 'var(--mantine-radius-lg)', overflow: 'hidden' }}
      >
        <DateInput
          aria-label={`${name} date`}
          variant="unstyled"
          placeholder="DD.MM.YYYY"
          valueFormat="DD.MM.YYYY"
          clearable
          value={dateValue}
          onChange={onDateChange}
          px="sm"
          style={{ width: 130 }}
        />
        <Box aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', backgroundColor: 'var(--doc-hairline)' }} />
        <TimePicker
          aria-label={`${name} time`}
          variant="unstyled"
          withDropdown
          clearable
          value={timeValue ?? ''}
          onChange={(value) => onTimeChange(value || null)}
          hoursInputLabel={`${name} hours`}
          minutesInputLabel={`${name} minutes`}
          px="sm"
        />
      </Group>
    </Stack>
  )
}

export function DashboardPage(): JSX.Element {
  const [activeTab, setActiveTabState] = useState<DashboardTab>(loadActiveTab)
  const [events, setEvents] = useState<DashboardEvent[]>([])
  // Shared by both the "Messages sent" and "Dislikes" bar charts below - one
  // toggle controls both at once, per explicit request.
  const [statsRange, setStatsRange] = useState<DashboardStatsRange>('day')
  const [stats, setStats] = useState<DashboardStats | null>(null)
  // Реальная измеренная высота левой колонки (Messages sent + Dislikes) -
  // единственный источник высоты для 3D-панели справа, см. ResizeObserver
  // ниже и Paper, которому эта высота выставляется напрямую через style.
  // Стартовое значение 260 - грубая оценка на первый кадр, пока обсервер
  // ещё не сработал; не критично, тут же переопределяется реальным числом.
  const chartsColumnRef = useRef<HTMLDivElement>(null)
  const [chartsColumnHeight, setChartsColumnHeight] = useState(260)
  const [logsPageIndex, setLogsPageIndex] = useState(0)
  const [logsSearchQuery, setLogsSearchQuery] = useState('')
  // null = unsorted (the order the backend returned) - clicking the
  // Timestamp header cycles null -> desc -> asc -> null, see
  // cycleLogsSortDirection.
  const [logsSortDirection, setLogsSortDirection] = useState<'asc' | 'desc' | null>(null)
  // Date and time are two separate, independently typable-or-pickable
  // fields per boundary (DateInput has its own typable text + calendar
  // popover; TimePicker has its own typable hour/minute segments + dropdown
  // - see the Logs branch below) rather than one combined date-time
  // control, per explicit request. A boundary with a date but no time
  // defaults that time to midnight (00:00) when combined for filtering.
  const [logsFromDate, setLogsFromDate] = useState<string | null>(null)
  const [logsFromTime, setLogsFromTime] = useState<string | null>(null)
  const [logsToDate, setLogsToDate] = useState<string | null>(null)
  const [logsToTime, setLogsToTime] = useState<string | null>(null)
  // The search/date-range fields above are a *draft* - what the Search
  // button (or Enter in the search field) actually filters by is this
  // separate snapshot, only updated on demand. This lets someone set up
  // search text plus a whole date range before the list changes even once,
  // rather than the table re-filtering (and pagination resetting) on every
  // keystroke. Sort direction has no such staging - clicking the Timestamp
  // header is already one deliberate action, so it stays live.
  const [appliedLogsFilters, setAppliedLogsFilters] = useState({
    query: '',
    fromDate: null as string | null,
    fromTime: null as string | null,
    toDate: null as string | null,
    toTime: null as string | null,
  })

  function setActiveTab(tab: DashboardTab): void {
    setActiveTabState(tab)
    saveActiveTab(tab)
  }

  function cycleLogsSortDirection(): void {
    setLogsSortDirection((direction) => {
      if (direction === null) {
        return 'desc'
      }
      return direction === 'desc' ? 'asc' : null
    })
  }

  function applyLogsFilters(): void {
    setAppliedLogsFilters({
      query: logsSearchQuery,
      fromDate: logsFromDate,
      fromTime: logsFromTime,
      toDate: logsToDate,
      toTime: logsToTime,
    })
    setLogsPageIndex(0)
  }

  function clearAllLogsFilters(): void {
    setLogsSearchQuery('')
    setLogsSortDirection(null)
    setLogsFromDate(null)
    setLogsFromTime(null)
    setLogsToDate(null)
    setLogsToTime(null)
    setAppliedLogsFilters({ query: '', fromDate: null, fromTime: null, toDate: null, toTime: null })
  }

  const hasActiveLogsFilters =
    appliedLogsFilters.query !== '' ||
    logsSortDirection !== null ||
    appliedLogsFilters.fromDate !== null ||
    appliedLogsFilters.fromTime !== null ||
    appliedLogsFilters.toDate !== null ||
    appliedLogsFilters.toTime !== null

  useEffect(() => {
    void apiClient.getDashboardEvents().then(setEvents)
  }, [])

  // Polls GET /internal/dashboard/stats every STATS_POLL_INTERVAL_MS while
  // the Stats tab is actually visible - the stat cards and both bar charts
  // stay live without a manual reload, per explicit request. Scoped to
  // `activeTab === 'stats'` (rather than always polling in the background)
  // so switching to Logs stops the requests instead of wasting them on a
  // hidden tab. Refetches immediately on mount/range change too, not just
  // on the first interval tick. `cancelled` guards against a fetch that was
  // still in flight when the tab switched away (or the range changed again)
  // from clobbering newer state on a stale response.
  useEffect(() => {
    if (activeTab !== 'stats') {
      return
    }
    let cancelled = false
    function refresh(): void {
      void apiClient.getDashboardStats(statsRange).then((result) => {
        if (!cancelled) {
          setStats(result)
        }
      })
    }
    refresh()
    const intervalId = window.setInterval(refresh, STATS_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [activeTab, statsRange])

  // Меряем реальную высоту левой колонки с графиками и кладём её в state -
  // именно это число потом идёт напрямую в style Paper справа (см. JSX
  // ниже), а не через align="stretch"/CSS Grid auto-height. Это важно:
  // canvas внутри ChunkGraphPanel получает от 3d-force-graph НАСТОЯЩУЮ
  // пиксельную высоту через style (не проценты), а не через 100% - значит
  // любой механизм, который вычисляет высоту родителя "от содержимого"
  // (flex-стретч, grid auto-rows), обязательно учтёт эту высоту canvas'а
  // как часть intrinsic-размера Paper. Получается самоподдерживающийся
  // цикл: при первом монтировании контейнер ещё ничем не ограничен и
  // canvas читает clientHeight, близкий к высоте всего окна -> эта
  // огромная высота становится реальным пиксельным style у canvas ->
  // родительский Paper "естественно" вырастает под него -> это раздувает
  // высоту строки flex/grid -> в контейнер возвращается та же раздутая
  // высота -> ResizeObserver внутри ChunkGraphPanel не видит изменения,
  // потому что число уже "сошлось" само с собой. Проверено вживую через
  // Playwright: canvas стабильно получал ровно высоту вьюпорта (1000px).
  // Разрывает цикл только высота, которая вообще не зависит от Paper/
  // canvas - вот эта, измеренная с независимой левой колонки.
  useEffect(() => {
    const element = chartsColumnRef.current
    if (!element) {
      return
    }
    const resizeObserver = new ResizeObserver(([entry]) => {
      setChartsColumnHeight(entry.contentRect.height)
    })
    resizeObserver.observe(element)
    return () => {
      resizeObserver.disconnect()
    }
  }, [activeTab])

  // Search (Detail substring), From/To date-time range, and sort direction
  // all apply only within the Logs tab's own restricted event set (see
  // LOG_EVENT_TYPE_PREFIX above), never to the Stats tab's totals.
  const filteredLogsEvents = useMemo(() => {
    const query = appliedLogsFilters.query.trim().toLowerCase()
    const fromMs = appliedLogsFilters.fromDate
      ? new Date(`${appliedLogsFilters.fromDate}T${appliedLogsFilters.fromTime ?? '00:00'}:00`).getTime()
      : null
    const toMs = appliedLogsFilters.toDate
      ? new Date(`${appliedLogsFilters.toDate}T${appliedLogsFilters.toTime ?? '00:00'}:00`).getTime()
      : null

    const filtered = events.filter((event) => {
      if (!event.type.startsWith(LOG_EVENT_TYPE_PREFIX)) {
        return false
      }
      if (query && !event.detail.toLowerCase().includes(query)) {
        return false
      }
      const eventMs = new Date(event.timestamp).getTime()
      if (fromMs !== null && eventMs < fromMs) {
        return false
      }
      if (toMs !== null && eventMs > toMs) {
        return false
      }
      return true
    })

    if (logsSortDirection === null) {
      return filtered
    }
    return filtered.sort((a, b) => {
      const diff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      return logsSortDirection === 'asc' ? diff : -diff
    })
  }, [events, appliedLogsFilters, logsSortDirection])

  const totalLogsPages = Math.max(1, Math.ceil(filteredLogsEvents.length / LOGS_PAGE_SIZE))
  const clampedLogsPageIndex = Math.min(logsPageIndex, totalLogsPages - 1)
  const pageEvents = filteredLogsEvents.slice(
    clampedLogsPageIndex * LOGS_PAGE_SIZE,
    clampedLogsPageIndex * LOGS_PAGE_SIZE + LOGS_PAGE_SIZE,
  )

  return (
    <Stack gap="xl">
      <SegmentedToggle
        options={[
          { value: 'stats' as const, label: 'Stats' },
          { value: 'logs' as const, label: 'Logs' },
        ]}
        value={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'stats' ? (
        <>
          {/* All four cards below come from the polled GET
              /internal/dashboard/stats response (see the polling effect
              above), not a one-time fetch - they refresh themselves every
              STATS_POLL_INTERVAL_MS while this tab is visible. Users is
              hardcoded to 0 backend-side - there's no user/auth system in
              this app yet - not a display bug here. */}
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg">
            <StatCard label="Documents" value={stats?.totalDocuments ?? 0} />
            <StatCard label="Chunks" value={stats?.totalChunks ?? 0} />
            <StatCard label="Users" value={stats?.totalUsers ?? 0} />
            {/* All-time count - independent of the range toggle below,
                unlike the Dislikes bar chart's own dislikeBuckets. */}
            <StatCard label="Dislikes" value={stats?.totalDislikes ?? 0} />
          </SimpleGrid>

          {/* Messages sent + Dislikes, both bucketed the same way and
              sharing this one Day/7 Days/Month/Year toggle (per explicit
              request) - see StatsBarChart/formatBucketLabel above and
              GET /internal/dashboard/stats's bucket contract. */}
          <SegmentedToggle options={STATS_RANGE_OPTIONS} value={statsRange} onChange={setStatsRange} />

          {/* Messages/Dislikes слева, 3D-карта чанков (ChunkGraphPanel)
              справа - высота правой панели ДОЛЖНА приходить только от
              chartsColumnHeight (см. ResizeObserver-эффект выше), не от
              align="stretch"/CSS Grid auto-height - оба этих механизма
              вычисляют высоту "от содержимого", а содержимое справа
              (canvas) само получает свою высоту от контейнера, что и
              создаёт зацикливание, описанное в комментарии у эффекта.
              align="flex-start" здесь принципиален: без него Group
              растянула бы обе колонки на высоту друг друга ещё до того,
              как ResizeObserver успеет измерить настоящую высоту левой
              колонки. */}
          <Group align="flex-start" gap="md" wrap="wrap">
            <Stack ref={chartsColumnRef} gap="xl" style={{ flex: 1, minWidth: 280 }}>
              <StatsBarChart
                title="Messages sent"
                data={stats?.messageBuckets ?? []}
                range={statsRange}
                color="var(--mantine-color-signalBlue-6)"
                glow="0 0 12px rgba(61, 107, 255, 0.55)"
              />
              {/* alertMagenta - the same color the dislike button itself
                  uses everywhere else in this app (ChatPage), not an
                  arbitrary second hue. */}
              <StatsBarChart
                title="Dislikes"
                data={stats?.dislikeBuckets ?? []}
                range={statsRange}
                color="var(--mantine-color-alertMagenta-6)"
                glow="0 0 12px rgba(255, 61, 113, 0.55)"
              />
            </Stack>
            {/* Each node is a chunk, positioned by semantic similarity (the
                backend's UMAP projection of its embedding), colored and
                linked by source document - see ChunkGraphPanel. Mouse
                orbit/pan/zoom navigation is 3d-force-graph's own default,
                so a slightly tight column here is fine. */}
            {/* height: chartsColumnHeight - жёсткое число из state, а не
                auto/stretch/grid-row (см. комментарий у ResizeObserver-
                эффекта выше про зацикливание через canvas). Заголовок
                "3D Chunk Map" делит этот же бюджет высоты с самим 3D-видом
                (flexDirection: 'column' + Box{flex:1} ниже) - иначе высота
                правой колонки превысила бы chartsColumnHeight и снова
                перестала бы совпадать с колонкой графиков слева.
                overflow: hidden оставлен как страховка на случай
                кратковременного рассинхрона (например, если ChunkGraphPanel
                успевает отрисовать canvas на кадр раньше, чем применится
                новая высота) - без него контент мог бы на миг вылезти за
                рамки Paper вместо того, чтобы просто обрезаться. */}
            <Paper
              radius="lg"
              p="md"
              bg="var(--doc-surface)"
              withBorder
              style={{
                flex: 1.3,
                minWidth: 360,
                height: chartsColumnHeight,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--mantine-spacing-sm)',
                overflow: 'hidden',
              }}
            >
              <Title order={4}>3D Chunk Map</Title>
              {/* minHeight: 0 - a flex item's default min-height is `auto`
                  (its content's natural size), which for this WebGL canvas
                  wrapper would ignore `flex: 1`'s shrink and push the Paper
                  taller than chartsColumnHeight instead of sharing the
                  budget with the Title above it. */}
              <Box style={{ flex: 1, minHeight: 0 }}>
                <ChunkGraphPanel />
              </Box>
            </Paper>
          </Group>
        </>
      ) : (
        // Fixed at 80% of the viewport height (not a pixel value) so the
        // table reads as filling the same share of the page's bottom
        // portion at any browser zoom level - zoom scales the viewport
        // together with everything in it, so a vh-based size stays
        // proportionally correct instead of drifting like a fixed px height
        // would. Up to LOGS_PAGE_SIZE=20 full-text rows almost always
        // overflows that frame, so `overflowY: auto` (styled via
        // `classes.scrollArea` - the same custom-scrollbar device
        // ChatPage's own message list uses) on the inner table wrapper is
        // the primary mechanism here, not a fallback: it keeps the
        // scrollbar local to this panel instead of the whole page.
        <Box style={{ height: '80vh', display: 'flex', flexDirection: 'column', gap: 'var(--mantine-spacing-md)' }}>
          <Group gap="sm" wrap="wrap" align="flex-end">
            <TextInput
              aria-label="Search in details"
              placeholder="Search in details..."
              value={logsSearchQuery}
              onChange={(event) => setLogsSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  applyLogsFilters()
                }
              }}
              style={{ width: 520 }}
            />
            {/* Date and time as two separate typable-or-pickable fields
                (DateInput's own text + calendar dropdown; TimePicker's own
                hour/minute segments + dropdown) sharing one card background
                per boundary - see DateTimeField above. */}
            <DateTimeField label="From date" name="From" dateValue={logsFromDate} onDateChange={setLogsFromDate} timeValue={logsFromTime} onTimeChange={setLogsFromTime} />
            <DateTimeField label="To date" name="To" dateValue={logsToDate} onDateChange={setLogsToDate} timeValue={logsToTime} onTimeChange={setLogsToTime} />
            {/* Applies the search text + date range as a batch (see
                appliedLogsFilters) - set up the whole combination of
                filters above, then click once to get the matching list,
                rather than the table re-filtering after every keystroke. */}
            <Button variant="filled" color="sparkOrange" onClick={applyLogsFilters}>
              Search
            </Button>
            {hasActiveLogsFilters ? (
              <Button variant="filled" color="alertMagenta" onClick={clearAllLogsFilters}>
                Clear filters
              </Button>
            ) : null}
          </Group>

          <Box className={classes.scrollArea} style={{ flex: 1, overflowY: 'auto' }}>
            {filteredLogsEvents.length === 0 ? (
              <Box style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Text c="dimmed" ta="center" fw={600} style={{ fontSize: '2rem', maxWidth: '40rem' }}>
                  No matching entries found - try adjusting or clearing the filters above.
                </Text>
              </Box>
            ) : (
              <Table fz="md" verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>ID</Table.Th>
                    {/* Sortable by click (not a separate arrow button) - cycles
                        unsorted -> newest-first -> oldest-first -> unsorted
                        (cycleLogsSortDirection). `aria-sort` on the `<th>` is
                        the standard ARIA table-sorting convention; the actual
                        interactive element is the plain button inside it (a
                        `<th>` itself isn't natively clickable/focusable). The
                        direction arrow only renders once a sort is active. */}
                    <Table.Th aria-sort={logsSortDirection === 'asc' ? 'ascending' : logsSortDirection === 'desc' ? 'descending' : 'none'}>
                      <UnstyledButton onClick={cycleLogsSortDirection} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700 }}>
                        Timestamp
                        {logsSortDirection !== null ? <SortDirectionIcon direction={logsSortDirection} /> : null}
                      </UnstyledButton>
                    </Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Detail</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {pageEvents.map((event, index) => (
                    <Table.Tr key={event.id}>
                      {/* A plain running number (1, 2, 3, ...) across the whole
                          list, not the event's real UUID - continues across
                          pages (offset by clampedLogsPageIndex * LOGS_PAGE_SIZE)
                          rather than resetting to 1 on every page. */}
                      <Table.Td ff="monospace">{clampedLogsPageIndex * LOGS_PAGE_SIZE + index + 1}</Table.Td>
                      <Table.Td ff="monospace">{formatDateTime(event.timestamp)}</Table.Td>
                      <Table.Td ff="monospace">{event.type}</Table.Td>
                      <Table.Td className={classes.detailCell}>{event.detail}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Box>

          {totalLogsPages > 1 ? (
            <Group gap="md" justify="center">
              {clampedLogsPageIndex > 0 ? (
                <Button
                  className={classes.paginationButton}
                  variant="filled"
                  color="sparkOrange"
                  onClick={() => setLogsPageIndex((index) => index - 1)}
                >
                  Previous
                </Button>
              ) : null}
              <Text size="sm" c="dimmed">
                Page {clampedLogsPageIndex + 1} of {totalLogsPages}
              </Text>
              {clampedLogsPageIndex < totalLogsPages - 1 ? (
                <Button
                  className={classes.paginationButton}
                  variant="filled"
                  color="sparkOrange"
                  onClick={() => setLogsPageIndex((index) => index + 1)}
                >
                  Next
                </Button>
              ) : null}
            </Group>
          ) : null}
        </Box>
      )}
    </Stack>
  )
}
