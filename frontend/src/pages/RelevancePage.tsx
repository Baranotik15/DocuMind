import type { JSX } from 'react'

import { useState } from 'react'

import { ActionIcon, Alert, Box, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import type { RelevantChunkMatch } from '../api/types'

const SEARCH_ERROR_MESSAGE = "Couldn't retrieve matching chunks - try again."

// The last submitted question and its results survive navigating away and
// back (the route unmounts this page) and a page reload, exactly like
// ChatPage's "Clear chat" localStorage persistence - they stay visible
// until the next search completes, which overwrites this entry.
const LAST_SEARCH_STORAGE_KEY = 'documind:relevance:lastSearch'

interface PersistedSearch {
  query: string
  results: RelevantChunkMatch[]
}

function loadPersistedSearch(): PersistedSearch | null {
  try {
    const raw = window.localStorage.getItem(LAST_SEARCH_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as PersistedSearch
    return typeof parsed.query === 'string' && Array.isArray(parsed.results) ? parsed : null
  } catch {
    // Malformed/inaccessible storage degrades to "nothing persisted" rather
    // than throwing - same rationale as ChatPage's hidden-message-ids store.
    return null
  }
}

function savePersistedSearch(search: PersistedSearch): void {
  try {
    window.localStorage.setItem(LAST_SEARCH_STORAGE_KEY, JSON.stringify(search))
  } catch {
    // Failing to persist just means this search won't survive a reload -
    // not worth surfacing to the user over.
  }
}

/** Simple send-arrow glyph - same as ChatPage's own SendIcon (no icon library installed, see design-principles.md). */
function SearchArrowIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

export function RelevancePage(): JSX.Element {
  const persisted = loadPersistedSearch()
  const [query, setQuery] = useState(persisted?.query ?? '')
  const [results, setResults] = useState<RelevantChunkMatch[]>(persisted?.results ?? [])
  const [hasSearched, setHasSearched] = useState(persisted !== null)
  const [isSearching, setIsSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)

  async function handleSearch(): Promise<void> {
    const content = query.trim()
    if (!content) {
      return
    }
    setIsSearching(true)
    setSearchFailed(false)
    try {
      const matches = await apiClient.getTopMatchingChunks(content)
      setResults(matches)
      setHasSearched(true)
      savePersistedSearch({ query: content, results: matches })
    } catch {
      setSearchFailed(true)
    } finally {
      setIsSearching(false)
    }
  }

  return (
    // Fixed to the viewport height below the AppShell header (same
    // `calc(100dvh - ...)` device as ChatPage's own outer Stack) so only
    // the results list below scrolls internally - previously this whole
    // page had no scroll container of its own and just scrolled the
    // document/body, putting the scrollbar at the far edge of the browser
    // window instead of against this page's own (centered, maw={900})
    // content column, per explicit request to move it there.
    <Stack
      gap="lg"
      w="100%"
      maw={900}
      mx="auto"
      style={{ height: 'calc(100dvh - var(--app-shell-header-height, 68px) - 2 * var(--mantine-spacing-lg))' }}
    >
      <Title order={2}>Relevance Preview</Title>
      <Text size="sm" c="dimmed">
        See which chunks would be retrieved for a question, and how closely each one matches, before it ever
        reaches the chat.
      </Text>

      <Group gap="xs" wrap="nowrap">
        <TextInput
          aria-label="Question"
          placeholder="Ask a question to preview its top matching chunks..."
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void handleSearch()
            }
          }}
          size="lg"
          style={{ flex: 1 }}
        />
        <ActionIcon
          aria-label="Search"
          onClick={() => void handleSearch()}
          loading={isSearching}
          color="sparkOrange"
          radius="xl"
          size="xl"
          variant="filled"
        >
          <SearchArrowIcon />
        </ActionIcon>
      </Group>

      {searchFailed ? (
        <Alert color="alertMagenta" variant="light" radius="lg" title="Something went wrong">
          {SEARCH_ERROR_MESSAGE}
        </Alert>
      ) : null}

      {hasSearched && !isSearching && !searchFailed && results.length === 0 ? (
        <Text c="dimmed">No matching chunks found - upload a ready document first, then try again.</Text>
      ) : null}

      {/* The one scrollable region on this page - flex: 1 claims whatever
          height the header content above didn't use, minHeight: 0 lets it
          actually shrink below its content's natural size instead of
          forcing the outer Stack to overflow (a flex item's default
          min-height is `auto`, i.e. its content's full height, which would
          otherwise defeat overflowY: auto here the same way it would on
          ChatPage's own message list - see that page's identical
          minHeight: 0 comment). pr="md" gives the scrollbar the same
          breathing room from the cards as ChatPage's message list gives it
          from the message bubbles. */}
      <Stack gap="md" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }} pr="md">
        {results.map((match, index) => (
          <Paper key={match.chunkId} radius="lg" p="lg" bg="var(--doc-surface)" withBorder>
            <Stack gap="sm">
              <Group justify="space-between" align="center" wrap="nowrap" gap="md">
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Text fw={700} c="dimmed" style={{ flexShrink: 0 }}>
                    #{index + 1}
                  </Text>
                  <Text fw={700} truncate>
                    {match.filename}
                  </Text>
                </Group>
                <Text fw={700} size="lg" style={{ flexShrink: 0 }}>
                  {match.matchPercent}%
                </Text>
              </Group>
              {/* Single-hue sequential bar (magnitude, not a category) - same
                  track+glow-fill device as DashboardPage's "events by type"
                  bars, just always signalBlue here since these 5 rows are
                  ranked instances of the SAME metric, not different kinds of
                  thing. */}
              <Box style={{ backgroundColor: 'rgba(232, 237, 250, 0.06)', borderRadius: 'var(--mantine-radius-xl)', overflow: 'hidden' }}>
                <Box
                  h={10}
                  style={{
                    width: `${match.matchPercent}%`,
                    minWidth: 4,
                    borderRadius: 'var(--mantine-radius-xl)',
                    backgroundColor: 'var(--mantine-color-signalBlue-6)',
                    boxShadow: '0 0 12px rgba(61, 107, 255, 0.55)',
                    transition: 'width 200ms ease',
                  }}
                />
              </Box>
              <Text ff="monospace" size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {match.content}
              </Text>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Stack>
  )
}
