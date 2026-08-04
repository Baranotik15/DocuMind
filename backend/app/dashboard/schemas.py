from pydantic import BaseModel


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
