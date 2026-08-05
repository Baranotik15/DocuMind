from pydantic import BaseModel


class DocumentSummary(BaseModel):
    id: str
    filename: str
    status: str
    fileSizeBytes: int | None = None
    uploadedAt: str
