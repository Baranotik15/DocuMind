import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { ActionIcon, Alert, Badge, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core'

import classes from './ChatPage.module.css'
import { apiClient } from '../api/client'
import { ChatCompletionError } from '../api/httpClient'
import type { ChatMessage } from '../api/types'

const SEND_ERROR_MESSAGE = "The assistant couldn't respond - try again."

// Matches chatgpt.com's actual centered-column proportions (~768px there) -
// both the message list and the input bar share this exact max-width rather
// than each picking its own ratio of the surrounding flex area.
const CHAT_COLUMN_MAX_WIDTH = '50rem'

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
function BotAvatar(): JSX.Element {
  return (
    <div className={classes.botAvatar} data-testid="bot-avatar" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <rect x="5" y="8" width="14" height="11" rx="3" fill="var(--doc-void)" />
        <circle cx="9.5" cy="13.5" r="1.4" fill="var(--mantine-color-signalBlue-3)" />
        <circle cx="14.5" cy="13.5" r="1.4" fill="var(--mantine-color-signalBlue-3)" />
        <line x1="12" y1="8" x2="12" y2="4" stroke="var(--doc-void)" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="3" r="1.4" fill="var(--doc-void)" />
      </svg>
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

  useEffect(() => {
    void apiClient.listChatMessages().then(setMessages)
  }, [])

  async function handleDislike(messageId: string): Promise<void> {
    await apiClient.dislikeMessage(messageId)
    // dislikeMessage resolves to void, so the disliked flag is applied
    // locally to the already-loaded message rather than re-fetched.
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? { ...message, disliked: true } : message)),
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
        {/* Placeholder slot for the future context-switch indicator feature -
            no behavior behind it yet, per
            .claude/specs/phase-1-frontend-shell.md's Non-Goals.
            This is the one place the sparkOrange signature mark is used
            outside an "edited" state: the context indicator is about
            relevance, which is exactly what the mark signifies. Same
            left-border-plus-glow device as the active nav item / dirty
            chunks. Kept at a small radius (not a full pill) so the straight
            marked edge reads cleanly against the border-radius curve - see
            design-principles.md. */}
        <Badge
          data-testid="context-indicator"
          variant="outline"
          color="signalBlue"
          radius="sm"
          size="lg"
          style={{
            borderLeft: '3px solid var(--mantine-color-sparkOrange-6)',
            boxShadow: 'var(--doc-mark-glow)',
          }}
        >
          Context: default
        </Badge>
      </Group>

      {/* Shared centered column: the message list, the inline error, and the
          input bar all live inside this one fixed-max-width wrapper so their
          proportions match chatgpt.com's layout (one centered ~50rem column)
          instead of the list floating pills asymmetrically indented by a
          percentage of the viewport while the input bar used a different
          ratio of the flex area. */}
      <Stack gap="md" w="100%" maw={CHAT_COLUMN_MAX_WIDTH} mx="auto" style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="md" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }} py="md">
          {messages.map((message) => (
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
                  <Text ff="monospace" size="lg">
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
          ))}

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
