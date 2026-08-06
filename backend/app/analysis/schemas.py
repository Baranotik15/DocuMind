from typing import Literal

from pydantic import BaseModel

AnalysisRunStatus = Literal["running", "completed", "failed"]


class AnalysisReportSummary(BaseModel):
    id: str
    status: AnalysisRunStatus
    startedAt: str
    completedAt: str | None
    startedByEmail: str


class AnalysisConflict(BaseModel):
    documentAId: str
    documentAFilename: str
    chunkAId: str
    chunkAContent: str
    documentBId: str
    documentBFilename: str
    chunkBId: str
    chunkBContent: str
    description: str


class AnalysisReportDetail(AnalysisReportSummary):
    gapAnalysis: str | None
    conflicts: list[AnalysisConflict] | None
    totalTokens: int | None
    errorDetail: str | None
