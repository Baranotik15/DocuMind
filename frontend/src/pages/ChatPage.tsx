import type { JSX } from 'react'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ActionIcon, Alert, Box, Button, Group, Modal, Paper, Stack, Text, TextInput, Title } from '@mantine/core'

import classes from './ChatPage.module.css'
import { apiClient } from '../api/client'
import { ChatCompletionError } from '../api/httpClient'
import type { ChatMessage } from '../api/types'

const SEND_ERROR_MESSAGE = "The assistant couldn't respond - try again."

// "Clear chat" (see handleClearChat) never deletes anything server-side -
// chat history has no session/user scoping at all, so hiding a message
// forever, for THIS browser only, means remembering which specific message
// ids were visible at the moment of the last clear and filtering them back
// out on every future load, including after a reload (a plain in-memory
// flag wouldn't survive that). localStorage (not sessionStorage) is
// deliberate: it's meant to persist exactly like a real "cleared history"
// would, not just for the current tab session.
const HIDDEN_MESSAGE_IDS_STORAGE_KEY = 'documind:chat:hiddenMessageIds'

function loadHiddenMessageIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_MESSAGE_IDS_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    // Malformed/inaccessible storage (privacy mode, quota, corrupted JSON)
    // degrades to "nothing hidden" rather than throwing - Clear chat is a
    // display convenience, not something that should ever crash the page.
    return new Set()
  }
}

function saveHiddenMessageIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(HIDDEN_MESSAGE_IDS_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // See loadHiddenMessageIds - failing to persist just means the clear
    // won't survive a reload this one time, not worth surfacing to the
    // operator over.
  }
}

// There's no account/session system in this app at all (see
// HIDDEN_MESSAGE_IDS_STORAGE_KEY's own comment) - so "remember where THIS
// viewer left off" can only ever mean "remember it for this browser," via
// the same localStorage-per-browser convention as hidden message ids above,
// not a real per-account preference. Stores a message id (which message was
// scrolled to, not a raw pixel offset) deliberately: chat history is shared/
// unscoped, so it can keep growing between visits from other tabs/people -
// a raw scrollTop pixel value would land in a misleading spot once that
// happens, while "scroll back to THIS message" stays correct regardless of
// how much content now precedes or follows it.
const LAST_SCROLL_MESSAGE_ID_STORAGE_KEY = 'documind:chat:lastScrollMessageId'

function loadLastScrollMessageId(): string | null {
  try {
    return window.localStorage.getItem(LAST_SCROLL_MESSAGE_ID_STORAGE_KEY)
  } catch {
    // Same degrade-quietly reasoning as loadHiddenMessageIds - worst case,
    // this load falls back to the default (scroll to bottom).
    return null
  }
}

function saveLastScrollMessageId(messageId: string): void {
  try {
    window.localStorage.setItem(LAST_SCROLL_MESSAGE_ID_STORAGE_KEY, messageId)
  } catch {
    // See loadLastScrollMessageId - failing to persist just means the next
    // load defaults to the bottom instead of this exact spot, not worth
    // surfacing to the operator over.
  }
}

function clearLastScrollMessageId(): void {
  try {
    window.localStorage.removeItem(LAST_SCROLL_MESSAGE_ID_STORAGE_KEY)
  } catch {
    // Best-effort, same as the rest of this file's localStorage writes.
  }
}

// How close to the true bottom (in px of unscrolled content below the
// viewport) still counts as "at the bottom" for auto-scroll purposes below -
// a small forgiveness margin, not an exact 0, since sub-pixel layout
// rounding can leave scrollTop a fraction short of scrollHeight-clientHeight
// even when a viewer's eye reads the list as fully scrolled down.
const NEAR_BOTTOM_THRESHOLD_PX = 80

// Debounce for persisting the scroll-anchor message id (see
// LAST_SCROLL_MESSAGE_ID_STORAGE_KEY) - saving on every single scroll tick
// would mean dozens of localStorage writes for one drag/flick; waiting for
// scrolling to actually pause first is both cheaper and a better proxy for
// "this is genuinely where the viewer stopped," not just a point it
// happened to fly past.
const SAVE_SCROLL_POSITION_DEBOUNCE_MS = 300

// The topmost message currently at least partially visible inside `list` -
// used both to decide what to persist as the scroll anchor (see
// handleMessageListScroll) and, in reverse, to scroll a restored anchor
// back into that same "topmost visible" position (see the initial-restore
// branch of the auto-scroll effect). Compares getBoundingClientRect()
// output (viewport coordinates) for both the container and each message,
// rather than `element.offsetTop` against `list.scrollTop` - offsetTop is
// relative to the nearest positioned ANCESTOR, which isn't guaranteed to be
// `list` itself, while getBoundingClientRect() sidesteps that ambiguity
// entirely by comparing everything in the same (viewport) coordinate space.
function findTopmostVisibleMessageId(list: HTMLElement): string | null {
  const containerTop = list.getBoundingClientRect().top
  const messageElements = list.querySelectorAll<HTMLElement>('[data-message-id]')
  for (const element of messageElements) {
    if (element.getBoundingClientRect().bottom > containerTop) {
      return element.dataset.messageId ?? null
    }
  }
  return null
}

// Both the message list and the input bar share this exact max-width rather
// than each picking its own ratio of the surrounding flex area. Widened from
// an initial 50rem (chatgpt.com's own ~768px column) per explicit request,
// in two live-tested passes - that read as too narrow, with messages cramped
// relative to the available page width.
const CHAT_COLUMN_MAX_WIDTH = '72rem'

/** Simple send-arrow glyph - no icon library installed (see design-principles.md). */
function SendIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}

/** Hand-rolled thumbs-down glyph - same no-icon-library rationale as SendIcon above, replaces the previous literal 👎 glyph (illegible at small sizes). */
function ThumbsDownIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z" />
      <path d="M17 2h4v12h-4" />
    </svg>
  )
}

/**
 * Small identity avatar shown next to assistant messages (and the typing
 * indicator) only - never next to the user's own messages. A filled
 * signalBlue circle with a minimal bot-head glyph, pairing with the user's
 * sparkOrange bubble border as the app's two-accent brand pairing (see
 * design-principles.md).
 */
/**
 * Custom avatar image, swappable by just replacing the file at
 * `frontend/public/bot-avatar.png` - `public/` assets are served as-is at a
 * stable URL (no import/rebuild needed to pick up a new file, unlike
 * `src/assets/`), so this is a drop-in replacement. Recommended source
 * image: square, at least 256x256px (comfortably covers this 4rem/64px
 * circle even at 2-3x display pixel density), PNG or WEBP. It's rendered
 * `object-fit: cover` inside a `border-radius: 50%` circle (see
 * `.botAvatarImage` in ChatPage.module.css), so a non-square image gets
 * center-cropped to a circle - square avoids that entirely.
 */
const BOT_AVATAR_IMAGE_SRC = '/bot-avatar.png'

function BotAvatar(): JSX.Element {
  // Falls back to the hand-drawn glyph below if the image 404s (e.g. no
  // custom avatar has been dropped in at BOT_AVATAR_IMAGE_SRC yet) - a
  // broken-image icon would otherwise show in every message bubble.
  const [imageFailed, setImageFailed] = useState(false)
  return (
    <div className={classes.botAvatar} data-testid="bot-avatar" aria-hidden="true">
      {imageFailed ? (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <rect x="5" y="8" width="14" height="11" rx="3" fill="var(--doc-void)" />
          <circle cx="9.5" cy="13.5" r="1.4" fill="var(--mantine-color-signalBlue-3)" />
          <circle cx="14.5" cy="13.5" r="1.4" fill="var(--mantine-color-signalBlue-3)" />
          <line x1="12" y1="8" x2="12" y2="4" stroke="var(--doc-void)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="12" cy="3" r="1.4" fill="var(--doc-void)" />
        </svg>
      ) : (
        <img
          src={BOT_AVATAR_IMAGE_SRC}
          alt=""
          draggable={false}
          className={classes.botAvatarImage}
          onError={() => setImageFailed(true)}
        />
      )}
    </div>
  )
}

export function ChatPage(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sendFailed, setSendFailed] = useState(false)
  // True for the span between handleSend firing the request and the reply
  // (or a ChatCompletionError) resolving - drives the typing-indicator bubble
  // below, since without it the UI looks frozen after the optimistic user
  // message appears.
  const [isSending, setIsSending] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  // The scrollable message list itself (the inner Stack below, not the
  // outer page column) - read/written directly via scrollTop/scrollHeight
  // in the auto-scroll effect below, rather than through React state, since
  // scroll position changes on every frame of a drag and has no business
  // triggering a re-render.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Whether the viewer was scrolled at/near the bottom the last time they
  // touched the scroll position - a ref (not state) so onScroll doesn't
  // re-render on every tick, and so the auto-scroll effect below always
  // reads the truly latest value rather than one from a stale closure.
  // Starts `true` deliberately: before the viewer has scrolled at all (most
  // importantly, on first load), this app should default to the bottom of
  // the conversation, not the top - per explicit request. Only flips to
  // `false` once they've actually scrolled away from the bottom themselves
  // (see handleMessageListScroll), so a reply arriving while they're
  // reading older history never yanks their place out from under them.
  const isNearBottomRef = useRef(true)
  // Debounce handle for persisting the scroll anchor (see
  // handleMessageListScroll/SAVE_SCROLL_POSITION_DEBOUNCE_MS) - re-armed on
  // every scroll tick so only the FINAL tick in a burst actually writes to
  // localStorage.
  const saveScrollPositionTimeoutRef = useRef<number | null>(null)
  // Flips true the instant the initial listChatMessages() fetch resolves
  // (see the mount effect below) - BEFORE setMessages, and independent of
  // whether the fetched list is empty or not. The one-time initial-restore
  // branch of the auto-scroll effect needs to fire exactly once real data
  // has arrived, which `messages.length > 0` alone can't distinguish from
  // "genuinely zero chat history ever" (both look like an empty array).
  const hasFetchedMessagesRef = useRef(false)
  // Guards the auto-scroll effect's one-time "restore the saved anchor, or
  // default to the bottom" branch so it only ever runs once per mount, not
  // on every later messages/isSending change (which should keep using the
  // ordinary near-bottom auto-follow behavior below it instead).
  const hasRestoredInitialScrollRef = useRef(false)

  function handleMessageListScroll(event: React.UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
    isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX

    if (saveScrollPositionTimeoutRef.current !== null) {
      window.clearTimeout(saveScrollPositionTimeoutRef.current)
    }
    saveScrollPositionTimeoutRef.current = window.setTimeout(() => {
      const topmostVisibleMessageId = findTopmostVisibleMessageId(list)
      if (topmostVisibleMessageId) {
        saveLastScrollMessageId(topmostVisibleMessageId)
      }
    }, SAVE_SCROLL_POSITION_DEBOUNCE_MS)
  }

  // Clears any pending debounced save so it can't fire (and write to
  // localStorage) after this page has navigated away.
  useEffect(() => {
    return () => {
      if (saveScrollPositionTimeoutRef.current !== null) {
        window.clearTimeout(saveScrollPositionTimeoutRef.current)
      }
    }
  }, [])

  // Keeps the message list pinned to the bottom - on first load, restores
  // wherever this browser last left off instead (see
  // LAST_SCROLL_MESSAGE_ID_STORAGE_KEY), falling back to the bottom if
  // there's no saved anchor or it no longer matches a currently-visible
  // message (e.g. hidden by a later Clear chat) - and again every time the
  // visible content changes height (a new message appended, or the typing
  // indicator appearing/disappearing) PROVIDED the viewer was already at/
  // near the bottom right before this change. useLayoutEffect (not
  // useEffect) so this runs before the browser paints the new content -
  // otherwise a viewer could see one frame of the list at its old scroll
  // position before it snaps to the restored/new one.
  useLayoutEffect(() => {
    const list = scrollContainerRef.current
    if (!list) {
      return
    }

    if (!hasRestoredInitialScrollRef.current) {
      if (!hasFetchedMessagesRef.current) {
        // Still waiting on the initial fetch (this is the pre-fetch empty
        // render) - nothing to restore against yet, try again once
        // messages actually updates for real.
        return
      }
      hasRestoredInitialScrollRef.current = true

      const savedMessageId = loadLastScrollMessageId()
      const savedElement = savedMessageId
        ? [...list.querySelectorAll<HTMLElement>('[data-message-id]')].find(
            (element) => element.dataset.messageId === savedMessageId,
          )
        : undefined
      if (savedElement) {
        savedElement.scrollIntoView({ block: 'start' })
      } else {
        list.scrollTop = list.scrollHeight
      }
      // Whichever branch above ran, isNearBottomRef needs to reflect where
      // that actually landed - a restored anchor partway up the list must
      // NOT be treated as "near the bottom" (which would wrongly let the
      // very next message auto-scroll the viewer away from the spot they
      // were just returned to).
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX
      return
    }

    if (!isNearBottomRef.current) {
      return
    }
    list.scrollTop = list.scrollHeight
  }, [messages, isSending])

  useEffect(() => {
    void apiClient.listChatMessages().then((allMessages) => {
      const hiddenIds = loadHiddenMessageIds()
      hasFetchedMessagesRef.current = true
      setMessages(allMessages.filter((message) => !hiddenIds.has(message.id)))
    })
  }, [])

  // Local/display-only, deliberately: this does NOT call the backend or
  // touch chat_messages at all - per explicit requirement, the underlying
  // history stays saved in the database (there is no session/user scoping
  // on that table - see backend/app/routers/chat.py - so nothing server-
  // side is "this browser's session" to begin with), only this browser's
  // current view of it clears. Still gated behind the confirm Modal below
  // (same Modal>Stack>body-Text+Group[flex-end] structure as UploadPage's
  // Delete/Overwrite confirms and ChunkPreviewPage's discard-changes
  // confirm) purely to avoid an accidental click wiping the visible
  // conversation, even though it's no longer a destructive/unrecoverable
  // action.
  //
  // Records every currently-visible message's id into the persisted
  // hidden-ids set (see loadHiddenMessageIds/HIDDEN_MESSAGE_IDS_STORAGE_KEY
  // above) BEFORE clearing, rather than just emptying local state - a plain
  // `setMessages([])` would silently undo itself the moment the mount
  // effect above re-fetches on the next reload, since nothing was actually
  // deleted server-side. Merges into whatever was already hidden from a
  // previous clear (rather than overwriting it) so an earlier clear can
  // never accidentally un-hide itself.
  //
  // Also drops the saved scroll anchor (LAST_SCROLL_MESSAGE_ID_STORAGE_KEY)
  // - it can only ever point at a message this same clear just hid, so
  // leaving it behind would just make the NEXT load's restore silently
  // no-op (already handled gracefully, see the auto-scroll effect's
  // fallback-to-bottom branch) instead of cleanly reflecting that there's
  // nothing to restore to anymore.
  function handleClearChat(): void {
    setShowClearConfirm(false)
    setMessages((current) => {
      const hiddenIds = loadHiddenMessageIds()
      current.forEach((message) => hiddenIds.add(message.id))
      saveHiddenMessageIds(hiddenIds)
      return []
    })
    clearLastScrollMessageId()
  }

  // The backend endpoint toggles (flips whatever `disliked` currently is),
  // not just sets it true - a plain on/off dislike button, matching the
  // like/dislike toggle convention most chat UIs use, since a single click
  // is easy to land by accident with no way to undo it otherwise. Flips the
  // LOCAL optimistic state to match, rather than waiting on a response body
  // (dislikeMessage still resolves to void) - safe exactly because both
  // sides apply the same flip, starting from the same known prior value.
  async function handleDislike(messageId: string): Promise<void> {
    await apiClient.dislikeMessage(messageId)
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? { ...message, disliked: !message.disliked } : message)),
    )
  }

  async function handleSend(): Promise<void> {
    const content = draft.trim()
    if (!content) {
      return
    }

    // The backend's response to a send is now the assistant's reply only
    // (not an echo of the user's own message, per
    // .claude/specs/phase-2-backend-integration.md's Chat requirements), so
    // the operator's own message is appended optimistically here rather than
    // waiting on the network round trip to see it show up at all.
    const optimisticUserMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      disliked: false,
    }
    setMessages((current) => [...current, optimisticUserMessage])
    setDraft('')
    setSendFailed(false)
    setIsSending(true)

    try {
      const reply = await apiClient.sendChatMessage(content)
      setMessages((current) => [...current, reply])
    } catch (error) {
      if (!(error instanceof ChatCompletionError)) {
        throw error
      }
      // The user's message IS persisted server-side even though the OpenAI
      // call failed (per spec) - it stays in the list; only the assistant
      // reply is missing, surfaced here rather than left as an unhandled
      // rejection.
      setSendFailed(true)
    } finally {
      // Runs on every path (success, handled ChatCompletionError, and the
      // rethrow above) so the indicator never gets stuck visible.
      setIsSending(false)
    }
  }

  return (
    <Stack
      gap="lg"
      // Fills the remaining viewport height below the AppShell header, so
      // the message list can scroll internally while the input stays
      // pinned at the true bottom of the screen regardless of how many
      // messages there are (position: sticky alone doesn't do this when
      // content is shorter than the viewport - there's nothing to scroll
      // against yet, so it never reaches its stuck position).
      style={{ height: 'calc(100dvh - var(--app-shell-header-height, 68px) - 2 * var(--mantine-spacing-lg))' }}
    >
      <Group justify="space-between">
        <Title order={2}>Chat</Title>
        {/* Outline (not subtle/filled) - a clearly-shaped, bordered pill
            reads as an actual button rather than a bare colored text link,
            per explicit feedback that `variant="subtle"` looked broken/
            unstyled. `disabled` still genuinely blocks the click (and stays
            correctly non-focusable/non-clickable for a11y) when there are
            no messages, but className={classes.clearChatButton} overrides
            Mantine's own disabled-state color/background reset so it reads
            IDENTICAL to the enabled state either way, per explicit request -
            only the cursor (also from that class) communicates
            "can't click this right now" on hover. */}
        <Button
          variant="outline"
          color="alertMagenta"
          radius="xl"
          disabled={messages.length === 0}
          onClick={() => setShowClearConfirm(true)}
          className={classes.clearChatButton}
        >
          Clear chat
        </Button>
      </Group>

      <Modal
        opened={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Clear chat window?"
        radius="lg"
      >
        <Stack gap="lg">
          <Text>This clears the conversation from view - the history stays saved and comes back if you reload.</Text>
          <Group justify="flex-end">
            <Button variant="subtle" color="signalBlue" radius="xl" onClick={() => setShowClearConfirm(false)}>
              Keep visible
            </Button>
            <Button variant="filled" color="alertMagenta" radius="xl" onClick={handleClearChat}>
              Clear chat window
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Shared centered column: the message list, the inline error, and the
          input bar all live inside this one fixed-max-width wrapper (see
          CHAT_COLUMN_MAX_WIDTH) so their proportions match - one centered
          column - instead of the list floating pills asymmetrically indented
          by a percentage of the viewport while the input bar used a
          different ratio of the flex area. */}
      <Stack gap="md" w="100%" maw={CHAT_COLUMN_MAX_WIDTH} mx="auto" style={{ flex: 1, minHeight: 0 }}>
        {/* The message list's scrollbar is styled by the app-wide rule in
            global.css (applies to every scrollable element automatically) -
            this used to need its own classes.scrollArea here; per explicit
            follow-up request to keep a scroll affordance, just one that
            looks like it belongs in this app, that's now true everywhere,
            not just here. pr="md" gives it breathing room from the message
            bubbles - it sat flush against their edge without this. */}
        <Stack
          ref={scrollContainerRef}
          onScroll={handleMessageListScroll}
          gap="md"
          style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
          py="md"
          pr="md"
        >
          {messages.length === 0 ? (
            // Centered welcome state rather than a blank column - the same
            // BotAvatar used next to every assistant reply below, so the
            // "first thing you see" and "who's replying to you" are visibly
            // the same identity, wrapped in a soft signalBlue glow (a plain
            // ambient highlight, NOT the sparkOrange signature mark - this
            // isn't an edited/active/contextually-relevant element in the
            // mark's own defined sense, see design-principles.md) so it
            // reads as a deliberate hero moment instead of a stray icon.
            <Stack align="center" justify="center" gap="sm" style={{ flex: 1, height: '100%' }}>
              <Box style={{ filter: 'drop-shadow(0 0 24px rgba(61, 107, 255, 0.45))' }}>
                <BotAvatar />
              </Box>
              <Title order={3} ta="center">
                Ask DocuMind about your documents
              </Title>
              <Text c="dimmed" ta="center" maw={420}>
                Upload a document on the Upload page, then ask a question here - answers are grounded in what
                you've actually uploaded.
              </Text>
            </Stack>
          ) : (
            messages.map((message) => (
              <Group
                key={message.id}
                data-message-id={message.id}
                align="flex-start"
                wrap="nowrap"
                gap="sm"
                justify={message.role === 'user' ? 'flex-end' : 'flex-start'}
              >
                {message.role === 'assistant' ? <BotAvatar /> : null}
                <Paper
                  radius="xl"
                  p="lg"
                  maw="75%"
                  bg={message.role === 'user' ? 'rgba(255, 202, 40, 0.16)' : 'var(--doc-surface)'}
                  style={{
                    border: `1px solid ${
                      message.role === 'user' ? 'var(--mantine-color-sparkOrange-6)' : 'var(--doc-hairline)'
                    }`,
                  }}
                >
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                    {/* white-space: pre-wrap - a plain <Text> collapses '\n'
                        into a space by default, which would flatten the
                        system prompt's own requested line breaks/lists back
                        into one dense paragraph (see chat_system_prompt.txt's
                        formatting rule). pre-wrap still wraps long lines
                        normally, it just also respects explicit newlines. */}
                    <Text ff="monospace" size="lg" style={{ whiteSpace: 'pre-wrap' }}>
                      {message.content}
                    </Text>
                    {message.role === 'assistant' ? (
                      <ActionIcon
                        aria-label={message.disliked ? 'Message disliked' : 'Dislike message'}
                        aria-pressed={message.disliked}
                        variant={message.disliked ? 'filled' : 'outline'}
                        color="alertMagenta"
                        radius="xl"
                        size="lg"
                        onClick={() => void handleDislike(message.id)}
                      >
                        <ThumbsDownIcon />
                      </ActionIcon>
                    ) : null}
                  </Group>
                </Paper>
              </Group>
            ))
          )}

          {isSending ? (
            <Group data-testid="typing-indicator" align="flex-start" wrap="nowrap" gap="sm" justify="flex-start">
              <BotAvatar />
              <Paper radius="xl" p="lg" bg="var(--doc-surface)" style={{ border: '1px solid var(--doc-hairline)' }}>
                <Group gap={6} role="status" aria-label="Assistant is composing a reply">
                  <span className={classes.typingDot} />
                  <span className={classes.typingDot} />
                  <span className={classes.typingDot} />
                </Group>
              </Paper>
            </Group>
          ) : null}
        </Stack>

        {sendFailed ? (
          <Alert
            color="alertMagenta"
            variant="light"
            radius="lg"
            title="Something went wrong"
            withCloseButton
            onClose={() => setSendFailed(false)}
            style={{ flexShrink: 0 }}
          >
            {SEND_ERROR_MESSAGE}
          </Alert>
        ) : null}

        {/* Naturally pinned at the bottom: it's the last child of the
            fixed-height flex column above, after the scrollable message
            list - not `position: sticky`, which only engages once there's
            overflow to stick against. Single rounded pill (ChatGPT-style)
            rather than a separate input + button, re-colored to our palette:
            surface background, sparkOrange circular send action. */}
        <Paper
          radius="xl"
          p="xs"
          bg="var(--doc-surface)"
          w="100%"
          style={{ border: '1px solid var(--doc-hairline)', flexShrink: 0 }}
          my="md"
        >
          <Group gap="xs" wrap="nowrap">
            <TextInput
              aria-label="Message"
              placeholder="Message DocuMind"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleSend()
                }
              }}
              variant="unstyled"
              size="lg"
              style={{ flex: 1 }}
              styles={{ input: { paddingLeft: 'var(--mantine-spacing-md)' } }}
            />
            <ActionIcon
              aria-label="Send"
              onClick={() => void handleSend()}
              color="sparkOrange"
              radius="xl"
              size="xl"
              variant="filled"
            >
              <SendIcon />
            </ActionIcon>
          </Group>
        </Paper>
      </Stack>
    </Stack>
  )
}
