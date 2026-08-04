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
    // The `/*` route is now gated by RequireAuth (see App.tsx), which fires
    // GET /internal/auth/me on mount before rendering AppLayout at all; once
    // that succeeds, the default route redirects to /upload, which mounts
    // UploadPage and fires its own apiClient.listDocuments() call. A single
    // blanket stub - resolving `ok: true` with an empty array body for any
    // URL - satisfies both real calls (apiClient is httpApiClient) without
    // hitting a real, unstubbed ECONNREFUSED and logging an unhandled
    // rejection this test doesn't otherwise care about.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('renders the DocuMind brand and navigation links to all pages', async () => {
    render(<App />)

    // RequireAuth's own GET /internal/auth/me resolves asynchronously (even
    // though stubbed) - AppLayout, and everything below it, only mounts once
    // that settles, so the first assertion has to wait for it.
    expect(await screen.findByText('DocuMind')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /upload/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /chat/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /logs & stats/i })).toBeInTheDocument()
  })
})
