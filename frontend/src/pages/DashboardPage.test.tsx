import { describe, expect, it } from 'vitest'

import { within } from '@testing-library/react'

import { DashboardPage } from './DashboardPage'
import { renderWithProviders, screen } from '../test-utils'

describe('DashboardPage', () => {
  it('lists all seeded dashboard events with their type and detail', async () => {
    renderWithProviders(<DashboardPage />)

    // The new "events by type" bar visualization also renders each event
    // `type` string as a bar label, so `type` values now appear twice on the
    // page (once as a bar label, once as a table cell) - queries are scoped
    // to the detail table (the same element/assertion as before, just
    // disambiguated) rather than the whole document. `detail` sentences
    // remain unique to the table, so those queries are unchanged.
    const table = await screen.findByRole('table')

    expect(await within(table).findByText('document.uploaded')).toBeInTheDocument()
    expect(await screen.findByText('onboarding-notes.docx was uploaded.')).toBeInTheDocument()

    expect(await within(table).findByText('document.chunked')).toBeInTheDocument()
    expect(await screen.findByText('architecture-guide.pdf was split into 3 chunks.')).toBeInTheDocument()

    expect(await within(table).findByText('chat.message')).toBeInTheDocument()
    expect(await screen.findByText('A user asked how to upload a new document.')).toBeInTheDocument()

    expect(await within(table).findByText('document.chunking_started')).toBeInTheDocument()
    expect(await screen.findByText('release-plan.md chunking started.')).toBeInTheDocument()
  })
})
