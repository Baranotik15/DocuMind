import { describe, expect, it } from 'vitest'

import { DashboardPage } from './DashboardPage'
import { renderWithProviders, screen } from '../test-utils'

describe('DashboardPage', () => {
  it('lists all seeded dashboard events with their type and detail', async () => {
    renderWithProviders(<DashboardPage />)

    // Seeded events (see mockClient.ts) load asynchronously.
    expect(await screen.findByText('document.uploaded')).toBeInTheDocument()
    expect(await screen.findByText('onboarding-notes.docx was uploaded.')).toBeInTheDocument()

    expect(await screen.findByText('document.chunked')).toBeInTheDocument()
    expect(await screen.findByText('architecture-guide.pdf was split into 3 chunks.')).toBeInTheDocument()

    expect(await screen.findByText('chat.message')).toBeInTheDocument()
    expect(await screen.findByText('A user asked how to upload a new document.')).toBeInTheDocument()

    expect(await screen.findByText('document.chunking_started')).toBeInTheDocument()
    expect(await screen.findByText('release-plan.md chunking started.')).toBeInTheDocument()
  })
})
