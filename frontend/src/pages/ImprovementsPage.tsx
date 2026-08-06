import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { ActionIcon, Alert, Badge, Box, Button, Group, Loader, Modal, Paper, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { Link } from 'react-router-dom'

import { apiClient } from '../api/client'
import type {
  AnalysisConflict,
  AnalysisReportDetail,
  AnalysisReportSummary,
  AnalysisRunStatus,
  DislikedMessage,
  ImprovementsRange,
  NoAnswerMessage,
} from '../api/types'
import { SegmentedToggle } from '../components/SegmentedToggle'
import classes from './ImprovementsPage.module.css'
import { BotAvatar } from './ChatPage'
import { POLL_INTERVAL_MS } from './UploadPage'
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
  /** A left-edge accent stripe + question-label color, per panel - reuses this
      app's existing brand associations rather than inventing new ones:
      alertMagenta is already the dislike button's own color everywhere else
      (ChatPage, DashboardPage's Dislikes chart); signalBlue is already this
      app's "informational" accent (Edit action icon, Messages sent chart,
      timezone chip). Purely a visual identity cue distinguishing the two
      panels' cards from each other at a glance. */
  accentColor: 'alertMagenta' | 'signalBlue'
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
  accentColor,
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
          <Group gap="xs" align="center" wrap="nowrap">
            <Title order={3}>{title}</Title>
            {/* "Total" (not "quantity"/"count") - short enough to sit next
                to the title without crowding the range toggle beside it on
                a narrower panel width. */}
            <Badge color={accentColor} variant="light" radius="sm" size="lg">
              Total: {items.length}
            </Badge>
          </Group>
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
            // A card per entry (not a grid table) - the question/reply pair
            // reads as a small conversation snippet, echoing ChatPage's own
            // message-bubble language (see its Paper[radius="xl"] bubbles)
            // rather than a bureaucratic data table. The left accent stripe
            // (accentColor) gives each panel its own visual identity at a
            // glance when both sit side by side.
            <Stack gap="sm">
              {items.map((item) => (
                <Paper
                  key={item.id}
                  radius="lg"
                  p="md"
                  bg="var(--doc-bg)"
                  className={classes.entryCard}
                  style={{
                    border: '1px solid var(--doc-hairline)',
                    borderLeft: `3px solid var(--mantine-color-${accentColor}-6)`,
                  }}
                >
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                    <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        size="xs"
                        fw={700}
                        tt="uppercase"
                        c={accentColor}
                        style={{ letterSpacing: '0.04em' }}
                      >
                        Question
                      </Text>
                      <Text fw={600} c={item.questionContent ? undefined : 'dimmed'} style={{ whiteSpace: 'pre-wrap' }}>
                        {item.questionContent ?? 'Unknown question'}
                      </Text>
                      <Box aria-hidden="true" style={{ height: 1, backgroundColor: 'var(--doc-hairline)' }} />
                      <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                        {item.content}
                      </Text>
                    </Stack>
                    <Stack gap="xs" align="flex-end" style={{ flexShrink: 0 }}>
                      <ActionIcon
                        size="lg"
                        aria-label={removeAriaLabel}
                        variant="subtle"
                        color="alertMagenta"
                        onClick={() => void handleRemove(item.id)}
                      >
                        <RemoveIcon />
                      </ActionIcon>
                      <Text size="xs" c="dimmed" ff="monospace" ta="right" style={{ whiteSpace: 'nowrap' }}>
                        {timestampLabel}
                        <br />
                        {formatDateTime(getTimestamp(item))}
                      </Text>
                    </Stack>
                  </Group>
                </Paper>
              ))}
            </Stack>
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

// Badge color/label per AnalysisRunStatus - same "map status to an existing
// theme token" convention as UploadPage.tsx's own STATUS_META (teal for a
// clean success, alertMagenta for the same failure tone the dislike button/
// Dislikes chart use everywhere else, signalBlue for "actively happening").
const ANALYSIS_STATUS_META: Record<AnalysisRunStatus, { label: string; color: string }> = {
  running: { label: 'Running', color: 'signalBlue' },
  completed: { label: 'Completed', color: 'teal' },
  failed: { label: 'Failed', color: 'alertMagenta' },
}

interface AnalysisBotHeroProps {
  message: string
  /** True only for the in-progress state - the empty-history state has nothing to spin for. */
  showLoader?: boolean
}

/**
 * The same centered bot-identity hero (avatar + soft signalBlue glow) the
 * placeholder this tab replaces already used - preserved here for the two
 * states that still have no real report content to show: no runs exist yet,
 * or the selected run is still in progress. Once a report is actually
 * selected and settled, this hero is never shown - see AnalysisTab's own
 * contentBody below.
 */
function AnalysisBotHero({ message, showLoader }: AnalysisBotHeroProps): JSX.Element {
  return (
    <Stack align="center" justify="center" gap="md" style={{ height: '100%' }}>
      <Box style={{ filter: 'drop-shadow(0 0 24px rgba(61, 107, 255, 0.45))' }}>
        <BotAvatar />
      </Box>
      <Title order={3}>Documentation Gap Analysis</Title>
      <Text c="dimmed" ta="center" maw={480}>
        {message}
      </Text>
      {showLoader ? <Loader color="sparkOrange" /> : null}
    </Stack>
  )
}

interface ConflictCardProps {
  conflict: AnalysisConflict
}

/** One side of a ConflictCard (below) - a document's filename, a "view chunk" link into ChunkPreviewPage.tsx's own route, and the snapshotted chunk excerpt. */
function ConflictSide({
  documentId,
  filename,
  content,
}: {
  documentId: string
  filename: string
  content: string
}): JSX.Element {
  return (
    <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
      <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
        <Text fw={600} size="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {filename}
        </Text>
        {/* aria-label (not just the link's own short visible text) carries
            the filename, so the two sides' links stay distinguishable by
            accessible name alone - same reasoning as UploadPage.tsx's own
            `Edit ${document.filename}` action icon labels. */}
        <Link to={`/upload/${documentId}/chunks`} aria-label={`View ${filename} chunk`} style={{ flexShrink: 0, color: 'var(--mantine-color-signalBlue-6)' }}>
          View chunk
        </Link>
      </Group>
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
        {content}
      </Text>
    </Stack>
  )
}

/**
 * Splits the gap-analysis report's plain-prose text into its own paragraphs
 * (blank-line-separated, per gap_analysis_prompt.txt's own "plain prose and
 * short lists" instruction) so each one can render as its own visual block
 * below instead of one dense wall of text - works regardless of whether the
 * model happened to number its findings or not, since it splits on
 * paragraph breaks rather than parsing "1./2./3." list syntax specifically.
 */
function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

interface GapAnalysisBlockProps {
  index: number
  text: string
}

/** One paragraph of the gap-analysis report as its own card - a numbered badge (purely a visual "this is finding #N" cue, not tied to any structure the model is required to follow) plus the paragraph text, same left-accent-stripe card language as the Dislikes/No Answer panels' own entries (ImprovementsListPanel) and ConflictCard below. */
function GapAnalysisBlock({ index, text }: GapAnalysisBlockProps): JSX.Element {
  return (
    <Paper
      radius="lg"
      p="md"
      bg="var(--doc-bg)"
      className={classes.entryCard}
      style={{ border: '1px solid var(--doc-hairline)', borderLeft: '3px solid var(--mantine-color-sparkOrange-6)' }}
    >
      <Group align="flex-start" gap="sm" wrap="nowrap">
        <Box
          aria-hidden="true"
          style={{
            flexShrink: 0,
            width: 24,
            height: 24,
            borderRadius: '50%',
            backgroundColor: 'var(--mantine-color-sparkOrange-6)',
            color: '#101B36',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {index + 1}
        </Box>
        <Text style={{ whiteSpace: 'pre-wrap', flex: 1 }}>{text}</Text>
      </Group>
    </Paper>
  )
}

/** Trash-can glyph, same path data as UploadPage.tsx's own TrashIcon - this app doesn't currently export icons for cross-file reuse (unlike e.g. BotAvatar), so it's kept as a local copy here for the History sidebar's own per-report delete action below. */
function TrashIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

/** Checkmark glyph - same no-icon-library rationale as this app's other hand-rolled SVGs. Used only for the Conflicts section's own empty state below, as a positive ("all clear") cue rather than a plain dimmed sentence. */
function CheckIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/** The Conflicts section's own empty state - teal (this app's "good/completed" accent, see ANALYSIS_STATUS_META) instead of a plain dimmed sentence, so "nothing wrong was found" reads as a positive result rather than an absence of content. */
function NoConflictsFound(): JSX.Element {
  return (
    <Paper radius="lg" p="md" bg="var(--doc-bg)" style={{ border: '1px solid var(--doc-hairline)', borderLeft: '3px solid var(--mantine-color-teal-6)' }}>
      <Group gap="sm" align="center" wrap="nowrap">
        <Box
          aria-hidden="true"
          style={{
            flexShrink: 0,
            width: 32,
            height: 32,
            borderRadius: '50%',
            backgroundColor: 'rgba(56, 217, 169, 0.16)',
            color: 'var(--mantine-color-teal-4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CheckIcon />
        </Box>
        <Text fw={600}>No conflicts found in the documents.</Text>
      </Group>
    </Paper>
  )
}

/** One detected cross-document conflict - both sides' chunk excerpts side by side, the LLM's own description of the contradiction, and a "view chunk" link per side into ChunkPreviewPage.tsx. */
function ConflictCard({ conflict }: ConflictCardProps): JSX.Element {
  return (
    <Paper radius="lg" p="md" bg="var(--doc-bg)" style={{ border: '1px solid var(--doc-hairline)', borderLeft: '3px solid var(--mantine-color-alertMagenta-6)' }}>
      <Stack gap="sm">
        <Text size="sm">{conflict.description}</Text>
        <Group align="flex-start" gap="md" wrap="wrap">
          <ConflictSide documentId={conflict.documentAId} filename={conflict.documentAFilename} content={conflict.chunkAContent} />
          <Box aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', backgroundColor: 'var(--doc-hairline)' }} />
          <ConflictSide documentId={conflict.documentBId} filename={conflict.documentBFilename} content={conflict.chunkBContent} />
        </Group>
      </Stack>
    </Paper>
  )
}

/**
 * Sub-tab 2, wired up for real: a history sidebar of every past run (newest
 * first, per GET /internal/analysis/reports) next to the selected run's own
 * gap-analysis report and conflict list, with an "Analyze with AI" button
 * that starts a new background run and polls until it settles - see
 * .claude/plans/2026-08-06-documentation-analysis.md's Task 7.
 */
function AnalysisTab(): JSX.Element {
  const [reports, setReports] = useState<AnalysisReportSummary[]>([])
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null)
  const [selectedReport, setSelectedReport] = useState<AnalysisReportDetail | null>(null)
  // Set when a history card's own delete icon is clicked - opens the confirm
  // Modal below without deleting anything yet, same "hold the target, only
  // act on the modal's own confirm button" pattern as UploadPage.tsx's own
  // deleteTarget/attemptDelete/handleConfirmDelete.
  const [deleteTarget, setDeleteTarget] = useState<AnalysisReportSummary | null>(null)
  // True only for the brief window between clicking "Analyze with AI" and
  // the POST resolving - NOT the same as the selected report's own
  // status==='running' below, which covers the whole run's duration (the
  // run itself keeps going in the background long after this flips back to
  // false - the polling effect further down is what picks up its eventual
  // completion).
  const [isStarting, setIsStarting] = useState(false)

  // Initial fetch of every past run - selects the newest one (reports[0],
  // since the backend already returns newest-first) by default, but only if
  // nothing is selected yet (the `current ?? ...` guard), so this effect
  // re-running for an unrelated reason never stomps on an operator's own
  // in-progress selection.
  useEffect(() => {
    let cancelled = false
    void apiClient.listAnalysisReports().then((result) => {
      if (!cancelled) {
        setReports(result)
        setSelectedReportId((current) => current ?? result[0]?.id ?? null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Fetches the selected report's own full detail (gapAnalysis/conflicts/
  // totalTokens/errorDetail - none of which the summary list above carries)
  // whenever the selection changes.
  useEffect(() => {
    if (!selectedReportId) {
      setSelectedReport(null)
      return
    }
    let cancelled = false
    void apiClient.getAnalysisReport(selectedReportId).then((result) => {
      if (!cancelled) {
        setSelectedReport(result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedReportId])

  // Light polling: while the most-recently-started report (reports[0], the
  // list is newest-first) is still running, periodically re-fetch the
  // summary list so its status genuinely progresses to completed/failed on
  // its own - same isUnsettled-driven useEffect shape (dependency on the
  // very state it re-fetches, so a poll response that changes that state
  // naturally reschedules or stops the next tick) as UploadPage.tsx's own
  // document-status polling, reusing that file's own POLL_INTERVAL_MS
  // rather than a second, redundant constant. Stops as soon as reports[0]
  // isn't running anymore.
  useEffect(() => {
    if (reports[0]?.status !== 'running') {
      return
    }
    const intervalId = window.setInterval(() => {
      void apiClient.listAnalysisReports().then(setReports)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [reports])

  // Companion to the polling effect above: once the currently SELECTED
  // report (which may or may not be reports[0]) shows a settled status in
  // the just-polled list while the full detail already loaded for it still
  // says 'running', its full detail is stale (gapAnalysis/conflicts are
  // still null from when the run hadn't finished) - re-fetch it once. The
  // `selectedReport.status !== 'running'` guard is what stops this from
  // looping: the very re-fetch this effect triggers updates selectedReport
  // to the settled status, which then short-circuits this effect on its own
  // next run.
  useEffect(() => {
    if (!selectedReportId || !selectedReport || selectedReport.status !== 'running') {
      return
    }
    const latest = reports.find((report) => report.id === selectedReportId)
    if (latest && latest.status !== 'running') {
      void apiClient.getAnalysisReport(selectedReportId).then(setSelectedReport)
    }
  }, [reports, selectedReportId, selectedReport])

  async function handleStartAnalysis(): Promise<void> {
    setIsStarting(true)
    try {
      const summary = await apiClient.startAnalysisRun()
      setReports((current) => [summary, ...current])
      setSelectedReportId(summary.id)
    } finally {
      setIsStarting(false)
    }
  }

  // DELETE /internal/analysis/reports/{id}: 204 on success, 404 if it's
  // already gone. Removes the row from local state immediately (optimistic,
  // same convention as ImprovementsListPanel's own handleRemove above)
  // rather than waiting on a refetch. If the deleted report was the one
  // currently selected, its own selection is cleared too - otherwise the
  // content area would keep showing that now-deleted report's stale detail.
  async function attemptDelete(report: AnalysisReportSummary): Promise<void> {
    await apiClient.deleteAnalysisReport(report.id)
    setDeleteTarget(null)
    setReports((current) => current.filter((candidate) => candidate.id !== report.id))
    setSelectedReportId((current) => (current === report.id ? null : current))
  }

  function handleConfirmDelete(): void {
    if (deleteTarget) {
      void attemptDelete(deleteTarget)
    }
  }

  const isAnalyzeDisabled = isStarting || reports[0]?.status === 'running'

  let contentBody: JSX.Element
  if (reports.length === 0) {
    contentBody = (
      <AnalysisBotHero message="Automatically review dislikes and no-answer questions to suggest documentation improvements, and flag cross-document contradictions. Click “Analyze with AI” above to run your first report." />
    )
  } else if (selectedReport?.status === 'running') {
    contentBody = <AnalysisBotHero message="Analysis in progress..." showLoader />
  } else if (selectedReport?.status === 'failed') {
    contentBody = (
      <Alert color="alertMagenta" variant="light" radius="lg" title="Analysis failed">
        {selectedReport.errorDetail ?? 'The run failed for an unknown reason.'}
      </Alert>
    )
  } else if (selectedReport) {
    const conflicts = selectedReport.conflicts ?? []
    contentBody = (
      <Stack gap="lg">
        <Stack gap="xs">
          <Title order={4}>Gap Analysis</Title>
          <Stack gap="sm">
            {splitIntoParagraphs(selectedReport.gapAnalysis ?? '').map((paragraph, index) => (
              <GapAnalysisBlock key={index} index={index} text={paragraph} />
            ))}
          </Stack>
        </Stack>
        <Stack gap="xs">
          <Title order={4}>Conflicts</Title>
          {conflicts.length === 0 ? (
            <NoConflictsFound />
          ) : (
            <Stack gap="sm">
              {conflicts.map((conflict, index) => (
                // Snapshotted JSONB rows, not real backend ids - index is
                // stable within one already-fetched report's own array.
                <ConflictCard key={index} conflict={conflict} />
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    )
  } else {
    contentBody = <Text c="dimmed">Select a report from the history to view its details.</Text>
  }

  return (
    <>
      <Paper
        radius="lg"
        p="xl"
        bg="var(--doc-surface)"
        withBorder
        style={{ boxShadow: '0 24px 48px -24px rgba(0, 0, 0, 0.55)', height: PANEL_AREA_HEIGHT, display: 'flex', overflow: 'hidden' }}
      >
        <Group align="stretch" gap="xl" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
          {/* History sidebar - narrower than the content area beside it, its
              own independent scroll area so a long run history never pushes
              the content area (or the page) taller. */}
          <Stack gap="sm" style={{ width: 280, flexShrink: 0, height: '100%', overflowY: 'auto' }}>
            <Group justify="space-between" align="center" wrap="nowrap">
              <Title order={4}>History</Title>
              <Badge color="signalBlue" variant="light" radius="sm">
                Total: {reports.length}
              </Badge>
            </Group>
            {reports.length === 0 ? (
              // flex: 1 + justify="center" on this inner Stack (not the
              // outer sidebar Stack, which needs its own top-aligned
              // header) is what centers the bot vertically in whatever
              // space is actually left below the History/Total header,
              // rather than sitting flush under it.
              <Stack align="center" justify="center" gap="md" style={{ flex: 1 }}>
                <img
                  src="/bot-history-empty.png"
                  alt=""
                  draggable={false}
                  style={{ width: 360, height: 360, maxWidth: '100%', objectFit: 'contain' }}
                />
                <Text fw={600} size="md" c="dimmed" ta="center" style={{ letterSpacing: '0.01em' }}>
                  No runs yet.
                </Text>
              </Stack>
            ) : (
              reports.map((report) => {
                const meta = ANALYSIS_STATUS_META[report.status]
                const isSelected = report.id === selectedReportId
                return (
                  <UnstyledButton key={report.id} onClick={() => setSelectedReportId(report.id)} style={{ width: '100%' }}>
                    <Paper
                      radius="md"
                      p="sm"
                      bg="var(--doc-bg)"
                      className={classes.entryCard}
                      style={{ border: `1px solid ${isSelected ? 'var(--mantine-color-sparkOrange-6)' : 'var(--doc-hairline)'}` }}
                    >
                      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                          <Text size="sm" fw={600}>
                            {formatDateTime(report.startedAt)}
                          </Text>
                          <Text size="xs" c="dimmed" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {report.startedByEmail}
                          </Text>
                          <Badge color={meta.color} variant="light" radius="sm" size="sm" style={{ alignSelf: 'flex-start' }}>
                            {meta.label}
                          </Badge>
                        </Stack>
                        {/* stopPropagation is load-bearing - without it, this
                            click would bubble up to the surrounding
                            UnstyledButton and re-select this (about to be
                            deleted) report on the same click. Opens the
                            confirm Modal below rather than deleting
                            immediately - see attemptDelete/handleConfirmDelete
                            above. */}
                        <ActionIcon
                          size="sm"
                          aria-label={`Delete report from ${formatDateTime(report.startedAt)}`}
                          variant="subtle"
                          color="alertMagenta"
                          style={{ flexShrink: 0 }}
                          onClick={(event) => {
                            event.stopPropagation()
                            setDeleteTarget(report)
                          }}
                        >
                          <TrashIcon />
                        </ActionIcon>
                      </Group>
                    </Paper>
                  </UnstyledButton>
                )
              })
            )}
          </Stack>

          <Box aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', backgroundColor: 'var(--doc-hairline)' }} />

          <Stack gap="md" style={{ flex: 1, minWidth: 0, height: '100%' }}>
            <Group justify="space-between" align="center" wrap="wrap">
              <Title order={3}>Documentation Gap Analysis</Title>
              <Button
                variant="filled"
                color="sparkOrange"
                radius="xl"
                loading={isStarting}
                disabled={isAnalyzeDisabled}
                onClick={() => void handleStartAnalysis()}
              >
                Analyze with AI
              </Button>
            </Group>
            <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{contentBody}</Box>
          </Stack>
        </Group>
      </Paper>

      {/* History sidebar's own delete-confirm Modal - same shape as
          UploadPage.tsx's own delete Modal: opened by deleteTarget being
          non-null, only the modal's own confirm button (handleConfirmDelete)
          actually calls the delete endpoint. */}
      <Modal opened={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete report" radius="lg">
        <Stack gap="lg">
          <Text>Are you sure you want to delete this analysis report? This action cannot be undone.</Text>
          <Group justify="flex-end">
            <Button variant="subtle" color="signalBlue" radius="xl" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="filled" color="alertMagenta" radius="xl" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
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
              accentColor="alertMagenta"
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
              accentColor="signalBlue"
            />
          </Box>
        </Group>
      ) : (
        <AnalysisTab />
      )}
    </Stack>
  )
}
