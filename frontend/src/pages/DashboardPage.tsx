import type { JSX } from 'react'

import { useEffect, useMemo, useRef, useState } from 'react'

import { Box, Button, Group, Loader, Paper, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core'
import { DateInput, TimePicker } from '@mantine/dates'

import { ChunkGraphPanel } from './ChunkGraphPanel'
import classes from './DashboardPage.module.css'
import { apiClient } from '../api/client'
import type { DashboardEvent, DashboardStats, DashboardStatsBucket, DashboardStatsRange, OpenAiSpend } from '../api/types'
import { SegmentedToggle } from '../components/SegmentedToggle'
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

interface StatCardProps {
  label: string
  value: number
}

/** Large-number stat card - the one place in the app that gets an explicit "big number" treatment, per the design brief. Half its original size (padding/font) - per explicit request, so all four fit in half the page width next to the placeholder chart block below. */
function StatCard({ label, value }: StatCardProps): JSX.Element {
  return (
    <Paper radius="lg" p="sm" bg="var(--doc-surface)" style={{ border: '1px solid var(--doc-hairline)' }}>
      <Stack gap={2}>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.04em' }}>
          {label}
        </Text>
        <Text fw={700} style={{ fontSize: '1.5rem', lineHeight: 1.1 }}>
          {value}
        </Text>
      </Stack>
    </Paper>
  )
}

/** `$1.23`-style formatting for an OpenAiSpend amount, in whichever currency the backend reports (falls back to "usd" itself when there's no spend to read a currency off of - see OpenAiSpend's own doc comment). */
function formatSpendAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount)
}

/** `12,345`-style grouped-digit formatting for a token count - plain (no currency/units suffix), matching how this app already formats other large counts. */
function formatTokenCount(count: number): string {
  return new Intl.NumberFormat(undefined).format(count)
}

/** The OpenAI spend blocks' own Day/Week/Month/Year range - deliberately a separate type/state from DashboardStatsRange above (which spells its 7-day option "7days", the bucketed-chart key) rather than reusing it: OpenaiSpend's own rolling windows are keyed "week" (see OpenAiSpend/OpenAiSpendTokens), a different string, and the two toggles control entirely unrelated data (this range never triggers a refetch either - see its own effect below, it only picks which already-fetched window to display). */
type OpenAiSpendRange = 'day' | 'week' | 'month' | 'year'

const OPENAI_SPEND_RANGE_OPTIONS: { value: OpenAiSpendRange; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
]

interface SpendBlockProps {
  label: string
  /** Already-formatted display string (see formatSpendAmount/formatTokenCount) for the currently selected OpenAiSpendRange - callers pick which formatter, this component just centers/sizes whatever string it's handed. Ignored when `split` is given - only the Money Spend call site uses this prop; Tokens Spend uses `split` instead (see below). */
  value?: string
  /** When given, renders two side-by-side sub-values (each with its own small uppercase "Input"/"Output" label reusing this block's own top-level label styling below) instead of the single big `value` string - only the Tokens Spend call site passes this, per explicit request to split it into its input/output directions (see OpenAiSpendTokenWindow). Money Spend stays on the plain `value` prop, untouched. */
  split?: { input: string; output: string }
  configured: boolean
  /** True during the brief post-range-click delay (see handleSpendRangeChange) - swaps the number (or, with `split`, both sub-values together as one unit, not two separate spinners) for a same-height spinner so switching ranges doesn't just snap, purely cosmetic per explicit request. Never true on the initial fetch/unconfigured states, only on a later range change. */
  loading: boolean
}

/** One big-number block (tokens or money, picked by the caller) for the OpenAI spend area - a centered header (label, then a hairline divider - same `--doc-hairline` device as SegmentedToggle's own between-button dividers above), then either a single big centered number (Money Spend, via `value`) or Input/Output side by side under their OWN hairline divider (Tokens Spend, via `split`), per explicit request that both cards share the same header treatment. */
function SpendBlock({ label, value, split, configured, loading }: SpendBlockProps): JSX.Element {
  return (
    <Paper radius="lg" p="md" bg="var(--doc-surface)" withBorder style={{ flex: 1, minWidth: 140, display: 'flex' }}>
      <Stack gap="sm" style={{ width: '100%' }}>
        <Text ta="center" size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.04em' }}>
          {label}
        </Text>
        {configured ? (
          <>
            <Box aria-hidden="true" style={{ height: 1, width: '100%', backgroundColor: 'var(--doc-hairline)' }} />
            {loading ? (
              <Box style={{ height: '2.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Loader color="sparkOrange" size="sm" />
              </Box>
            ) : split ? (
              // NOT `grow` here - Group's `grow` prop distributes width
              // evenly across EVERY direct child, including the 1px
              // divider below, which would inflate it to a full third of
              // the row (a visibly wide gray block, not a hairline) -
              // `flex: 1` applied only to the two Stack columns below
              // achieves the same even 50/50 split without also
              // stretching the divider between them.
              <Group gap={0} wrap="nowrap" style={{ width: '100%' }}>
                <Stack gap={2} align="center" style={{ flex: 1 }}>
                  <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.04em' }}>
                    Input
                  </Text>
                  <Text fw={700} ta="center" style={{ fontSize: '1.5rem', lineHeight: 1.1 }}>
                    {split.input}
                  </Text>
                </Stack>
                <Box aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', backgroundColor: 'var(--doc-hairline)' }} />
                <Stack gap={2} align="center" style={{ flex: 1 }}>
                  <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.04em' }}>
                    Output
                  </Text>
                  <Text fw={700} ta="center" style={{ fontSize: '1.5rem', lineHeight: 1.1 }}>
                    {split.output}
                  </Text>
                </Stack>
              </Group>
            ) : (
              <Text fw={700} ta="center" style={{ fontSize: '2.5rem', lineHeight: 1.1 }}>
                {value}
              </Text>
            )}
          </>
        ) : (
          <Text size="xs" c="dimmed" ta="center">
            Admin key not configured
          </Text>
        )}
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

// A curated handful of IANA zone identifiers (not literal fixed-offset
// names like "EST" - those don't observe DST, which would silently drift
// wrong twice a year) covering the timezones an operator of this app is
// actually likely to want, per explicit request ("Kyiv, EST, etc."). The
// viewer's own local zone is added as the first/default option at render
// time (see DEFAULT_TIMEZONE below) rather than listed here, so it's never
// duplicated if it happens to already be one of these.
const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Europe/Kyiv', label: 'Kyiv' },
  { value: 'America/New_York', label: 'Eastern - EST/EDT (New York)' },
  { value: 'America/Los_Angeles', label: 'Pacific - PST/PDT (Los Angeles)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'UTC', label: 'UTC' },
]

// The viewer's own local timezone, per `Intl`'s own detection - the
// default selection, so bucket labels look exactly like they always did
// (viewer-local time) until an operator explicitly picks a different zone.
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

// The timezone Select's actual option list - DEFAULT_TIMEZONE prepended
// (labeled as "Local") unless it already happens to be one of
// TIMEZONE_OPTIONS, so whatever zone a given viewer's browser resolves to
// (there are ~400 IANA zones - TIMEZONE_OPTIONS only curates a handful) is
// always a valid, selectable, non-blank option, not just the initial value.
const TIMEZONE_SELECT_DATA = TIMEZONE_OPTIONS.some((option) => option.value === DEFAULT_TIMEZONE)
  ? TIMEZONE_OPTIONS
  : [{ value: DEFAULT_TIMEZONE, label: `Local (${DEFAULT_TIMEZONE})` }, ...TIMEZONE_OPTIONS]

// How often the Stats tab's numbers/charts refresh themselves - frequent
// enough to feel live, not so frequent it hammers the backend for an
// internal admin dashboard's data volume.
const STATS_POLL_INTERVAL_MS = 10_000

/**
 * Bucket label shown under each bar - derived from `bucketStart` (a UTC ISO
 * timestamp the backend returns) and rendered in whichever `timezone` is
 * currently selected (see the Select next to the Day/Week/Month/Year
 * toggle) via `Intl.DateTimeFormat`'s own `timeZone` option, not hardcoded.
 * Matches each range's own bucket width (see GET /internal/dashboard/stats's
 * contract): a 2-hour bucket gets a clock time, a 1-day bucket gets a
 * weekday, a 7-day bucket gets its start date, a 1-month bucket gets a
 * month name.
 */
// "day"'s own bucket label isn't produced here - it's just the bucket's
// 1-based position (see StatsBarChart's render loop below: "1" for the
// first/local-midnight bucket through "24" for the last) per explicit
// request, not a clock time read off `bucketStart` - so this function's
// `range` excludes it entirely; TypeScript enforces that every remaining
// case below actually needs `bucketStart`/`timezone`.
function formatBucketLabel(bucketStart: string, range: Exclude<DashboardStatsRange, 'day'>, timezone: string): string {
  const date = new Date(bucketStart)
  switch (range) {
    case '7days':
      return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: timezone }).format(date)
    case 'month':
      return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', timeZone: timezone }).format(date)
    case 'year':
      return new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: timezone }).format(date)
  }
}

/** "DD.MM" calendar date for the "day" range's own on-screen day (e.g. "04.08") - derived from the first bucket's `bucketStart` (local midnight in `timezone`, per the backend's calendar-aligned day-range contract), not from the client's own `new Date()`, so it can never disagree with which day the 24 hourly bars actually cover. */
function formatDayRangeDate(bucketStart: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', timeZone: timezone }).format(new Date(bucketStart))
}

interface StatsBarChartProps {
  title: string
  data: DashboardStatsBucket[]
  range: DashboardStatsRange
  timezone: string
  color: string
  glow: string
  /** True only during a timezone-triggered refetch (see statsLoading/handleTimezoneChange) - swaps the bars for a same-height spinner, mirroring SpendBlock's own loading treatment, so the Day/Week/Month/Year toggle and the 10s poll never trigger this. */
  loading: boolean
  /** "DD.MM" calendar date shown to the right of `title`, e.g. "04.08" - only passed for the "day" range (see the Messages sent call site below), where the 24 hourly buckets alone no longer show which calendar day they belong to (the bucket labels are now bare hour numbers, see formatBucketLabel). Undefined renders nothing next to the title, same as before this existed - so the "Dislikes" chart (which never gets this prop) is unaffected. */
  dateLabel?: string
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
function StatsBarChart({ title, data, range, timezone, color, glow, loading, dateLabel }: StatsBarChartProps): JSX.Element {
  const max = Math.max(1, ...data.map((bucket) => bucket.count))
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="baseline" wrap="nowrap">
        <Title order={4}>{title}</Title>
        {dateLabel ? (
          <Text size="sm" fw={600} c="dimmed">
            {dateLabel}
          </Text>
        ) : null}
      </Group>
      {loading ? (
        // Same height (160) as the real bars Group below, so swapping in
        // the spinner during a timezone-triggered refetch doesn't shift the
        // 3D panel next to this column - same idiom as SpendBlock's own
        // loading branch above.
        <Box style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader color="sparkOrange" />
        </Box>
      ) : (
        /* overflow: 'hidden' on the row + minWidth: 0 on each bucket below
            are both load-bearing, not decoration: flex items default to
            min-width: auto, which floors a bucket's width at its own
            content's natural size (here, the nowrap time label's full text
            width) REGARDLESS of flex: 1 - with enough buckets (the "Day"
            range shows 24), those floors summed together used to exceed
            this column's actual width and silently overflow rightward,
            bleeding under the 3D panel next to it instead of clipping or
            proportionally shrinking. minWidth: 0 removes that floor so
            flex: 1 actually is what it claims - a genuine, non-overflowing
            percentage share of the row for every bucket - and overflow:
            hidden on the row is the backstop in case a browser still
            computes a fractional pixel over. A smaller gap for "day"
            specifically - double the bucket count of any other range (24
            vs. at most 7), so the default "xs" gap between bars ate too
            much of the row's width, leaving too little for even a 2-digit
            label ("10".."24") and forcing the ellipsis fallback below to
            kick in on every one of them. */
        <Group align="flex-end" gap={range === 'day' ? 2 : 'xs'} wrap="nowrap" style={{ height: 160, overflow: 'hidden' }}>
        {data.map((bucket, index) => (
          <Stack
            key={bucket.bucketStart}
            gap={4}
            align="center"
            style={{ flex: 1, minWidth: 0, height: '100%', justifyContent: 'flex-end' }}
          >
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
            {/* fontSize: clamp(...) (not Mantine's fixed size="xs") - per
                explicit request: as the viewport narrows (or browser zoom
                goes up, which has the same effect on available CSS px),
                shrinking a little first buys these labels more room to
                still show their full text before the ellipsis fallback
                above ever needs to kick in - 24 buckets' worth of "Day"
                range time labels are the tightest case this chart has. */}
            <Text
              c="dimmed"
              style={{
                fontSize: 'clamp(0.5625rem, 0.9vw, 0.75rem)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '100%',
              }}
            >
              {range === 'day' ? index + 1 : formatBucketLabel(bucket.bucketStart, range, timezone)}
            </Text>
          </Stack>
        ))}
      </Group>
      )}
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
// (re)chunking, and documentation-analysis runs - not every dashboard_events
// row. Every event type the backend ever records (see app/events.py's call
// sites: pipeline.py, routers/documents.py, routers/chat.py, analysis/
// service.py) is one of "document.*" (uploaded/deleted/chunking_started/
// chunking_succeeded/chunking_failed - manual chunk edits from
// ChunkPreviewPage's Save re-run the same chunking pipeline, so they're
// already covered here too), "analysis.*" (run_completed/run_failed - see
// app/analysis/service.py's run_full_analysis), or "chat.*"
// (chat.message_sent) - prefix-matching against this list is exactly that
// split, with no per-type allowlist to keep in sync if a new document.*/
// analysis.* event type is ever added. The Stats tab's own counts
// deliberately still use the full, unfiltered `events` list below - this
// restriction is Logs-only.
const LOG_EVENT_TYPE_PREFIXES = ['document.', 'analysis.']

// Human-readable Type-column labels for the raw `document.*` event types
// (see LOG_EVENT_TYPE_PREFIX above for the full set the backend records) -
// the started/succeeded/failed phases of one chunking run share a common
// "Rechunk Document" base label (per explicit request) with a phase suffix,
// so adjacent rows for the same run stay distinguishable instead of reading
// as duplicates. Falls back to the raw `type` string for anything not in
// this map (see formatEventType below) rather than hiding an unrecognized
// event type entirely.
const EVENT_TYPE_LABELS: Record<string, string> = {
  'document.uploaded': 'Upload Document',
  'document.chunking_started': 'Rechunk Document — Started',
  'document.chunking_succeeded': 'Rechunk Document — Succeeded',
  'document.chunking_failed': 'Rechunk Document — Failed',
  'document.deleted': 'Delete Document',
  'analysis.run_completed': 'Documentation Analysis — Completed',
  'analysis.run_failed': 'Documentation Analysis — Failed',
  'analysis.run_deleted': 'Documentation Analysis — Report Deleted',
}

function formatEventType(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type
}

// Per-event-type accent color for the Logs tab's own cards (left border +
// timestamp chip, see the card list below) - reuses this app's existing
// brand associations rather than inventing new ones: teal for a clean
// success/completion, signalBlue for "actively in progress", alertMagenta
// for the same failure/destructive tone the dislike button and Dislikes
// chart already use everywhere else. Falls back to signalBlue (this app's
// general "informational" accent) for any event type not listed here -
// same fallback shape as formatEventType's own EVENT_TYPE_LABELS lookup,
// just a color instead of a label.
const EVENT_TYPE_COLORS: Record<string, string> = {
  'document.uploaded': 'teal',
  'document.chunking_started': 'signalBlue',
  'document.chunking_succeeded': 'teal',
  'document.chunking_failed': 'alertMagenta',
  'document.deleted': 'alertMagenta',
  'analysis.run_completed': 'teal',
  'analysis.run_failed': 'alertMagenta',
  'analysis.run_deleted': 'alertMagenta',
}

function getEventTypeColor(type: string): string {
  return EVENT_TYPE_COLORS[type] ?? 'signalBlue'
}

/** One line of an event's `\n`-joined `detail` string, once it's matched the "key = value" shape (see parseDetailLine below) - `key`/`value` are the two halves split on the first ` = `. */
interface ParsedDetailLine {
  key: string
  value: string
}

/**
 * Parses one line of `DashboardEvent.detail` (see DashboardPage.module.css's
 * own `.detailLine` comment for the exact shape the backend sends, e.g.
 * "filename = x.txt") into its key/value halves - returns null for a line
 * that doesn't match that shape (e.g. a full sentence like "x.txt was
 * uploaded."), so the caller (EventDetail below) can fall back to rendering
 * it as plain text rather than guessing at a split or silently dropping it.
 */
function parseDetailLine(line: string): ParsedDetailLine | null {
  const separatorIndex = line.indexOf(' = ')
  if (separatorIndex === -1) {
    return null
  }
  return { key: line.slice(0, separatorIndex), value: line.slice(separatorIndex + ' = '.length) }
}

/**
 * One event card's own Detail area - each `\n`-separated line of
 * `event.detail` that matches the "key = value" shape renders as its own
 * small tag (a tiny dimmed uppercase label plus the value, per explicit
 * request "instead of one dense wrapped text blob"), wrapping onto several
 * lines as needed. A line that doesn't match that shape falls back to plain
 * wrapped text (same wrapping rules as the old table's own `.detailCell`),
 * so an unexpected detail string still renders in full rather than crashing
 * or silently vanishing.
 */
function EventDetail({ detail }: { detail: string }): JSX.Element {
  return (
    <Group gap={6} wrap="wrap">
      {detail.split('\n').map((line, index) => {
        const parsed = parseDetailLine(line)
        if (!parsed) {
          return (
            <Text key={index} size="sm" c="dimmed" className={classes.detailLine}>
              {line}
            </Text>
          )
        }
        return (
          <Box
            key={index}
            bg="var(--doc-surface)"
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 4,
              maxWidth: '100%',
              border: '1px solid var(--doc-hairline)',
              borderRadius: 'var(--mantine-radius-sm)',
              padding: '2px 8px',
            }}
          >
            <Text size="9px" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
              {parsed.key}
            </Text>
            <Text size="xs" className={classes.detailLine}>
              {parsed.value}
            </Text>
          </Box>
        )
      })}
    </Group>
  )
}

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
  // Also shared by both charts (their bucket labels, specifically). Now also
  // sent to the backend as `tz` (see the stats-polling effect below) - the
  // "day" range's buckets are calendar-aligned to this zone's local midnight
  // server-side, not just relabeled client-side, so picking a zone DOES
  // trigger a refetch (unlike the display-only relabeling that used to be
  // the whole story here).
  const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  // True during the very first stats fetch ever (so the charts show a
  // spinner instead of a blank/zeroed area while first loading, per
  // explicit request) AND for the duration of a refetch explicitly
  // triggered by a timezone change (see handleTimezoneChange/
  // timezoneChangeShouldShowLoadingRef below) - never for an ordinary
  // statsRange change or the periodic 10s poll tick otherwise. Swaps both
  // bar charts' bars for a spinner (see StatsBarChart's own `loading` prop)
  // the same way spendRangeLoading already does for the Tokens/Spend
  // blocks.
  const [statsLoading, setStatsLoading] = useState(true)
  // Flips true the instant the FIRST stats fetch resolves (see the
  // stats-polling effect's own refresh() below) - a ref (not inferred from
  // `stats !== null`) because refresh() is a plain function re-invoked by
  // window.setInterval across many ticks within one effect lifetime;
  // `stats` read through that closure would still reflect whatever it was
  // when the effect itself was (re)created, not the latest value, the same
  // staleness problem timezoneChangeShouldShowLoadingRef's own comment
  // below already explains for a different trigger.
  const hasLoadedStatsOnceRef = useRef(false)
  // Set by handleTimezoneChange right before setTimezone, read (and cleared)
  // by the stats-polling effect's own refresh() below. A ref rather than a
  // plain "did timezone change since last run" effect-dependency check
  // because that effect already re-runs for THREE different reasons
  // (activeTab, statsRange, timezone) plus its own setInterval tick - a ref
  // set only by this one handler is the only way to distinguish "this
  // particular refresh was caused by a timezone click" from any of the
  // other four triggers without smuggling extra state into the effect's own
  // dependency array.
  const timezoneChangeShouldShowLoadingRef = useRef(false)
  // Fetched once per Stats-tab activation (not polled like `stats` above) -
  // OpenAI spend only moves as real API usage accrues, not from anything a
  // viewer does inside this app locally, so there's no reason to hammer it
  // every STATS_POLL_INTERVAL_MS the way the live message/dislike counts
  // are. null (not yet fetched) is distinct from a fetched-but-unconfigured
  // response ({ configured: false, ...zeros }) - the former renders
  // nothing yet, the latter renders the explicit "not configured" state.
  const [openAiSpend, setOpenAiSpend] = useState<OpenAiSpend | null>(null)
  // True while the fetch effect below is actually in flight - the three
  // OpenAI Admin API calls it awaits (costs/completions/embeddings, see
  // GET /internal/dashboard/openai-spend) are real external network calls,
  // several seconds slower than this app's own local-DB-backed endpoints,
  // so without this the two SpendBlocks below would flash a misleading "0"
  // for that whole stretch on every Stats-tab activation - same spinner
  // treatment as spendRangeLoading below, just gated on a real fetch
  // rather than a cosmetic delay.
  const [openAiSpendLoading, setOpenAiSpendLoading] = useState(false)
  // Which of openAiSpend's already-fetched rolling windows the two spend
  // blocks currently display - purely a display selector, changing it
  // never refetches (unlike statsRange above, which drives the
  // stats-polling effect's own dependency array).
  const [spendRange, setSpendRange] = useState<OpenAiSpendRange>('day')
  // Cosmetic-only, per explicit request: true for a random 300-1000ms
  // after a range click, during which both SpendBlocks below show a
  // spinner instead of their (already-fetched, see openAiSpend above)
  // number. Only handleSpendRangeChange ever flips this - never touched by
  // the initial fetch or the configured:false branch.
  const [spendRangeLoading, setSpendRangeLoading] = useState(false)
  const spendRangeTimeoutRef = useRef<number | null>(null)
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

  // Clears any still-pending reveal before starting a fresh one, so
  // rapid re-clicks restart the delay instead of an earlier click's timer
  // firing after a later one and re-hiding the number.
  function handleSpendRangeChange(range: OpenAiSpendRange): void {
    setSpendRange(range)
    setSpendRangeLoading(true)
    if (spendRangeTimeoutRef.current !== null) {
      window.clearTimeout(spendRangeTimeoutRef.current)
    }
    spendRangeTimeoutRef.current = window.setTimeout(() => setSpendRangeLoading(false), 300 + Math.random() * 700)
  }

  // Flags the ref the stats-polling effect's own refresh() checks (see
  // timezoneChangeShouldShowLoadingRef's own comment above for why a ref)
  // before setTimezone triggers that effect to re-run - setTimezone alone
  // can't carry "and this particular run should show a spinner" information
  // to the effect.
  function handleTimezoneChange(value: string): void {
    timezoneChangeShouldShowLoadingRef.current = true
    setTimezone(value)
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
  // hidden tab. Refetches immediately on mount/range/timezone change too,
  // not just on the first interval tick. `cancelled` guards against a fetch
  // that was still in flight when the tab switched away (or the range/
  // timezone changed again) from clobbering newer state on a stale
  // response. `timezone` is now also sent to the backend as `tz` (the "day"
  // range's buckets are calendar-aligned server-side to that zone) - so,
  // unlike before, a timezone change belongs in this effect's own
  // dependency array alongside activeTab/statsRange.
  useEffect(() => {
    if (activeTab !== 'stats') {
      return
    }
    let cancelled = false
    function refresh(): void {
      // Snapshotted once per call, not re-read after the fetch resolves:
      // handleTimezoneChange sets this ref immediately before setTimezone
      // triggers this very effect to re-run (because `timezone` is now a
      // dependency) - the refresh() call that re-run makes is the one this
      // flag is meant for. By the time any LATER refresh() call happens
      // (this effect's own 10s poll tick, or a subsequent statsRange/
      // activeTab-driven re-run), the ref has already been cleared below,
      // so only the one refetch an explicit timezone change actually caused
      // ever shows the spinner - not the poll, and not a statsRange change.
      const isTimezoneTriggered = timezoneChangeShouldShowLoadingRef.current
      const isInitialLoad = !hasLoadedStatsOnceRef.current
      if (isTimezoneTriggered || isInitialLoad) {
        setStatsLoading(true)
      }
      void apiClient.getDashboardStats(statsRange, timezone).then((result) => {
        if (!cancelled) {
          setStats(result)
          hasLoadedStatsOnceRef.current = true
          if (isTimezoneTriggered || isInitialLoad) {
            setStatsLoading(false)
            timezoneChangeShouldShowLoadingRef.current = false
          }
        }
      })
    }
    refresh()
    const intervalId = window.setInterval(refresh, STATS_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [activeTab, statsRange, timezone])

  // One-shot fetch (not polled - see openAiSpend's own state comment above
  // for why) of GET /internal/dashboard/openai-spend, scoped to the Stats
  // tab the same way the stats polling effect above is. `cancelled` guards
  // against a fetch still in flight if the tab switches away before it
  // resolves, same idiom as the stats effect above. openAiSpendLoading is
  // set true right away and only cleared inside the `!cancelled` guard, so
  // a stale in-flight fetch from a since-abandoned tab activation can
  // never clear a NEWER activation's own loading state.
  useEffect(() => {
    if (activeTab !== 'stats') {
      return
    }
    let cancelled = false
    setOpenAiSpendLoading(true)
    void apiClient.getOpenAiSpend().then((result) => {
      if (!cancelled) {
        setOpenAiSpend(result)
        setOpenAiSpendLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [activeTab])

  // Mount-once cleanup for handleSpendRangeChange's own timer above - not
  // re-run per range change (empty deps), just guards against the pending
  // reveal firing setSpendRangeLoading after this page has unmounted.
  useEffect(() => {
    return () => {
      if (spendRangeTimeoutRef.current !== null) {
        window.clearTimeout(spendRangeTimeoutRef.current)
      }
    }
  }, [])

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
      if (!LOG_EVENT_TYPE_PREFIXES.some((prefix) => event.type.startsWith(prefix))) {
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
          {/* Left half: the four stat cards (from the polled GET
              /internal/dashboard/stats response, see the polling effect
              above - not a one-time fetch, they refresh themselves every
              STATS_POLL_INTERVAL_MS while this tab is visible; Users is
              hardcoded to 0 backend-side, there's no user/auth system in
              this app yet, not a display bug here), 2x2 so all four fit in
              half the page width. Right half is its own Stack (per
              explicit request) - one Day/Week/Month/Year toggle (styled
              identically to SegmentedToggle's other uses, e.g. the
              charts' own range toggle below) driving two big-number
              blocks together: tokens spent, and money spent, for
              whichever single period is currently selected - replacing
              the earlier version's static "always show all four periods
              at once" list. align="stretch" on the outer Group is enough
              to match heights here (unlike the Messages/Dislikes-vs-3D-
              graph row further down, which needs the more involved
              measured-height approach - see that row's own comment -
              nothing in this row has canvas/JS-sized content fighting the
              stretch calculation). */}
          <Group align="stretch" gap="lg" wrap="wrap">
            <SimpleGrid cols={2} spacing="md" style={{ flex: 1, minWidth: 280 }}>
              <StatCard label="Total Documents" value={stats?.totalDocuments ?? 0} />
              <StatCard label="Total Chunks" value={stats?.totalChunks ?? 0} />
              <StatCard label="Total Users" value={stats?.totalUsers ?? 0} />
              {/* All-time count - independent of the range toggle below,
                  unlike the Dislikes bar chart's own dislikeBuckets. */}
              <StatCard label="Total Dislikes" value={stats?.totalDislikes ?? 0} />
            </SimpleGrid>
            <Stack gap="sm" style={{ flex: 1, minWidth: 280 }}>
              <SegmentedToggle options={OPENAI_SPEND_RANGE_OPTIONS} value={spendRange} onChange={handleSpendRangeChange} />
              {/* openAiSpend starts `null` (not yet fetched - treated as
                  "configured" so it shows a momentary 0 rather than
                  flashing the "not configured" message) vs. a real
                  response with `configured: false` (backend has no
                  OPENAI_ADMIN_API_KEY set - shown explicitly per block,
                  not silently blank, so it's clear this is a genuinely
                  optional/unconfigured feature and not a loading stall or
                  a bug). flex: 1 lets this row fill whatever height the
                  toggle above didn't use, matching the SimpleGrid's own
                  stretched height. */}
              <Group align="stretch" gap="lg" wrap="wrap" style={{ flex: 1 }}>
                <SpendBlock
                  label="Tokens Spend"
                  split={{
                    input: formatTokenCount(openAiSpend?.tokens?.[spendRange]?.input ?? 0),
                    output: formatTokenCount(openAiSpend?.tokens?.[spendRange]?.output ?? 0),
                  }}
                  configured={openAiSpend?.configured ?? true}
                  loading={openAiSpendLoading || spendRangeLoading}
                />
                <SpendBlock
                  label="Money Spend"
                  value={formatSpendAmount(openAiSpend?.[spendRange] ?? 0, openAiSpend?.currency ?? 'usd')}
                  configured={openAiSpend?.configured ?? true}
                  loading={openAiSpendLoading || spendRangeLoading}
                />
              </Group>
            </Stack>
          </Group>

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
              {/* Day/7 Days/Month/Year toggle + timezone control now live
                  INSIDE this same Stack (not in a separate row above it),
                  so it's naturally exactly as wide as the charts below it
                  - justify="space-between" pins the timezone control's
                  right edge to the charts' own right edge (the
                  chart/3D-panel divider) for free, by ordinary block-width
                  inheritance, not a ResizeObserver-driven guess (an
                  earlier attempt at exactly that drifted out of
                  alignment). wrap="nowrap" (this row does NOT use this
                  Stack's usual wrap="wrap") is deliberate: at this
                  column's width, the toggle plus a roomy timezone control
                  don't both fit, and wrapping would drop the timezone
                  control onto its own left-aligned line below the toggle
                  instead of staying pinned to the divider - so instead the
                  Select below shrinks (flex: 1, minWidth: 0, ellipsis) to
                  whatever room is actually left after the toggle, rather
                  than the row wrapping. Both charts share this one
                  toggle+timezone pair (per explicit request) - see
                  StatsBarChart/formatBucketLabel above and GET
                  /internal/dashboard/stats's bucket contract. Changing the
                  timezone both reformats already-fetched bucket labels AND
                  triggers a refetch (see the stats-polling effect's own
                  comment above) - the backend calendar-aligns the "day"
                  range's buckets to this zone's local midnight, so a zone
                  change can change which 24 buckets come back, not just how
                  their timestamps are displayed. */}
              <Group align="flex-end" gap="md" wrap="nowrap">
                {/* flexShrink: 0 - only the timezone Select (below) should
                    ever shrink to make room in a tight row; the toggle's
                    own labels (Day/Week/Month/Year) have no ellipsis/
                    truncation handling and must stay at full, readable
                    size regardless of how little space is left. */}
                <Box style={{ flexShrink: 0 }}>
                  <SegmentedToggle options={STATS_RANGE_OPTIONS} value={statsRange} onChange={setStatsRange} />
                </Box>
                {/* Two-part pill, same "one shared Paper, no double
                    border" device as SegmentedToggle's own wrapping Paper
                    - a yellow sparkOrange "Timezone" label chip (same
                    accent color as the active Day/Week/Month/Year tab)
                    fused to the actual dropdown, rather than a bare
                    unlabeled Select, per explicit request. flex: 1 makes
                    this Paper actually GROW to consume all the row's
                    leftover width after the (fixed-size) toggle - the
                    previous version left that leftover width as visible
                    empty gap instead (via the outer Group's own
                    justify="space-between", removed above), which per
                    explicit request should become extra room for the
                    dropdown/its options instead of dead space. minWidth: 0
                    is still load-bearing (not decorative) - without it
                    this Paper's own default flex min-width would floor at
                    its content's natural size and force the row to
                    overflow instead of letting the Select inside actually
                    shrink on a genuinely tight viewport. */}
                <Paper
                  radius="lg"
                  p={0}
                  bg="var(--doc-surface)"
                  withBorder
                  style={{ boxShadow: '0 10px 20px -12px rgba(0, 0, 0, 0.5)', overflow: 'hidden', flex: 1, minWidth: 0 }}
                >
                  <Group gap={0} wrap="nowrap">
                    <Box bg="var(--mantine-color-sparkOrange-6)" px="sm" style={{ display: 'flex', alignItems: 'center', height: 36, flexShrink: 0 }}>
                      <Text fw={700} size="xs" c="#101B36" tt="uppercase" style={{ letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
                        Timezone
                      </Text>
                    </Box>
                    {/* The Select itself uses variant="unstyled" since the
                        shared Paper above already supplies the
                        background/border/shadow this control reads as one
                        piece by - a second, separate border on the input
                        itself would visibly seam the two halves apart
                        instead. style.flex/minWidth (not just the w=160
                        starting point) is what actually lets this shrink
                        below its own natural content size when the row is
                        tight - w is only the size it'd PREFER at rest. */}
                    <Select
                      aria-label="Timezone for chart timestamps"
                      data={TIMEZONE_SELECT_DATA}
                      value={timezone}
                      onChange={(value) => value && handleTimezoneChange(value)}
                      searchable
                      variant="unstyled"
                      size="sm"
                      px="sm"
                      w={160}
                      style={{ flex: 1, minWidth: 0 }}
                      // The dropdown panel defaults to matching the closed
                      // input's own (narrow, space-constrained) width -
                      // widened here independently via comboboxProps so
                      // option text like "Eastern - EST/EDT (New York)"
                      // wraps less, per explicit request. position:
                      // 'bottom-end' anchors the dropdown's RIGHT edge to
                      // the input's right edge, so the extra width expands
                      // leftward (over the charts, which is empty space at
                      // that point) rather than pushing past this column's
                      // right edge into/past the 3D panel.
                      comboboxProps={{ width: 280, position: 'bottom-end' }}
                      styles={{
                        // Matches TabButton's own font-size/weight
                        // (16px/600) and its INACTIVE state's muted color
                        // exactly - Mantine's own default (regular 400
                        // weight, near-white --doc-text) read louder/
                        // heavier than the Week/Month/Year tabs sitting
                        // right next to it. overflow/textOverflow: the
                        // fallback for whenever even the shrunk width
                        // still isn't enough to show a full zone name -
                        // same ellipsis idiom StatsBarChart's own bucket
                        // labels already use.
                        input: {
                          height: 36,
                          fontSize: 16,
                          fontWeight: 600,
                          color: 'var(--doc-text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      }}
                    />
                  </Group>
                </Paper>
              </Group>
              <StatsBarChart
                title="Messages sent"
                data={stats?.messageBuckets ?? []}
                range={statsRange}
                timezone={timezone}
                color="var(--mantine-color-signalBlue-6)"
                glow="0 0 12px rgba(61, 107, 255, 0.55)"
                loading={statsLoading}
                // Only meaningful for "day" - see StatsBarChart's own
                // dateLabel doc comment for why "Dislikes" below never gets
                // this prop (it'd be a redundant second copy of the same
                // date, per the screenshot this was built from).
                dateLabel={statsRange === 'day' && stats?.messageBuckets?.[0] ? formatDayRangeDate(stats.messageBuckets[0].bucketStart, timezone) : undefined}
              />
              {/* alertMagenta - the same color the dislike button itself
                  uses everywhere else in this app (ChatPage), not an
                  arbitrary second hue. */}
              <StatsBarChart
                title="Dislikes"
                data={stats?.dislikeBuckets ?? []}
                range={statsRange}
                timezone={timezone}
                color="var(--mantine-color-alertMagenta-6)"
                glow="0 0 12px rgba(255, 61, 113, 0.55)"
                loading={statsLoading}
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
        // list reads as filling the same share of the page's bottom portion
        // at any browser zoom level - zoom scales the viewport together
        // with everything in it, so a vh-based size stays proportionally
        // correct instead of drifting like a fixed px height would. Up to
        // LOGS_PAGE_SIZE=20 cards almost always overflows that frame, so
        // `overflowY: auto` (its scrollbar styled by the app-wide rule in
        // global.css, applied automatically) on the inner list wrapper is
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
            {/* Sort direction is live (not staged into the Search-button
                batch below, unlike appliedLogsFilters) - one click cycles
                unsorted -> newest-first -> oldest-first -> unsorted, same
                3-state cycle (cycleLogsSortDirection/logsSortDirection) the
                old Timestamp column header used to drive by click. There's
                no header row to click anymore now that each event is its
                own card, so this stands in as a small, explicit control near
                the rest of the filter bar instead. SortDirectionIcon (its
                arrow aria-hidden) only renders once a sort is actually
                active; the button's own accessible name always spells out
                the current state too, not just the icon. */}
            <Button
              variant={logsSortDirection !== null ? 'filled' : 'default'}
              color="signalBlue"
              onClick={cycleLogsSortDirection}
              leftSection={logsSortDirection !== null ? <SortDirectionIcon direction={logsSortDirection} /> : undefined}
              aria-label={
                logsSortDirection === 'desc'
                  ? 'Sort by time (currently newest first)'
                  : logsSortDirection === 'asc'
                    ? 'Sort by time (currently oldest first)'
                    : 'Sort by time (currently unsorted)'
              }
            >
              Sort by time
            </Button>
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

          <Box style={{ flex: 1, overflowY: 'auto' }}>
            {filteredLogsEvents.length === 0 ? (
              <Box style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Text c="dimmed" ta="center" fw={600} style={{ fontSize: '2rem', maxWidth: '40rem' }}>
                  No matching entries found - try adjusting or clearing the filters above.
                </Text>
              </Box>
            ) : (
              // A card per event (not a grid table) - same left-accent-stripe
              // card + solid-color chip language as ImprovementsPage.tsx's
              // own ImprovementsListPanel entries (see EVENT_TYPE_COLORS/
              // getEventTypeColor above), rather than a bureaucratic data
              // table. Each card's own accent color ties its left border to
              // its own timestamp chip, so both read as one color-coded unit
              // per event type.
              <Stack gap="sm" data-testid="logs-event-list">
                {pageEvents.map((event, index) => {
                  const color = getEventTypeColor(event.type)
                  return (
                    <Paper
                      key={event.id}
                      data-testid="log-event-card"
                      radius="lg"
                      p="md"
                      bg="var(--doc-bg)"
                      className={classes.entryCard}
                      style={{
                        border: '1px solid var(--doc-hairline)',
                        borderLeft: `3px solid var(--mantine-color-${color}-6)`,
                      }}
                    >
                      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                        <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                          <Group gap="xs" align="center" wrap="wrap">
                            {/* A plain running number (1, 2, 3, ...) across the
                                whole list, not the event's real UUID -
                                continues across pages (offset by
                                clampedLogsPageIndex * LOGS_PAGE_SIZE) rather
                                than resetting to 1 on every page.
                                De-emphasized (small/dimmed/mono) - it's just
                                a position counter, not a meaningful id. */}
                            <Text size="xs" c="dimmed" ff="monospace">
                              #{clampedLogsPageIndex * LOGS_PAGE_SIZE + index + 1}
                            </Text>
                            <Text fw={700} tt="uppercase" c={color} style={{ letterSpacing: '0.04em' }}>
                              {formatEventType(event.type)}
                            </Text>
                          </Group>
                          <EventDetail detail={event.detail} />
                          {/* null for worker-triggered events (chunking_started/
                              succeeded/failed run inside a Celery task, outside
                              any authenticated session) - shown as a dash
                              rather than blank so it reads as "no user", not
                              missing data. */}
                          <Group gap={6} align="baseline" wrap="nowrap">
                            <Text size="10px" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.04em' }}>
                              User
                            </Text>
                            <Text size="xs" ff="monospace" c={event.userEmail ? undefined : 'dimmed'}>
                              {event.userEmail ?? '—'}
                            </Text>
                          </Group>
                        </Stack>
                        {/* Solid-fill chip (not a translucent tint), colored by
                            this row's own accent (getEventTypeColor) rather
                            than a fixed color - same "solid accent background +
                            dark navy text" device as ImprovementsListPanel's
                            own timestamp chip, for guaranteed contrast
                            regardless of which color a given event type maps
                            to. */}
                        <Box
                          style={{
                            backgroundColor: `var(--mantine-color-${color}-6)`,
                            borderRadius: 'var(--mantine-radius-md)',
                            padding: '4px 10px',
                            flexShrink: 0,
                          }}
                        >
                          <Text size="10px" fw={700} tt="uppercase" c="#101B36" ta="right" style={{ letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                            Timestamp
                          </Text>
                          <Text size="sm" fw={700} ff="monospace" c="#101B36" ta="right" style={{ whiteSpace: 'nowrap' }}>
                            {formatDateTime(event.timestamp)}
                          </Text>
                        </Box>
                      </Group>
                    </Paper>
                  )
                })}
              </Stack>
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
