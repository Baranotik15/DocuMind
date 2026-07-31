import type { ApiClient } from './client'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each test gets a fresh module instance (and therefore a fresh in-memory
// store) so tests don't leak mutations into one another - the mock client
// itself has no test-only reset hook, per the ApiClient contract.
describe('mockApiClient', () => {
  let mockApiClient: ApiClient

  beforeEach(async () => {
    vi.resetModules()
    ;({ mockApiClient } = await import('./mockClient'))
  })

  it('resolves seeded documents from listDocuments', async () => {
    const documents = await mockApiClient.listDocuments()

    expect(documents.length).toBeGreaterThanOrEqual(2)
    const statuses = new Set(documents.map((document) => document.status))
    expect(statuses.size).toBeGreaterThanOrEqual(2)
  })

  it('returns only chunks belonging to the requested document', async () => {
    const documents = await mockApiClient.listDocuments()
    const chunkedDocument = documents.find((document) => document.status === 'ready')
    expect(chunkedDocument).toBeDefined()

    const chunks = await mockApiClient.getChunks(chunkedDocument!.id)

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.every((chunk) => chunk.documentId === chunkedDocument!.id)).toBe(true)
  })

  it('reflects edited content and clears isDirty after saveChunks', async () => {
    const documents = await mockApiClient.listDocuments()
    const chunkedDocument = documents.find((document) => document.status === 'ready')!
    const originalChunks = await mockApiClient.getChunks(chunkedDocument.id)

    const editedChunks = originalChunks.map((chunk) => ({
      ...chunk,
      editedContent: `${chunk.editedContent} (edited)`,
      isDirty: true,
    }))

    await mockApiClient.saveChunks(chunkedDocument.id, editedChunks)
    const savedChunks = await mockApiClient.getChunks(chunkedDocument.id)

    expect(savedChunks).toHaveLength(editedChunks.length)
    for (const chunk of savedChunks) {
      expect(chunk.editedContent.endsWith('(edited)')).toBe(true)
      expect(chunk.isDirty).toBe(false)
    }
  })

  it('flips disliked to true for the targeted message', async () => {
    const messages = await mockApiClient.listChatMessages()
    const assistantMessage = messages.find((message) => message.role === 'assistant')!

    await mockApiClient.dislikeMessage(assistantMessage.id)
    const updatedMessages = await mockApiClient.listChatMessages()
    const updated = updatedMessages.find((message) => message.id === assistantMessage.id)

    expect(updated?.disliked).toBe(true)
  })

  it('throws when disliking an unknown message id', async () => {
    await expect(mockApiClient.dislikeMessage('does-not-exist')).rejects.toThrow()
  })

  it('adds the uploaded document to subsequent listDocuments calls', async () => {
    const file = new File(['contents'], 'new-upload.txt', { type: 'text/plain' })

    const uploaded = await mockApiClient.uploadDocument(file)
    const documents = await mockApiClient.listDocuments()

    expect(uploaded.filename).toBe('new-upload.txt')
    expect(documents.some((document) => document.id === uploaded.id)).toBe(true)
  })

  it('appends the sent message to subsequent listChatMessages calls', async () => {
    const sent = await mockApiClient.sendChatMessage('What formats are supported?')
    const messages = await mockApiClient.listChatMessages()

    expect(sent.role).toBe('user')
    expect(sent.content).toBe('What formats are supported?')
    expect(messages.some((message) => message.id === sent.id)).toBe(true)
  })

  it('resolves seeded events from getDashboardEvents', async () => {
    const events = await mockApiClient.getDashboardEvents()

    expect(events.length).toBeGreaterThanOrEqual(2)
  })
})
