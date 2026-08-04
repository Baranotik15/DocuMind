import type { JSX } from 'react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router-dom'

import { AppLayout } from './AppLayout'
import { getStoredEmail, setStoredEmail } from '../utils/authStorage'
import { renderWithProviders, screen } from '../test-utils'

// AppLayout's "Log out" action calls apiClient.logout, which is bound to the
// real httpApiClient (frontend/src/api/httpClient.ts) and hits `fetch`
// directly - so, same as LoginPage.test.tsx/ChatPage.test.tsx, stub global
// `fetch` rather than reaching for a separate apiClient-mocking approach.

/** Bare display of the current MemoryRouter location, so a test can assert
 * where "Log out" navigated to - same technique LoginPage.test.tsx's
 * LocationProbe uses. */
function LocationProbe(): JSX.Element {
  const location = useLocation()
  return <div data-testid="location-probe">{location.pathname}</div>
}

function renderAppLayoutWithLocationProbe(): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <>
      <AppLayout>
        <div>page content</div>
      </AppLayout>
      <LocationProbe />
    </>,
  )
}

describe('AppLayout', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // authStorage is backed by localStorage - clear between tests so one
    // test's stored email can't leak into another's fresh render.
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function emptyResponse(status = 204): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new Error('no body')
      },
    } as unknown as Response
  }

  it('shows the "system ok" indicator when no browser has logged in this session', () => {
    renderWithProviders(
      <AppLayout>
        <div>page content</div>
      </AppLayout>,
    )

    expect(screen.getByText('system ok')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument()
  })

  it('shows the stored email and a Log out control instead, once a login has happened in this browser', () => {
    setStoredEmail('admin@documind.dev')

    renderWithProviders(
      <AppLayout>
        <div>page content</div>
      </AppLayout>,
    )

    expect(screen.getByText('admin@documind.dev')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument()
    expect(screen.queryByText('system ok')).not.toBeInTheDocument()
  })

  it('logs out against POST /internal/auth/logout, clears the stored email, and navigates to /login', async () => {
    setStoredEmail('admin@documind.dev')
    fetchMock.mockResolvedValueOnce(emptyResponse(204))

    renderAppLayoutWithLocationProbe()

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('/login'))

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:8000/internal/auth/logout')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')

    expect(getStoredEmail()).toBeNull()
    expect(screen.getByText('system ok')).toBeInTheDocument()
  })
})
