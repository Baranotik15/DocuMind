from pydantic import BaseModel


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
