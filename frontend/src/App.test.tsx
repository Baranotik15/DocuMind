import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { render, screen } from './test-utils'

// App composes its own <MantineProvider>/<BrowserRouter> (per its contract),
// so it is rendered directly here rather than via `renderWithProviders` -
// wrapping it in another Router would trip react-router's "cannot render a
// Router inside another Router" invariant. `renderWithProviders` remains for
// page-level component tests that don't bring their own router (Tasks 3-6).
describe('App', () => {
  beforeEach(() => {
    // The default route redirects to /upload, which mounts UploadPage and
    // fires a real apiClient.listDocuments() call on mount (apiClient is
    // httpApiClient as of Task 10) - stub fetch so that resolves instead of
    // hitting a real, unstubbed ECONNREFUSED and logging an unhandled
    // rejection this test doesn't otherwise care about.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the DocuMind brand and navigation links to all pages', () => {
    render(<App />)

    expect(screen.getByText('DocuMind')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /upload/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /chat/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /logs & stats/i })).toBeInTheDocument()
  })
})
