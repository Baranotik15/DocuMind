import { describe, expect, it } from 'vitest'

import { App } from './App'
import { render, screen } from './test-utils'

// App composes its own <MantineProvider>/<BrowserRouter> (per its contract),
// so it is rendered directly here rather than via `renderWithProviders` -
// wrapping it in another Router would trip react-router's "cannot render a
// Router inside another Router" invariant. `renderWithProviders` remains for
// page-level component tests that don't bring their own router (Tasks 3-6).
describe('App', () => {
  it('renders the DocuMind brand and navigation links to all four pages', () => {
    render(<App />)

    expect(screen.getByText('DocuMind')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /upload/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /chunks/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /chat/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
  })
})
