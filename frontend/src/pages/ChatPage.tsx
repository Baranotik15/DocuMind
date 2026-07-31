import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { Badge, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core'

import { apiClient } from '../api/client'
import type { ChatMessage } from '../api/types'

export function ChatPage(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')

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

    const sent = await apiClient.sendChatMessage(content)
    setMessages((current) => [...current, sent])
    setDraft('')
  }

  return (
    <Stack gap="lg" maw={900}>
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

      <Stack gap="md">
        {messages.map((message) => (
          <Paper
            key={message.id}
            data-message-id={message.id}
            radius="xl"
            p="lg"
            bg={message.role === 'user' ? 'rgba(61, 107, 255, 0.16)' : 'var(--doc-surface)'}
            style={{
              marginLeft: message.role === 'user' ? '15%' : 0,
              marginRight: message.role === 'assistant' ? '15%' : 0,
              border: `1px solid ${
                message.role === 'user' ? 'var(--mantine-color-signalBlue-7)' : 'var(--doc-hairline)'
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

      <Group align="flex-end">
        <TextInput
          label="Message"
          placeholder="Type a message"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          size="md"
          style={{ flex: 1 }}
        />
        <Button onClick={() => void handleSend()} color="sparkOrange" radius="xl" size="md" px="xl">
          Send
        </Button>
      </Group>
    </Stack>
  )
}
