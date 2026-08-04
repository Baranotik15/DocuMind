import type { JSX } from 'react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MantineProvider } from '@mantine/core'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { LoginPage } from './LoginPage'
import { getStoredEmail } from '../utils/authStorage'
import { renderWithProviders, screen } from '../test-utils'

// LoginPage talks to the real httpApiClient (frontend/src/api/httpClient.ts),
// which hits `fetch` directly - so, same as httpClient.test.ts and the other
// rewritten page tests (UploadPage.test.tsx, ChatPage.test.tsx), stub global
// `fetch` rather than relying on mockClient.ts's seeded in-memory data.

/** Bare display of the current MemoryRouter location, so a test can assert on
 * where a successful login navigated to - same technique
 * ChunkGraphPanel.test.tsx's LocationProbe uses. */
function LocationProbe(): JSX.Element {
  const location = useLocation()
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>
}

function renderLoginPageWithLocationProbe(): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
        <LocationProbe />
      </MemoryRouter>
    </MantineProvider>,
  )
}

describe('LoginPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // A successful login now calls setStoredEmail (see authStorage.ts) -
    // clear between tests so one test's stored email can't leak into
    // another's.
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

  function fillAndSubmit(email: string, password: string): void {
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } })
    fireEvent.change(screen.getByLabelText(/password/i, { selector: 'input' }), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  }

  it('renders the DocuMind brand, email/password fields, and a Log in submit button', () => {
    renderWithProviders(<LoginPage />)

    expect(screen.getByText('DocuMind')).toBeInTheDocument()
    // Regex (not an exact string) because the Mantine label also carries a
    // visually-appended `*` for the `required` field (see LoginPage.tsx) -
    // same "match the visible name loosely" idiom as ChatPage.test.tsx's
    // /message/i query. `selector: 'input'` on the password field excludes
    // Mantine's own show/hide-password toggle button, which also carries an
    // aria-label containing "password".
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i, { selector: 'input' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
  })

  it('updates the email and password fields as the user types', () => {
    renderWithProviders(<LoginPage />)

    const emailInput = screen.getByLabelText(/email/i)
    const passwordInput = screen.getByLabelText(/password/i, { selector: 'input' })

    fireEvent.change(emailInput, { target: { value: 'admin@documind.dev' } })
    fireEvent.change(passwordInput, { target: { value: 'hunter2' } })

    expect(emailInput).toHaveValue('admin@documind.dev')
    expect(passwordInput).toHaveValue('hunter2')
  })

  it('logs in against POST /internal/auth/login with credentials included, and navigates to the main page on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'admin@documind.dev' }))

    renderLoginPageWithLocationProbe()

    fillAndSubmit('admin@documind.dev', 'hunter2')

    await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('/'))

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:8000/internal/auth/login')
    expect(init.method).toBe('POST')
    // The cookie-based session only gets set/sent on a cross-origin request
    // (localhost:5173 -> localhost:8000) if this is included explicitly.
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'admin@documind.dev', password: 'hunter2' })

    // See authStorage.ts - remembers the logged-in email for AppLayout's
    // header to display, purely for display, not a real auth check.
    expect(getStoredEmail()).toBe('admin@documind.dev')
  })

  it('shows the "Invalid credentials" alert on a 401 invalid_credentials response, without navigating', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'invalid_credentials' }, 401))

    renderLoginPageWithLocationProbe()

    fillAndSubmit('admin@documind.dev', 'wrong-password')

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
    expect(screen.getByText("That email or password wasn't recognized. Please try again.")).toBeInTheDocument()
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/login')
  })

  it('shows a generic failure alert (not "Invalid credentials") for an unexpected error, e.g. a 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'internal_error' }, 500))

    renderLoginPageWithLocationProbe()

    fillAndSubmit('admin@documind.dev', 'hunter2')

    expect(await screen.findByText('Log in failed')).toBeInTheDocument()
    expect(screen.queryByText('Invalid credentials')).not.toBeInTheDocument()
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/login')
  })

  it('shows the loading state while the login request is in flight, and resets it once the request fails', async () => {
    let resolveLogin: (response: Response) => void = () => {
      throw new Error('resolveLogin called before being assigned')
    }
    const loginResponse = new Promise<Response>((resolve) => {
      resolveLogin = resolve
    })
    fetchMock.mockReturnValueOnce(loginResponse)

    renderLoginPageWithLocationProbe()

    fillAndSubmit('admin@documind.dev', 'wrong-password')

    const submitButton = screen.getByRole('button', { name: 'Log in' })
    expect(submitButton).toBeDisabled()

    resolveLogin(jsonResponse({ detail: 'invalid_credentials' }, 401))

    await waitFor(() => expect(submitButton).not.toBeDisabled())
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
  })
})
