import type { ApiClient } from './client'
import type {
  AnalysisReportDetail,
  AnalysisReportSummary,
  ChatMessage,
  Chunk,
  ChunkGraphNode,
  DashboardEvent,
  DashboardStatsBucket,
  DashboardStatsRange,
  DislikedMessage,
  DocumentSummary,
  NoAnswerMessage,
} from './types'

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
    fileSizeBytes: 428_112,
  },
  {
    id: 'doc-2',
    filename: 'onboarding-notes.docx',
    status: 'uploaded',
    uploadedAt: '2026-07-28T14:02:00.000Z',
    fileSizeBytes: 51_200,
  },
  {
    id: 'doc-3',
    filename: 'release-plan.md',
    status: 'chunking',
    uploadedAt: '2026-07-30T11:47:00.000Z',
    fileSizeBytes: 8_940,
  },
]

// Long, realistic-length seed text (~4000 characters across 7 chunks) so the
// chunk-preview page (ChunkPreviewPage.tsx) can be evaluated with something
// closer to a real document instead of three one-line placeholders.
const ARCHITECTURE_GUIDE_SECTIONS = [
  'Section 1: Introduction to the system architecture. DocuMind is composed of four cooperating services: a FastAPI backend that exposes the REST API, a Celery worker that handles asynchronous document processing, a PostgreSQL database extended with the pgvector extension for similarity search, and a React frontend served independently. Each service runs in its own container and communicates over a private Docker network, with only the backend and frontend exposing ports to the host machine during local development.',
  'Section 2: Data flow between services. When a user uploads a document through the frontend, the backend stores the raw file via the storage adapter and creates a database record with status set to uploaded. A background job is then enqueued on the Celery broker, which the worker picks up to parse the document, split it into chunks, and generate embeddings for each chunk using the configured embedding model before writing the vectors back into Postgres alongside the chunk text.',
  'Section 3: Deployment topology. In production, each service maps to its own deployable unit: the backend and worker run as separate ECS Fargate services behind an internal load balancer, Postgres is provisioned through RDS with the pgvector extension enabled, and the message broker runs on Amazon MQ. The frontend is built as a static bundle and served through S3 and CloudFront, decoupling its release cycle entirely from the backend and worker deployments.',
  'Section 4: Authentication and session handling. Access to the admin panel is gated by short-lived server-side sessions rather than issued tokens. A session row is created in Postgres at login time with a fixed expiry, and every subsequent request is validated against that row. There is no self-registration flow; accounts are provisioned manually, and a session that has expired requires the operator to sign in again regardless of how recently they were active.',
  'Section 5: Chunking strategy. Documents are split using a recursive character-based splitter that respects paragraph and sentence boundaries wherever possible, aiming for chunks that are large enough to carry meaningful context but small enough to embed efficiently. Each chunk retains a reference to its source document and its position within that document, so the original text can always be reconstructed by concatenating chunks in order, which is exactly what the chunk review screen does.',
  'Section 6: Manual review and editing. Because automated chunking is not always perfect, operators can open any document from the Upload page and review how it was split before the chunks are embedded. Edits made in the review screen are held locally until the operator explicitly saves them, at which point the edited content replaces the original for that chunk and the document becomes eligible for re-embedding on the next processing pass.',
  'Section 7: Observability. Every significant event in the pipeline - a document being uploaded, a chunking job starting or finishing, a chat message being sent - is recorded as a structured event in Postgres. The Logs & Stats page reads directly from that table to show operators a live view of system activity without requiring a separate logging stack, which keeps the local development setup simple while still giving a realistic picture of what a production dashboard would need to surface.',
]

let chunks: Chunk[] = ARCHITECTURE_GUIDE_SECTIONS.map((section, index) => ({
  id: `chunk-${index + 1}`,
  documentId: 'doc-1',
  originalContent: section,
  editedContent: section,
  isDirty: false,
}))

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

// Improvements page's own two seeded lists - kept as independent in-memory
// stores (not derived from `chatMessages` above) since ChatMessage itself
// carries neither a dislikedAt timestamp nor a no_answer_found flag; range
// filtering isn't modeled here (same "just enough for local/offline dev"
// rationale as getDashboardStats's own seed data below), every seeded entry
// is returned regardless of which range is requested.
const dislikedMessages: DislikedMessage[] = [
  {
    id: 'msg-5',
    content: 'I\'m not fully certain about that - could you rephrase the question?',
    questionContent: 'Does the system support real-time collaborative editing?',
    dislikedAt: '2026-07-30T16:40:00.000Z',
    createdAt: '2026-07-30T16:39:30.000Z',
  },
]

const noAnswerMessages: NoAnswerMessage[] = [
  {
    id: 'msg-6',
    content: 'I\'m sorry, that isn\'t covered in the uploaded documentation.',
    questionContent: 'What is the refund policy for enterprise customers?',
    createdAt: '2026-07-29T09:12:00.000Z',
  },
]

const dashboardEvents: DashboardEvent[] = [
  {
    id: 'event-1',
    type: 'document.uploaded',
    timestamp: '2026-07-28T14:02:00.000Z',
    detail: 'onboarding-notes.docx was uploaded.',
    userEmail: 'admin@documind.dev',
  },
  {
    id: 'event-2',
    type: 'document.chunked',
    timestamp: '2026-07-20T09:20:00.000Z',
    detail: 'architecture-guide.pdf was split into 3 chunks.',
    userEmail: 'admin@documind.dev',
  },
  {
    id: 'event-3',
    type: 'chat.message',
    timestamp: '2026-07-29T10:05:00.000Z',
    detail: 'A user asked how to upload a new document.',
    userEmail: null,
  },
  {
    id: 'event-4',
    type: 'document.chunking_started',
    timestamp: '2026-07-30T11:47:30.000Z',
    detail: 'release-plan.md chunking started.',
    // Worker-triggered, no authenticated user in that context - mirrors the
    // real backend, which leaves user_email NULL for chunking_started/
    // succeeded/failed (only upload/delete happen inside an HTTP session).
    userEmail: null,
  },
]

// One seeded historical run, `completed`, with a sample gap-analysis report
// and one sample conflict - enough for the Analysis sub-tab to have
// something real to render while wired against this mock. New runs started
// via startAnalysisRun below are prepended ahead of this one (newest first,
// matching the real GET /internal/analysis/reports ordering).
const analysisReports: AnalysisReportDetail[] = [
  {
    id: 'analysis-1',
    status: 'completed',
    startedAt: '2026-08-01T09:00:00.000Z',
    completedAt: '2026-08-01T09:02:30.000Z',
    startedByEmail: 'admin@documind.dev',
    gapAnalysis:
      "Recurring theme: several questions ask about real-time collaborative editing, which isn't covered anywhere in the current documentation. Consider adding a dedicated section explaining what collaboration features are (and aren't) supported.",
    conflicts: [
      {
        documentAId: 'doc-1',
        documentAFilename: 'architecture-guide.pdf',
        chunkAId: 'chunk-1',
        chunkAContent: ARCHITECTURE_GUIDE_SECTIONS[0],
        documentBId: 'doc-2',
        documentBFilename: 'onboarding-notes.docx',
        chunkBId: 'chunk-onboarding-1',
        chunkBContent: 'DocuMind runs as three services - backend, worker, and frontend - with no separate database service to manage.',
        description:
          "One document describes DocuMind as four cooperating services (including a separate Postgres database), the other says three services with no separate database - these directly disagree on the deployment topology.",
      },
    ],
    totalTokens: 842,
    errorDetail: null,
  },
]

// Counters seeded past the ids above so newly created rows never collide
// with seed data.
let nextDocumentId = documents.length + 1
let nextMessageId = chatMessages.length + 1
let nextAnalysisReportId = analysisReports.length + 1

// Bucket counts/spacing per range, ending at "now" - unlike the real
// backend (see routers/dashboard.py's get_dashboard_stats), this mock
// doesn't calendar-align buckets to the caller's tz, since it's just
// standing in for local/offline dev and has no real event timestamps to
// align in the first place.
const STATS_BUCKET_CONFIG: Record<DashboardStatsRange, { count: number; stepMs: number }> = {
  day: { count: 24, stepMs: 60 * 60 * 1000 },
  '7days': { count: 7, stepMs: 24 * 60 * 60 * 1000 },
  month: { count: 30, stepMs: 24 * 60 * 60 * 1000 },
  year: { count: 12, stepMs: 30 * 24 * 60 * 60 * 1000 },
}

function buildStatsBuckets(range: DashboardStatsRange, seedCounts: number[]): DashboardStatsBucket[] {
  const { count, stepMs } = STATS_BUCKET_CONFIG[range]
  const now = Date.now()
  return Array.from({ length: count }, (_, index) => ({
    bucketStart: new Date(now - (count - 1 - index) * stepMs).toISOString(),
    count: seedCounts[index % seedCounts.length],
  }))
}

export const mockApiClient: ApiClient = {
  // No real session/auth modeled in this mock - it backs local/offline dev
  // only, and the real login flow (LoginPage.tsx) always talks to
  // httpApiClient directly, never this client. Resolves unconditionally so
  // the ApiClient contract stays satisfied.
  async login(email, _password) {
    return { email }
  },

  // Same "no real session modeled" rationale as login above - resolves
  // unconditionally so the ApiClient contract stays satisfied.
  async logout() {},

  // Same "no real session modeled" rationale as login/logout above - this
  // mock is never actually reached by RequireAuth.tsx (apiClient is always
  // bound to httpApiClient, see client.ts), so there's no real "current
  // user" to look up; resolves unconditionally so the ApiClient contract
  // stays satisfied.
  async getCurrentUser() {
    return { email: 'admin@documind.dev' }
  },

  async listDocuments() {
    return documents.map((document) => ({ ...document }))
  },

  async uploadDocument(file) {
    const document: DocumentSummary = {
      id: `doc-${nextDocumentId++}`,
      filename: file.name,
      status: 'uploaded',
      uploadedAt: new Date().toISOString(),
      fileSizeBytes: file.size,
    }
    documents.push(document)
    return { ...document }
  },

  async deleteDocument(documentId) {
    const index = documents.findIndex((document) => document.id === documentId)
    if (index === -1) {
      throw new Error(`deleteDocument: no document found with id "${documentId}"`)
    }
    documents.splice(index, 1)
    chunks = chunks.filter((chunk) => chunk.documentId !== documentId)
  },

  async getChunks(documentId) {
    return chunks.filter((chunk) => chunk.documentId === documentId).map((chunk) => ({ ...chunk }))
  },

  // `manualBoundaries` is accepted (matching the real ApiClient signature)
  // but not otherwise modeled here - this mock has no algorithmic
  // re-chunker to skip in the first place, so there's nothing for the flag
  // to change about its own in-memory behavior.
  async saveChunks(documentId, updatedChunks, _manualBoundaries) {
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

  // range isn't modeled here - see dislikedMessages' own seed-data comment
  // above.
  async getDislikedMessages(_range) {
    return dislikedMessages.map((message) => ({ ...message }))
  },

  async getNoAnswerMessages(_range) {
    return noAnswerMessages.map((message) => ({ ...message }))
  },

  async dismissNoAnswerMessage(messageId) {
    const index = noAnswerMessages.findIndex((message) => message.id === messageId)
    if (index === -1) {
      throw new Error(`dismissNoAnswerMessage: no message found with id "${messageId}"`)
    }
    noAnswerMessages.splice(index, 1)
  },

  // No real embedding/similarity search in this mock - just returns up to
  // the first 5 seeded chunks with a deterministically decreasing (but
  // fake) matchPercent, purely so RelevancePage has something to render
  // while wired against this client.
  async getTopMatchingChunks(_content) {
    return chunks.slice(0, 5).map((chunk, index) => {
      const document = documents.find((candidate) => candidate.id === chunk.documentId)
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        filename: document?.filename ?? 'unknown',
        content: chunk.editedContent,
        matchPercent: Math.max(10, 90 - index * 15),
      }
    })
  },

  async transcribeVoice(_audioBlob) {
    return 'mock transcribed text'
  },

  async getDashboardEvents() {
    return dashboardEvents.map((event) => ({ ...event }))
  },

  async getDashboardStats(range) {
    return {
      totalUsers: 0,
      totalChunks: chunks.length,
      totalDocuments: documents.length,
      totalDislikes: chatMessages.filter((message) => message.disliked).length,
      messageBuckets: buildStatsBuckets(range, [2, 0, 1, 3, 1, 0, 2]),
      dislikeBuckets: buildStatsBuckets(range, [0, 0, 1, 0, 0, 0, 0]),
    }
  },

  // x/y/z stand in for the real backend's UMAP projection of each chunk's
  // embedding (see routers/dashboard.py's get_chunk_graph) - just spread
  // deterministically around a circle so same-document chunks (chained by
  // `position`) render as a visibly connected path in ChunkGraphPanel.
  async getChunkGraph() {
    const positionByDocument = new Map<string, number>()
    const nodes: ChunkGraphNode[] = chunks.map((chunk) => {
      const position = (positionByDocument.get(chunk.documentId) ?? 0) + 1
      positionByDocument.set(chunk.documentId, position)
      const document = documents.find((candidate) => candidate.id === chunk.documentId)
      const angle = (position / chunks.length) * Math.PI * 2
      return {
        id: chunk.id,
        documentId: chunk.documentId,
        filename: document?.filename ?? 'unknown',
        x: Math.cos(angle) * 10,
        y: Math.sin(angle) * 10,
        z: position,
        position,
      }
    })
    return { nodes }
  },

  // No mock spend data - this mock client backs local/offline dev, where
  // there's no real OpenAI Admin key to have spent anything against.
  // `configured: false` matches exactly how the real backend responds when
  // OPENAI_ADMIN_API_KEY isn't set, so DashboardPage's "not configured"
  // state is exercised the same way here as it would be for real.
  async getOpenAiSpend() {
    return {
      day: 0,
      week: 0,
      month: 0,
      year: 0,
      tokens: {
        day: { input: 0, output: 0 },
        week: { input: 0, output: 0 },
        month: { input: 0, output: 0 },
        year: { input: 0, output: 0 },
      },
      currency: 'usd',
      configured: false,
    }
  },

  // No real background run in this mock - starts immediately `running` with
  // every detail field still null (matching the real backend's just-started
  // response shape) and is prepended so it's the newest entry; there's no
  // Celery worker here to ever flip it to `completed`, so a run started
  // against this mock simply stays `running` forever - acceptable, this
  // client only backs local/offline dev.
  async startAnalysisRun() {
    const report: AnalysisReportDetail = {
      id: `analysis-${nextAnalysisReportId++}`,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      startedByEmail: 'admin@documind.dev',
      gapAnalysis: null,
      conflicts: null,
      totalTokens: null,
      errorDetail: null,
    }
    analysisReports.unshift(report)
    return { ...report }
  },

  async listAnalysisReports() {
    return analysisReports.map((report): AnalysisReportSummary => ({ ...report }))
  },

  async getAnalysisReport(reportId) {
    const report = analysisReports.find((candidate) => candidate.id === reportId)
    if (!report) {
      throw new Error(`getAnalysisReport: no report found with id "${reportId}"`)
    }
    return { ...report }
  },

  async deleteAnalysisReport(reportId) {
    const index = analysisReports.findIndex((candidate) => candidate.id === reportId)
    if (index === -1) {
      throw new Error(`deleteAnalysisReport: no report found with id "${reportId}"`)
    }
    analysisReports.splice(index, 1)
  },
}
