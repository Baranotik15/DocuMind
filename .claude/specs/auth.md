# Auth

## Goal
Give the DocuMind admin panel a real login gate — only manually-provisioned
operators can reach the upload/chunks/chat/dashboard pages — using
server-side sessions rather than token-based auth.

## Requirements
- A user must authenticate with email + password before accessing any
  admin-panel page or API endpoint.
- Successful login establishes a server-side session; the client holds only
  an opaque session identifier, never user data or credentials.
- Sessions are fixed-lifetime: once created, a session stays valid for a
  configurable TTL (default 24 hours) measured from creation, regardless of
  activity in between. There is no sliding/renewal-on-activity behavior.
- Once a session's TTL elapses, its request must be treated as
  unauthenticated — the user must log in again, even if they were active
  moments before expiry.
- A logout action immediately invalidates the session; a revoked session is
  rejected on every subsequent request even if its TTL has not yet elapsed.
- Passwords are never stored or logged in plaintext.
- There is no self-registration path — no public sign-up endpoint and no
  in-app UI to create an account. Accounts are provisioned only through a
  manual, out-of-band process.
- This spec covers only human operators of the admin panel. It has no
  bearing on how external chat-bot end-users are identified — that is a
  separate identity space handled outside this spec.

## Acceptance Criteria
- [ ] Any admin-panel page or API request without a valid session is
      rejected and the user is sent to a login screen.
- [ ] A correct email/password login succeeds and grants access to all
      admin-panel pages.
- [ ] An incorrect email/password login is rejected without revealing
      whether the email or the password was the wrong part.
- [ ] A session created at time T is still valid for a request at
      `T + TTL - 1 minute`, and rejected for a request at `T + TTL + 1
      minute` — with no dependency on activity in between.
- [ ] Logging out invalidates the session immediately; replaying the same
      session identifier afterward is rejected.
- [ ] There is no reachable way to create a new user account except the
      designated manual provisioning process.

## Non-Goals
- Self-service registration, invite flows, or in-app user-management UI.
- Password reset / forgot-password flow — account recovery is manual,
  out-of-band, for now.
- Roles or permission levels beyond "is a valid logged-in operator."
- Token-based (JWT) authentication — explicitly rejected for this phase;
  revisit only if a concrete non-browser client needs it.
- Any authentication or identity handling for chat-bot end-users (Google
  Chat, Slack, etc.) — tracked separately, not part of this spec.
- Multi-factor authentication, SSO, or third-party identity providers.

## Open Questions
- None blocking. Default session TTL is 24 hours; revisit the constant if it
  proves wrong in practice.
