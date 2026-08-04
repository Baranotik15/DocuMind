import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { waitFor } from '@testing-library/react'

import { RequireAuth } from './RequireAuth'
import { getStoredEmail, setStoredEmail } from '../utils/authStorage'
import { renderWithProviders, screen } from '../test-utils'

// RequireAuth calls the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - same convention as AppLayout.test.tsx/
// LoginPage.test.tsx, stub global `fetch` rather than reaching for a
// separate apiClient-mocking approach.

const PROTECTED_CONTENT = 'protected page content'

describe('RequireAuth', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response
  }

  function renderGuarded(): ReturnType<typeof renderWithProviders> {
    return renderWithProviders(
      <RequireAuth>
        <div>{PROTECTED_CONTENT}</div>
      </RequireAuth>,
    )
  }

  it('checks GET /internal/auth/me on mount, with credentials included, before rendering anything protected', () => {
    let resolveMe: (response: Response) => void = () => {
      throw new Error('resolveMe called before being assigned')
    }
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveMe = resolve)))

    renderGuarded()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/auth/me',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    )
    expect(screen.queryByText(PROTECTED_CONTENT)).not.toBeInTheDocument()

    // Avoid leaving an unresolved fetch dangling across tests.
    resolveMe(jsonResponse({ email: 'admin@documind.dev' }))
  })

  it('renders children once the auth check succeeds, and stores the returned email', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'admin@documind.dev' }))

    renderGuarded()

    expect(await screen.findByText(PROTECTED_CONTENT)).toBeInTheDocument()
    expect(getStoredEmail()).toBe('admin@documind.dev')
  })

  it('refreshes a stale stored email with the freshly fetched one', async () => {
    setStoredEmail('stale@documind.dev')
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'fresh@documind.dev' }))

    renderGuarded()

    expect(await screen.findByText(PROTECTED_CONTENT)).toBeInTheDocument()
    expect(getStoredEmail()).toBe('fresh@documind.dev')
  })

  it('never renders children on a 401 (no valid session)', async () => {
    // httpClient.ts's global 401 handling would otherwise attempt a real
    // `window.location.href = '/login'` navigation here, which jsdom can't
    // perform - swap in a plain writable stand-in (same technique as
    // httpClient.test.ts's redirect-on-401 tests) so that side effect is
    // harmless, and to double-check RequireAuth itself never navigates.
    const originalLocation = window.location
    // @ts-expect-error test-only override of a read-only-by-type global
    delete window.location
    // @ts-expect-error test-only override of a read-only-by-type global
    window.location = { href: 'http://localhost:5173/dashboard' }

    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'not_authenticated' }, 401))

      renderGuarded()

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      // Give the rejected promise's .catch a chance to run before asserting
      // children stayed hidden.
      await waitFor(() => expect(window.location.href).toBe('/login'))
      expect(screen.queryByText(PROTECTED_CONTENT)).not.toBeInTheDocument()
      expect(getStoredEmail()).toBeNull()
    } finally {
      // @ts-expect-error test-only restore of a read-only-by-type global
      window.location = originalLocation
    }
  })
})
