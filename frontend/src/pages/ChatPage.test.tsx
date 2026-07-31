import { describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor, within } from '@testing-library/react'

import { ChatPage } from './ChatPage'
import { apiClient } from '../api/client'
import { renderWithProviders, screen } from '../test-utils'

describe('ChatPage', () => {
  it('renders seeded messages and the context-indicator placeholder', async () => {
    renderWithProviders(<ChatPage />)

    // Seeded chat messages (see mockClient.ts) load asynchronously.
    expect(await screen.findByText('How do I upload a new document?')).toBeInTheDocument()
    expect(
      await screen.findByText('Go to the Upload page and choose a file to add it to the library.'),
    ).toBeInTheDocument()
    expect(await screen.findByText('Can I edit the generated chunks afterward?')).toBeInTheDocument()
    expect(
      await screen.findByText('Yes, open the Chunks page, edit any chunk inline, and click Save.'),
    ).toBeInTheDocument()

    // Placeholder slot for the future context-switch indicator feature - no
    // behavior expected yet, per .claude/specs/phase-1-frontend-shell.md's
    // Non-Goals.
    expect(screen.getByTestId('context-indicator')).toBeInTheDocument()
  })

  it('dislikes an assistant message and reflects the disliked state visually', async () => {
    // Spy on (rather than replace) the real apiClient - dislikeMessage is
    // the external boundary this test asserts against, but the mock
    // client's own store/branching logic still runs for real, per
    // .claude/docs/testing.md's "mock at the right level" guidance.
    const dislikeSpy = vi.spyOn(apiClient, 'dislikeMessage')

    renderWithProviders(<ChatPage />)

    const assistantMessageText = await screen.findByText(
      'Go to the Upload page and choose a file to add it to the library.',
    )
    const messageContainer = assistantMessageText.closest('[data-message-id="msg-2"]')
    expect(messageContainer).not.toBeNull()

    const dislikeButton = within(messageContainer as HTMLElement).getByRole('button', { name: /dislike message/i })
    fireEvent.click(dislikeButton)

    await waitFor(() => expect(dislikeSpy).toHaveBeenCalledWith('msg-2'))
    await waitFor(() => {
      expect(
        within(messageContainer as HTMLElement).getByRole('button', { name: /message disliked/i }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    dislikeSpy.mockRestore()
  })

  it('sends a new message and appends it to the rendered list', async () => {
    renderWithProviders(<ChatPage />)

    await screen.findByText('How do I upload a new document?')

    const input = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(input, { target: { value: 'What file formats are supported?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(await screen.findByText('What file formats are supported?')).toBeInTheDocument()
  })
})
