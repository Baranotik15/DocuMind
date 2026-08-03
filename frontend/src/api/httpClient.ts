import type { ApiClient } from './client'
import type { Chunk } from './types'

// Real HTTP-backed ApiClient implementation, talking to the FastAPI backend
// under /internal/. Matches docker-compose's backend port mapping; this is a
// single-host local-dev app right now, so no env var plumbing is needed for
// this phase - see the plan's Task 10 notes if this ever needs to move.
const BASE_URL = 'http://localhost:8000'

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
 */
async function throwForStatus(response: Response): Promise<never> {
  const detail = await parseDetail(response)

  if (response.status === 409 && (detail === 'duplicate_filename' || detail === 'document_processing')) {
    throw new ApiConflictError(detail)
  }

  if (response.status === 502) {
    throw new ChatCompletionError(detail ?? 'chat_completion_failed')
  }

  throw new Error(detail ?? `Request failed with status ${response.status}`)
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, init)
  if (!response.ok) {
    await throwForStatus(response)
  }
  return (await response.json()) as T
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${BASE_URL}${path}`, init)
  if (!response.ok) {
    await throwForStatus(response)
  }
}

export const httpApiClient: ApiClient = {
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

  getDashboardStats(range) {
    return requestJson(`/internal/dashboard/stats?range=${range}`, { method: 'GET' })
  },

  getChunkGraph() {
    return requestJson('/internal/dashboard/chunk-graph', { method: 'GET' })
  },
}
