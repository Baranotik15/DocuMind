import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { ActionIcon, Alert, Badge, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import { ChatCompletionError } from '../api/httpClient'
import type { ChatMessage } from '../api/types'

const SEND_ERROR_MESSAGE = "The assistant couldn't respond - try again."

/** Simple send-arrow glyph - no icon library installed (see design-principles.md). */
function SendIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}

export function ChatPage(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sendFailed, setSendFailed] = useState(false)

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

      <Stack gap="md" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }} py="md">
        {messages.map((message) => (
          <Paper
            key={message.id}
            data-message-id={message.id}
            radius="xl"
            p="lg"
            bg={message.role === 'user' ? 'rgba(255, 167, 38, 0.16)' : 'var(--doc-surface)'}
            style={{
              marginLeft: message.role === 'user' ? '15%' : 0,
              marginRight: message.role === 'assistant' ? '15%' : 0,
              border: `1px solid ${
                message.role === 'user' ? 'var(--mantine-color-sparkOrange-6)' : 'var(--doc-hairline)'
              }`,
            }}
          >
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Text ff="monospace" size="lg">
                {message.content}
              </Text>
              {message.role === 'assistant' ? (
                <Button
                  aria-label={message.disliked ? 'Message disliked' : 'Dislike message'}
                  aria-pressed={message.disliked}
                  variant={message.disliked ? 'filled' : 'outline'}
                  color="alertMagenta"
                  radius="xl"
                  size="sm"
                  px="lg"
                  onClick={() => void handleDislike(message.id)}
                >
                  👎
                </Button>
              ) : null}
            </Group>
          </Paper>
        ))}
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
        maw="50%"
        mx="auto"
        style={{ border: '1px solid var(--doc-hairline)', flexShrink: 0, width: '100%' }}
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
  )
}
