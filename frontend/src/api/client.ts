import type {
  AnalysisReportDetail,
  AnalysisReportSummary,
  ChatMessage,
  Chunk,
  ChunkGraph,
  DashboardEvent,
  DashboardStats,
  DashboardStatsRange,
  DislikedMessage,
  DocumentSummary,
  ImprovementsRange,
  NoAnswerMessage,
  OpenAiSpend,
  RelevantChunkMatch,
} from './types'

import { httpApiClient } from './httpClient'

export interface ApiClient {
  login(email: string, password: string): Promise<{ email: string }>
  logout(): Promise<void>
  /** GET /internal/auth/me - resolves with the signed-in user, or rejects (401) if there's no valid session. Used by RequireAuth.tsx's route guard. */
  getCurrentUser(): Promise<{ email: string }>
  listDocuments(): Promise<DocumentSummary[]>
  uploadDocument(file: File, overwrite?: boolean): Promise<DocumentSummary>
  deleteDocument(documentId: string): Promise<void>
  getChunks(documentId: string): Promise<Chunk[]>
  saveChunks(documentId: string, chunks: Chunk[], manualBoundaries?: boolean): Promise<void>
  listChatMessages(): Promise<ChatMessage[]>
  sendChatMessage(content: string): Promise<ChatMessage>
  dislikeMessage(messageId: string): Promise<void>
  /** GET /internal/chat/dislikes?range=... - every message currently disliked, newest disliked_at first. Removing an entry from the Improvements page's Dislikes list reuses `dislikeMessage` above (toggles it back off) rather than a separate method. */
  getDislikedMessages(range: ImprovementsRange): Promise<DislikedMessage[]>
  /** GET /internal/chat/no-answer-messages?range=... - every message where the assistant said the answer wasn't in the documentation, newest created_at first. */
  getNoAnswerMessages(range: ImprovementsRange): Promise<NoAnswerMessage[]>
  /** POST /internal/chat/messages/{messageId}/dismiss-no-answer - one-way, clears the flag (not a toggle, unlike dislikeMessage). */
  dismissNoAnswerMessage(messageId: string): Promise<void>
  getTopMatchingChunks(content: string): Promise<RelevantChunkMatch[]>
  /** POST /internal/chat/transcribe - uploads one recorded audio clip, returns its transcribed text. Throws VoiceUnavailableError (503) if no Vosk model is configured server-side. */
  transcribeVoice(audioBlob: Blob): Promise<string>
  getDashboardEvents(): Promise<DashboardEvent[]>
  /** `tz` is an IANA zone name (e.g. "Europe/Kyiv") sent to the backend as the `tz` query param - only affects the "day" range's bucket alignment (see GET /internal/dashboard/stats's contract); "7days"/"month"/"year" ignore it entirely. */
  getDashboardStats(range: DashboardStatsRange, tz: string): Promise<DashboardStats>
  getChunkGraph(): Promise<ChunkGraph>
  getOpenAiSpend(): Promise<OpenAiSpend>
  /** POST /internal/analysis/reports - starts a new run, returns immediately with status 'running'. */
  startAnalysisRun(): Promise<AnalysisReportSummary>
  /** GET /internal/analysis/reports - every past run, newest first. */
  listAnalysisReports(): Promise<AnalysisReportSummary[]>
  /** GET /internal/analysis/reports/{reportId} - one report's full detail. */
  getAnalysisReport(reportId: string): Promise<AnalysisReportDetail>
  /** DELETE /internal/analysis/reports/{reportId} - removes one past run from history. 204 on success, 404 if it's already gone. */
  deleteAnalysisReport(reportId: string): Promise<void>
}

// Bound to the real HTTP-backed implementation. Page components always
// import `apiClient` from this module (never `httpClient`/`mockClient`
// directly) so the binding can change without touching any page component.
export const apiClient: ApiClient = httpApiClient
