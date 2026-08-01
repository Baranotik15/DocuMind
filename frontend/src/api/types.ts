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
