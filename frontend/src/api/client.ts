import type { Chunk, ChatMessage, DashboardEvent, DocumentSummary } from './types'

import { mockApiClient } from './mockClient'

export interface ApiClient {
  listDocuments(): Promise<DocumentSummary[]>
  uploadDocument(file: File): Promise<DocumentSummary>
  getChunks(documentId: string): Promise<Chunk[]>
  saveChunks(documentId: string, chunks: Chunk[]): Promise<void>
  listChatMessages(): Promise<ChatMessage[]>
  sendChatMessage(content: string): Promise<ChatMessage>
  dislikeMessage(messageId: string): Promise<void>
  getDashboardEvents(): Promise<DashboardEvent[]>
}

// Bound to the mock implementation for this phase. Page components always
// import `apiClient` from this module (never `mockClient` directly) so a
// later phase can swap this binding for a real HTTP-backed implementation
// without touching any page component.
export const apiClient: ApiClient = mockApiClient
