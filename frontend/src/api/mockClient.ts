import type { ApiClient } from './client'
import type { Chunk, ChatMessage, DashboardEvent, DocumentSummary } from './types'

// In-memory mock store. This module stands in for the real backend during
// Phase 1 - `apiClient` (see client.ts) is the only supported way to reach
// it. Mutated in place by the methods below so repeated calls within a
// running app observe each other's writes, same as a real API would.

const documents: DocumentSummary[] = [
  {
    id: 'doc-1',
    filename: 'architecture-guide.pdf',
    status: 'ready',
    uploadedAt: '2026-07-20T09:15:00.000Z',
  },
  {
    id: 'doc-2',
    filename: 'onboarding-notes.docx',
    status: 'uploaded',
    uploadedAt: '2026-07-28T14:02:00.000Z',
  },
  {
    id: 'doc-3',
    filename: 'release-plan.md',
    status: 'chunking',
    uploadedAt: '2026-07-30T11:47:00.000Z',
  },
]

let chunks: Chunk[] = [
  {
    id: 'chunk-1',
    documentId: 'doc-1',
    originalContent: 'Section 1: Introduction to the system architecture.',
    editedContent: 'Section 1: Introduction to the system architecture.',
    isDirty: false,
  },
  {
    id: 'chunk-2',
    documentId: 'doc-1',
    originalContent: 'Section 2: Data flow between services.',
    editedContent: 'Section 2: Data flow between services.',
    isDirty: false,
  },
  {
    id: 'chunk-3',
    documentId: 'doc-1',
    originalContent: 'Section 3: Deployment topology.',
    editedContent: 'Section 3: Deployment topology.',
    isDirty: false,
  },
]

const chatMessages: ChatMessage[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'How do I upload a new document?',
    disliked: false,
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'Go to the Upload page and choose a file to add it to the library.',
    disliked: false,
  },
  {
    id: 'msg-3',
    role: 'user',
    content: 'Can I edit the generated chunks afterward?',
    disliked: false,
  },
  {
    id: 'msg-4',
    role: 'assistant',
    content: 'Yes, open the Chunks page, edit any chunk inline, and click Save.',
    disliked: false,
  },
]

const dashboardEvents: DashboardEvent[] = [
  {
    id: 'event-1',
    type: 'document.uploaded',
    timestamp: '2026-07-28T14:02:00.000Z',
    detail: 'onboarding-notes.docx was uploaded.',
  },
  {
    id: 'event-2',
    type: 'document.chunked',
    timestamp: '2026-07-20T09:20:00.000Z',
    detail: 'architecture-guide.pdf was split into 3 chunks.',
  },
  {
    id: 'event-3',
    type: 'chat.message',
    timestamp: '2026-07-29T10:05:00.000Z',
    detail: 'A user asked how to upload a new document.',
  },
  {
    id: 'event-4',
    type: 'document.chunking_started',
    timestamp: '2026-07-30T11:47:30.000Z',
    detail: 'release-plan.md chunking started.',
  },
]

// Counters seeded past the ids above so newly created rows never collide
// with seed data.
let nextDocumentId = documents.length + 1
let nextMessageId = chatMessages.length + 1

export const mockApiClient: ApiClient = {
  async listDocuments() {
    return documents.map((document) => ({ ...document }))
  },

  async uploadDocument(file) {
    const document: DocumentSummary = {
      id: `doc-${nextDocumentId++}`,
      filename: file.name,
      status: 'uploaded',
      uploadedAt: new Date().toISOString(),
    }
    documents.push(document)
    return { ...document }
  },

  async getChunks(documentId) {
    return chunks.filter((chunk) => chunk.documentId === documentId).map((chunk) => ({ ...chunk }))
  },

  async saveChunks(documentId, updatedChunks) {
    const savedChunks = updatedChunks.map((chunk) => ({ ...chunk, isDirty: false }))
    chunks = [...chunks.filter((chunk) => chunk.documentId !== documentId), ...savedChunks]
  },

  async listChatMessages() {
    return chatMessages.map((message) => ({ ...message }))
  },

  async sendChatMessage(content) {
    const message: ChatMessage = {
      id: `msg-${nextMessageId++}`,
      role: 'user',
      content,
      disliked: false,
    }
    chatMessages.push(message)
    return { ...message }
  },

  async dislikeMessage(messageId) {
    const message = chatMessages.find((candidate) => candidate.id === messageId)
    if (!message) {
      throw new Error(`dislikeMessage: no chat message found with id "${messageId}"`)
    }
    message.disliked = true
  },

  async getDashboardEvents() {
    return dashboardEvents.map((event) => ({ ...event }))
  },
}
