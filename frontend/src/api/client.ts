import type { ChatMessage, Chunk, ChunkGraph, DashboardEvent, DashboardStats, DashboardStatsRange, DocumentSummary, OpenAiSpend, RelevantChunkMatch } from './types'

import { httpApiClient } from './httpClient'

export interface ApiClient {
  listDocuments(): Promise<DocumentSummary[]>
  uploadDocument(file: File, overwrite?: boolean): Promise<DocumentSummary>
  deleteDocument(documentId: string): Promise<void>
  getChunks(documentId: string): Promise<Chunk[]>
  saveChunks(documentId: string, chunks: Chunk[], manualBoundaries?: boolean): Promise<void>
  listChatMessages(): Promise<ChatMessage[]>
  sendChatMessage(content: string): Promise<ChatMessage>
  dislikeMessage(messageId: string): Promise<void>
  getTopMatchingChunks(content: string): Promise<RelevantChunkMatch[]>
  getDashboardEvents(): Promise<DashboardEvent[]>
  getDashboardStats(range: DashboardStatsRange): Promise<DashboardStats>
  getChunkGraph(): Promise<ChunkGraph>
  getOpenAiSpend(): Promise<OpenAiSpend>
}

// Bound to the real HTTP-backed implementation. Page components always
// import `apiClient` from this module (never `httpClient`/`mockClient`
// directly) so the binding can change without touching any page component.
export const apiClient: ApiClient = httpApiClient
