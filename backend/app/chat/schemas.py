from typing import Literal

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


# Query param for GET /chat/dislikes and GET /chat/no-answer-messages -
# FastAPI 422s any value outside this set automatically, same convention as
# app.dashboard.router's own DashboardRange.
ImprovementsRange = Literal["day", "7days", "30days", "all"]


class DislikedMessageSummary(BaseModel):
    id: str
    content: str
    # None only if question_id somehow didn't resolve (shouldn't happen in
    # practice, but the FK is nullable).
    questionContent: str | None
    dislikedAt: str
    createdAt: str


class NoAnswerMessageSummary(BaseModel):
    id: str
    content: str
    questionContent: str | None
    createdAt: str


class TranscriptionResult(BaseModel):
    text: str
