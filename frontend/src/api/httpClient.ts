import type { ApiClient } from './client'
import type { Chunk } from './types'

// Real HTTP-backed ApiClient implementation, talking to the FastAPI backend
// under /internal/. Matches docker-compose's backend port mapping; this is a
// single-host local-dev app right now, so no env var plumbing is needed for
// this phase - see the plan's Task 10 notes if this ever needs to move.
const BASE_URL = 'http://localhost:8000'

// LoginPage.tsx's own request path - its 401 (wrong email/password) is an
// expected outcome with its own local "Invalid credentials" alert, so it's
// the one path excluded from throwForStatus's redirect-on-401 below.
const LOGIN_PATH = '/internal/auth/login'

/**
 * Thrown when a request is rejected with 409 Conflict. `reason` is the
 * backend's `detail` string, letting callers branch on which conflict
 * occurred (a duplicate filename on upload vs. a document that's still
 * being processed).
 */
export class ApiConflictError extends Error {
  readonly reason: 'duplicate_filename' | 'document_processing'

  constructor(reason: 'duplicate_filename' | 'document_processing') {
    super(reason)
    this.name = 'ApiConflictError'
    this.reason = reason
  }
}

/** Thrown when POST /internal/chat/messages fails with 502 (the OpenAI call failed). */
export class ChatCompletionError extends Error {
  constructor(message = 'chat_completion_failed') {
    super(message)
    this.name = 'ChatCompletionError'
  }
}

async function parseDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { detail?: string }
    return body?.detail
  } catch {
    return undefined
  }
}

/**
 * Raises the appropriate error for a non-2xx response. 409s become
 * `ApiConflictError`, 502s become `ChatCompletionError`, everything else
 * becomes a plain `Error` with a reasonable message.
 *
 * A 401 additionally triggers a hard redirect to /login (except from
 * LOGIN_PATH itself, see its comment above) - every other `/internal/*`
 * endpoint now requires a valid session, so a 401 from any of them means
 * "you're not (or no longer) logged in", whether that's this page's own
 * RequireAuth.tsx check failing on mount or an existing session's TTL
 * elapsing mid-use. `window.location.href` (not react-router's `navigate`)
 * is deliberate: a full page reload fully resets in-memory app state, which
 * is exactly right for "you got logged out". This still throws afterward
 * (navigation doesn't synchronously stop execution), so callers unwind the
 * same way they already do for any other error.
 */
async function throwForStatus(response: Response, path: string): Promise<never> {
  const detail = await parseDetail(response)

  if (response.status === 401 && path !== LOGIN_PATH) {
    window.location.href = '/login'
  }

  if (response.status === 409 && (detail === 'duplicate_filename' || detail === 'document_processing')) {
    throw new ApiConflictError(detail)
  }

  if (response.status === 502) {
    throw new ChatCompletionError(detail ?? 'chat_completion_failed')
  }

  throw new Error(detail ?? `Request failed with status ${response.status}`)
}

// Every /internal/* endpoint except login now requires the session cookie
// (see main.py's require_session wiring) - 'include' is what makes fetch
// attach it on this cross-origin (5173 -> 8000) request at all (the
// default, 'same-origin', silently omits it here). Forced unconditionally
// (after spreading `init`, not merged) so no call site can accidentally
// omit it - that gap is exactly what caused every page but the login/
// logout/me trio to 401 immediately after a successful login.
function withCredentials(init?: RequestInit): RequestInit {
  return { ...init, credentials: 'include' }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, withCredentials(init))
  if (!response.ok) {
    await throwForStatus(response, path)
  }
  return (await response.json()) as T
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${BASE_URL}${path}`, withCredentials(init))
  if (!response.ok) {
    await throwForStatus(response, path)
  }
}

export const httpApiClient: ApiClient = {
  login(email, password) {
    return requestJson('/internal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  },

  logout() {
    return requestVoid('/internal/auth/logout', { method: 'POST' })
  },

  getCurrentUser() {
    return requestJson('/internal/auth/me', { method: 'GET' })
  },

  listDocuments() {
    return requestJson('/internal/documents', { method: 'GET' })
  },

  async uploadDocument(file, overwrite) {
    const formData = new FormData()
    formData.set('file', file)
    if (overwrite === true) {
      formData.set('overwrite', 'true')
    }

    return requestJson('/internal/documents', { method: 'POST', body: formData })
  },

  deleteDocument(documentId) {
    return requestVoid(`/internal/documents/${documentId}`, { method: 'DELETE' })
  },

  getChunks(documentId) {
    return requestJson(`/internal/documents/${documentId}/chunks`, { method: 'GET' })
  },

  saveChunks(documentId, chunks, manualBoundaries) {
    // manualBoundaries only appears in the body when explicitly true - same
    // "add an optional parameter, omit it by default" pattern as
    // uploadDocument's `overwrite`, so an ordinary Save (no boundary ever
    // dragged this session) is byte-for-byte identical to the request this
    // endpoint has always sent, and the backend's existing default
    // (`manualBoundaries: false` = full algorithmic re-chunk) is untouched.
    const payload: { chunks: { editedContent: string }[]; manualBoundaries?: true } = {
      chunks: chunks.map((chunk: Chunk) => ({ editedContent: chunk.editedContent })),
    }
    if (manualBoundaries === true) {
      payload.manualBoundaries = true
    }

    return requestVoid(`/internal/documents/${documentId}/chunks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  },

  listChatMessages() {
    return requestJson('/internal/chat/messages', { method: 'GET' })
  },

  sendChatMessage(content) {
    return requestJson('/internal/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  },

  dislikeMessage(messageId) {
    return requestVoid(`/internal/chat/messages/${messageId}/dislike`, { method: 'POST' })
  },

  getDislikedMessages(range) {
    // range is URL-encoded for the same reason getDashboardStats's tz param
    // is below - a plain ImprovementsRange value never actually contains a
    // character that needs escaping, but encoding it unconditionally keeps
    // this call site consistent with that existing idiom rather than
    // special-casing "this one's safe, skip it".
    return requestJson(`/internal/chat/dislikes?range=${encodeURIComponent(range)}`, { method: 'GET' })
  },

  getNoAnswerMessages(range) {
    return requestJson(`/internal/chat/no-answer-messages?range=${encodeURIComponent(range)}`, { method: 'GET' })
  },

  dismissNoAnswerMessage(messageId) {
    return requestVoid(`/internal/chat/messages/${messageId}/dismiss-no-answer`, { method: 'POST' })
  },

  getTopMatchingChunks(content) {
    return requestJson('/internal/chat/top-chunks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  },

  getDashboardEvents() {
    return requestJson('/internal/dashboard/events', { method: 'GET' })
  },

  getDashboardStats(range, tz) {
    // tz is URL-encoded - IANA zone names contain "/" (e.g. "Europe/Kyiv"),
    // which would otherwise be read as an extra path segment by some
    // servers/proxies rather than a literal query value.
    return requestJson(`/internal/dashboard/stats?range=${range}&tz=${encodeURIComponent(tz)}`, { method: 'GET' })
  },

  getChunkGraph() {
    return requestJson('/internal/dashboard/chunk-graph', { method: 'GET' })
  },

  getOpenAiSpend() {
    return requestJson('/internal/dashboard/openai-spend', { method: 'GET' })
  },

  startAnalysisRun() {
    return requestJson('/internal/analysis/reports', { method: 'POST' })
  },

  listAnalysisReports() {
    return requestJson('/internal/analysis/reports', { method: 'GET' })
  },

  getAnalysisReport(reportId) {
    return requestJson(`/internal/analysis/reports/${reportId}`, { method: 'GET' })
  },

  deleteAnalysisReport(reportId) {
    return requestVoid(`/internal/analysis/reports/${reportId}`, { method: 'DELETE' })
  },
}
