export interface DocumentSummary {
  id: string
  filename: string
  status: 'uploaded' | 'chunking' | 'ready' | 'failed'
  uploadedAt: string
}

export interface Chunk {
  id: string
  documentId: string
  originalContent: string
  editedContent: string
  isDirty: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  disliked: boolean
}

export interface DashboardEvent {
  id: string
  type: string
  timestamp: string
  detail: string
}

/** Trailing window the Stats tab's bar charts cover - shared by both the message and dislike charts via one toggle. */
export type DashboardStatsRange = 'day' | '7days' | 'month' | 'year'

/** One bar's worth of data - `bucketStart` is a UTC ISO timestamp; the frontend formats the display label per `range` (see DashboardPage.tsx). */
export interface DashboardStatsBucket {
  bucketStart: string
  count: number
}

export interface DashboardStats {
  /** Hardcoded 0 backend-side until this app has real user accounts - not a bug. */
  totalUsers: number
  totalChunks: number
  totalDocuments: number
  /** All-time count, unlike `dislikeBuckets` below which is scoped to the selected range. */
  totalDislikes: number
  messageBuckets: DashboardStatsBucket[]
  dislikeBuckets: DashboardStatsBucket[]
}

/** One chunk's position in the 3D semantic map (GET /internal/dashboard/chunk-graph) - x/y/z come from the backend's UMAP projection of its embedding, not computed client-side. */
export interface ChunkGraphNode {
  id: string
  documentId: string
  filename: string
  x: number
  y: number
  z: number
  /** This chunk's own position within its document (reading order) - used to chain same-document nodes 1->2->3->... rather than connecting every chunk to every other chunk. */
  position: number
}

export interface ChunkGraph {
  nodes: ChunkGraphNode[]
}

/**
 * OpenAI API spend summary (GET /internal/dashboard/openai-spend) - trailing
 * rolling windows from "now" (last 1/7/30/365 days), not calendar-aligned
 * buckets like DashboardStatsBucket above. `configured` is `false` (with
 * every amount at 0) when the backend has no OPENAI_ADMIN_API_KEY set -
 * this whole feature is optional, same "gracefully does nothing without it"
 * pattern as OPENAI_API_KEY itself (see .env.example) - the regular
 * OPENAI_API_KEY used for chat/embeddings has no access to this data at
 * all, a separate Admin key is required.
 */
/** Same four trailing rolling windows as OpenAiSpend's own day/week/month/year, just token counts (completions input+output plus embeddings input, summed) instead of USD amounts. */
export interface OpenAiSpendTokens {
  day: number
  week: number
  month: number
  year: number
}

export interface OpenAiSpend {
  day: number
  week: number
  month: number
  year: number
  tokens: OpenAiSpendTokens
  currency: string
  configured: boolean
}

export interface RelevantChunkMatch {
  chunkId: string
  documentId: string
  filename: string
  content: string
  matchPercent: number
}
