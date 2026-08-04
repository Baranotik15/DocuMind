/**
 * Remembers "what email did this browser most recently log in as", purely so
 * AppLayout.tsx's header can display it - see feature/admin-auth's design.
 *
 * This is deliberately just a DISPLAY CONVENIENCE, not a real auth/session
 * mechanism: the actual session lives server-side in the httpOnly cookie
 * `POST /internal/auth/login` sets, which the browser already attaches to
 * every request automatically. Nothing reads this value to decide whether a
 * request is allowed - there's still no route guard anywhere in the app (see
 * LoginPage.tsx/App.tsx). Don't mistake this for something that guards
 * access; it can be empty/stale/wrong without affecting who can actually
 * reach any page or endpoint.
 */

const LOGGED_IN_EMAIL_KEY = 'documind.loggedInEmail'

export function getStoredEmail(): string | null {
  return window.localStorage.getItem(LOGGED_IN_EMAIL_KEY)
}

export function setStoredEmail(email: string): void {
  window.localStorage.setItem(LOGGED_IN_EMAIL_KEY, email)
}

export function clearStoredEmail(): void {
  window.localStorage.removeItem(LOGGED_IN_EMAIL_KEY)
}
