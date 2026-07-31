import type { JSX } from 'react'

import { useEffect, useState } from 'react'

import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core'

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
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Chat</Title>
        {/* Placeholder slot for the future context-switch indicator feature -
            no behavior behind it yet, per
            .claude/specs/phase-1-frontend-shell.md's Non-Goals. */}
        <Badge data-testid="context-indicator" variant="light">
          Context: default
        </Badge>
      </Group>

      <Stack gap="sm">
        {messages.map((message) => (
          <Paper
            key={message.id}
            data-message-id={message.id}
            withBorder
            p="sm"
            radius="md"
            bg={message.role === 'user' ? 'blue.0' : 'gray.0'}
            style={{
              marginLeft: message.role === 'user' ? '20%' : 0,
              marginRight: message.role === 'assistant' ? '20%' : 0,
            }}
          >
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Text>{message.content}</Text>
              {message.role === 'assistant' ? (
                <ActionIcon
                  aria-label={message.disliked ? 'Message disliked' : 'Dislike message'}
                  aria-pressed={message.disliked}
                  variant={message.disliked ? 'filled' : 'outline'}
                  color="red"
                  onClick={() => void handleDislike(message.id)}
                >
                  👎
                </ActionIcon>
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
          style={{ flex: 1 }}
        />
        <Button onClick={() => void handleSend()}>Send</Button>
      </Group>
    </Stack>
  )
}
