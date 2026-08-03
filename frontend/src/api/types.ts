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

export interface RelevantChunkMatch {
  chunkId: string
  documentId: string
  filename: string
  content: string
  matchPercent: number
}
