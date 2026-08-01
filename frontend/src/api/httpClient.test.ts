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

  it('throws a plain Error on an unexpected non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'boom' }, 500))

    const { httpApiClient, ApiConflictError, ChatCompletionError } = await import('./httpClient')

    const promise = httpApiClient.listDocuments()
    await expect(promise).rejects.toThrow(Error)
    await expect(promise).rejects.not.toBeInstanceOf(ApiConflictError)
    await expect(promise).rejects.not.toBeInstanceOf(ChatCompletionError)
  })
})
