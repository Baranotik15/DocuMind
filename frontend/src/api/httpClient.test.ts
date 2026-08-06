import type { Chunk } from './types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real HTTP-backed ApiClient implementation, tested against a stubbed
// global fetch - no network access, no MSW, per the plan's Task 10.

describe('httpApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response
  }

  function emptyResponse(status = 204) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new Error('no body')
      },
    } as unknown as Response
  }

  it('listDocuments GETs /internal/documents and returns the parsed array', async () => {
    const documents = [
      { id: 'doc-1', filename: 'a.txt', status: 'ready', uploadedAt: '2026-01-01T00:00:00.000Z' },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(documents))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.listDocuments()

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/internal/documents', expect.objectContaining({ method: 'GET' }))
    expect(result).toEqual(documents)
  })

  it('uploadDocument POSTs multipart form data without overwrite when the second arg is omitted', async () => {
    const summary = { id: 'doc-1', filename: 'a.txt', status: 'uploaded', uploadedAt: '2026-01-01T00:00:00.000Z' }
    fetchMock.mockResolvedValueOnce(jsonResponse(summary))
    const file = new File(['contents'], 'a.txt', { type: 'text/plain' })

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.uploadDocument(file)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8000/internal/documents')
    expect(init.method).toBe('POST')
    const body = init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('file')).toBe(file)
    expect(body.has('overwrite')).toBe(false)
    expect(result).toEqual(summary)
  })

  it('uploadDocument sends the overwrite form field only when the second arg is true', async () => {
    const summary = { id: 'doc-1', filename: 'a.txt', status: 'uploaded', uploadedAt: '2026-01-01T00:00:00.000Z' }
    fetchMock.mockResolvedValueOnce(jsonResponse(summary))
    const file = new File(['contents'], 'a.txt', { type: 'text/plain' })

    const { httpApiClient } = await import('./httpClient')
    await httpApiClient.uploadDocument(file, true)

    const [, init] = fetchMock.mock.calls[0]
    const body = init.body as FormData
    expect(body.get('overwrite')).toBe('true')
  })

  it('uploadDocument rejects with ApiConflictError(duplicate_filename) on a 409', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'duplicate_filename' }, 409))
    const file = new File(['contents'], 'a.txt', { type: 'text/plain' })

    const { httpApiClient, ApiConflictError } = await import('./httpClient')

    const promise = httpApiClient.uploadDocument(file)
    await expect(promise).rejects.toBeInstanceOf(ApiConflictError)
    await expect(promise).rejects.toMatchObject({ reason: 'duplicate_filename' })
  })

  it('uploadDocument rejects with ApiConflictError(document_processing) on a 409', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'document_processing' }, 409))
    const file = new File(['contents'], 'a.txt', { type: 'text/plain' })

    const { httpApiClient, ApiConflictError } = await import('./httpClient')

    const promise = httpApiClient.uploadDocument(file)
    await expect(promise).rejects.toBeInstanceOf(ApiConflictError)
    await expect(promise).rejects.toMatchObject({ reason: 'document_processing' })
  })

  it('uploadDocument rejects with a plain Error on a 400', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'unsupported_file_type' }, 400))
    const file = new File(['contents'], 'a.exe', { type: 'application/octet-stream' })

    const { httpApiClient, ApiConflictError } = await import('./httpClient')

    const promise = httpApiClient.uploadDocument(file)
    await expect(promise).rejects.toThrow(Error)
    await expect(promise).rejects.not.toBeInstanceOf(ApiConflictError)
  })

  it('deleteDocument DELETEs /internal/documents/{id} and resolves on 204', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204))

    const { httpApiClient } = await import('./httpClient')
    await httpApiClient.deleteDocument('doc-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/documents/doc-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('deleteDocument rejects with ApiConflictError(document_processing) on a 409', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'document_processing' }, 409))

    const { httpApiClient, ApiConflictError } = await import('./httpClient')

    const promise = httpApiClient.deleteDocument('doc-1')
    await expect(promise).rejects.toBeInstanceOf(ApiConflictError)
    await expect(promise).rejects.toMatchObject({ reason: 'document_processing' })
  })

  it('deleteDocument rejects with a plain Error on a 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'document_not_found' }, 404))

    const { httpApiClient, ApiConflictError } = await import('./httpClient')

    const promise = httpApiClient.deleteDocument('doc-1')
    await expect(promise).rejects.toThrow(Error)
    await expect(promise).rejects.not.toBeInstanceOf(ApiConflictError)
  })

  it('getChunks GETs /internal/documents/{id}/chunks and returns the parsed array', async () => {
    const chunks: Chunk[] = [
      { id: 'chunk-1', documentId: 'doc-1', originalContent: 'a', editedContent: 'a', isDirty: false },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(chunks))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.getChunks('doc-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/documents/doc-1/chunks',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual(chunks)
  })

  it('saveChunks POSTs JSON of the edited chunk contents and resolves on 202', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(202))
    const chunks: Chunk[] = [
      { id: 'chunk-1', documentId: 'doc-1', originalContent: 'a', editedContent: 'a edited', isDirty: true },
    ]

    const { httpApiClient } = await import('./httpClient')
    await httpApiClient.saveChunks('doc-1', chunks)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8000/internal/documents/doc-1/chunks')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ chunks: [{ editedContent: 'a edited' }] })
  })

  it('saveChunks includes manualBoundaries: true in the body only when the third arg is explicitly true', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(202))
    const chunks: Chunk[] = [
      { id: 'chunk-1', documentId: 'doc-1', originalContent: 'a', editedContent: 'a edited', isDirty: true },
    ]

    const { httpApiClient } = await import('./httpClient')
    await httpApiClient.saveChunks('doc-1', chunks, true)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string)).toEqual({
      chunks: [{ editedContent: 'a edited' }],
      manualBoundaries: true,
    })
  })

  it('saveChunks rejects with ApiConflictError(document_processing) on a 409', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'document_processing' }, 409))
    const chunks: Chunk[] = [
      { id: 'chunk-1', documentId: 'doc-1', originalContent: 'a', editedContent: 'a', isDirty: false },
    ]

    const { httpApiClient, ApiConflictError } = await import('./httpClient')

    const promise = httpApiClient.saveChunks('doc-1', chunks)
    await expect(promise).rejects.toBeInstanceOf(ApiConflictError)
    await expect(promise).rejects.toMatchObject({ reason: 'document_processing' })
  })

  it('listChatMessages GETs /internal/chat/messages and returns the parsed array', async () => {
    const messages = [{ id: 'msg-1', role: 'user', content: 'hi', disliked: false }]
    fetchMock.mockResolvedValueOnce(jsonResponse(messages))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.listChatMessages()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/chat/messages',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual(messages)
  })

  it('sendChatMessage POSTs the content and resolves with the assistant reply', async () => {
    const reply = { id: 'msg-2', role: 'assistant', content: 'hello there', disliked: false }
    fetchMock.mockResolvedValueOnce(jsonResponse(reply))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.sendChatMessage('hi')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8000/internal/chat/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hi' })
    expect(result).toEqual(reply)
  })

  it('sendChatMessage rejects with ChatCompletionError on a 502', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'chat_completion_failed' }, 502))

    const { httpApiClient, ChatCompletionError } = await import('./httpClient')

    await expect(httpApiClient.sendChatMessage('hi')).rejects.toBeInstanceOf(ChatCompletionError)
  })

  it('dislikeMessage POSTs to the dislike endpoint and resolves on 204', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204))

    const { httpApiClient } = await import('./httpClient')
    await httpApiClient.dislikeMessage('msg-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/chat/messages/msg-1/dislike',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('getDislikedMessages GETs /internal/chat/dislikes with the range query param and returns the parsed array', async () => {
    const messages = [
      {
        id: 'msg-1',
        content: 'reply text',
        questionContent: 'question text',
        dislikedAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-31T23:59:00.000Z',
      },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(messages))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.getDislikedMessages('7days')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/chat/dislikes?range=7days',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual(messages)
  })

  it('getNoAnswerMessages GETs /internal/chat/no-answer-messages with the range query param and returns the parsed array', async () => {
    const messages = [
      {
        id: 'msg-2',
        content: 'reply text',
        questionContent: 'question text',
        createdAt: '2026-07-31T23:59:00.000Z',
      },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(messages))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.getNoAnswerMessages('day')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/chat/no-answer-messages?range=day',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual(messages)
  })

  it('dismissNoAnswerMessage POSTs to the dismiss-no-answer endpoint and resolves on 204', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204))

    const { httpApiClient } = await import('./httpClient')
    await httpApiClient.dismissNoAnswerMessage('msg-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/chat/messages/msg-1/dismiss-no-answer',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('getTopMatchingChunks POSTs the question and returns the parsed matches', async () => {
    const matches = [
      { chunkId: 'chunk-1', documentId: 'doc-1', filename: 'guide.pdf', content: 'excerpt one', matchPercent: 87.3 },
      { chunkId: 'chunk-2', documentId: 'doc-1', filename: 'guide.pdf', content: 'excerpt two', matchPercent: 54.1 },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(matches))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.getTopMatchingChunks('What formats are supported?')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/chat/top-chunks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'What formats are supported?' }),
      }),
    )
    expect(result).toEqual(matches)
  })

  it('getDashboardEvents GETs /internal/dashboard/events and returns the parsed array', async () => {
    const events = [{ id: 'event-1', type: 'document.uploaded', timestamp: '2026-01-01T00:00:00.000Z', detail: 'x' }]
    fetchMock.mockResolvedValueOnce(jsonResponse(events))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.getDashboardEvents()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/dashboard/events',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual(events)
  })

  it('startAnalysisRun POSTs /internal/analysis/reports and returns the parsed summary', async () => {
    const summary = {
      id: 'analysis-1',
      status: 'running',
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: null,
      startedByEmail: 'admin@documind.dev',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(summary, 201))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.startAnalysisRun()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/analysis/reports',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result).toEqual(summary)
  })

  it('listAnalysisReports GETs /internal/analysis/reports and returns the parsed array', async () => {
    const reports = [
      {
        id: 'analysis-1',
        status: 'completed',
        startedAt: '2026-08-06T00:00:00.000Z',
        completedAt: '2026-08-06T00:02:00.000Z',
        startedByEmail: 'admin@documind.dev',
      },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(reports))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.listAnalysisReports()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/analysis/reports',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual(reports)
  })

  it('getAnalysisReport GETs /internal/analysis/reports/{id} and returns the parsed detail', async () => {
    const detail = {
      id: 'abc',
      status: 'completed',
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:02:00.000Z',
      startedByEmail: 'admin@documind.dev',
      gapAnalysis: 'Some themes worth documenting.',
      conflicts: [],
      totalTokens: 123,
      errorDetail: null,
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(detail))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.getAnalysisReport('abc')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/analysis/reports/abc',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toEqual(detail)
  })

  it('deleteAnalysisReport DELETEs /internal/analysis/reports/{id} and resolves on 204', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204))

    const { httpApiClient } = await import('./httpClient')
    await httpApiClient.deleteAnalysisReport('analysis-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/analysis/reports/analysis-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('throws a plain Error on an unexpected non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'boom' }, 500))

    const { httpApiClient, ApiConflictError, ChatCompletionError } = await import('./httpClient')

    const promise = httpApiClient.listDocuments()
    await expect(promise).rejects.toThrow(Error)
    await expect(promise).rejects.not.toBeInstanceOf(ApiConflictError)
    await expect(promise).rejects.not.toBeInstanceOf(ChatCompletionError)
  })

  it('getCurrentUser GETs /internal/auth/me with credentials included and returns the parsed user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'admin@documind.dev' }))

    const { httpApiClient } = await import('./httpClient')
    const result = await httpApiClient.getCurrentUser()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/internal/auth/me',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    )
    expect(result).toEqual({ email: 'admin@documind.dev' })
  })

  // Every `/internal/*` endpoint now requires a valid session (see
  // feature/admin-auth's final slice) - a 401 from any of them means "you're
  // not (or no longer) logged in" and should bounce the whole app back to
  // /login via a hard navigation, except the login endpoint's own 401 (its
  // expected "wrong credentials" outcome, asserted separately below).
  describe('redirect-on-401', () => {
    let originalLocation: Location

    beforeEach(() => {
      originalLocation = window.location
      // jsdom logs "Not implemented: navigation" (and doesn't let assertions
      // observe the assignment) for a real `window.location.href = ...` -
      // swap in a plain writable stand-in so the redirect can be asserted on
      // directly, then restore the real one afterward.
      // @ts-expect-error test-only override of a read-only-by-type global
      delete window.location
      // @ts-expect-error test-only override of a read-only-by-type global
      window.location = { href: 'http://localhost:5173/dashboard' }
    })

    afterEach(() => {
      // @ts-expect-error test-only restore of a read-only-by-type global
      window.location = originalLocation
    })

    it('redirects to /login on a 401 from an ordinary endpoint', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'not_authenticated' }, 401))

      const { httpApiClient } = await import('./httpClient')

      await expect(httpApiClient.listDocuments()).rejects.toThrow('not_authenticated')
      expect(window.location.href).toBe('/login')
    })

    it('redirects to /login on a 401 from getCurrentUser itself', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'not_authenticated' }, 401))

      const { httpApiClient } = await import('./httpClient')

      await expect(httpApiClient.getCurrentUser()).rejects.toThrow('not_authenticated')
      expect(window.location.href).toBe('/login')
    })

    it('does NOT redirect on a 401 from /internal/auth/login - LoginPage handles that case itself', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'invalid_credentials' }, 401))

      const { httpApiClient } = await import('./httpClient')

      await expect(httpApiClient.login('admin@documind.dev', 'wrong')).rejects.toThrow('invalid_credentials')
      expect(window.location.href).toBe('http://localhost:5173/dashboard')
    })
  })
})
