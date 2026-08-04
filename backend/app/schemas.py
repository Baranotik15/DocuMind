"""Single source of truth for every Pydantic model used by this app's API -
both request-body validation models and response serialization models
(returned via FastAPI's `response_model` inference). Row-mapping helpers
(`_document_summary`, `_chunk_summary`, etc.) stay in their router modules;
only the shapes themselves live here.

Wire-format field names that are already camelCase (e.g. `documentId`,
`bucketStart`) are declared as camelCase Python attributes directly, rather
than snake_case + an alias generator.
"""

from pydantic import BaseModel


class ChunkIn(BaseModel):
    editedContent: str
    # id/originalContent/isDirty are accepted-but-ignored: a full re-chunk
    # discards prior chunk identity/boundaries, so nothing here reads them.


class SaveChunksRequest(BaseModel):
    chunks: list[ChunkIn]
    manualBoundaries: bool = False
    # True skips the algorithmic re-split and embeds `chunks` exactly as
    # given (see .claude/specs/manual-chunk-boundaries.md).


class DocumentSummary(BaseModel):
    id: str
    filename: str
    status: str
    uploadedAt: str


class ChunkSummary(BaseModel):
    id: str
    documentId: str
    originalContent: str
    editedContent: str
    isDirty: bool  # always False server-side; client-only concept


class SendMessageRequest(BaseModel):
    content: str


class TopChunksRequest(BaseModel):
    content: str


class ChatMessageSummary(BaseModel):
    id: str
    role: str
    content: str
    disliked: bool


class TopChunkSummary(BaseModel):
    chunkId: str
    documentId: str
    filename: str
    content: str
    matchPercent: float


class DashboardEventSummary(BaseModel):
    id: str
    type: str
    timestamp: str
    detail: str


class DashboardStatsBucket(BaseModel):
    bucketStart: str
    count: int


class DashboardStats(BaseModel):
    totalUsers: int
    totalChunks: int
    totalDocuments: int
    totalDislikes: int
    messageBuckets: list[DashboardStatsBucket]
    dislikeBuckets: list[DashboardStatsBucket]


class ChunkGraphNode(BaseModel):
    id: str
    documentId: str
    filename: str
    x: float
    y: float
    z: float
    position: int


class ChunkGraph(BaseModel):
    nodes: list[ChunkGraphNode]


class OpenAiSpendTokenWindow(BaseModel):
    input: int
    output: int


class OpenAiSpendTokens(BaseModel):
    day: OpenAiSpendTokenWindow
    week: OpenAiSpendTokenWindow
    month: OpenAiSpendTokenWindow
    year: OpenAiSpendTokenWindow


class OpenAiSpend(BaseModel):
    day: float
    week: float
    month: float
    year: float
    tokens: OpenAiSpendTokens
    currency: str
    configured: bool
