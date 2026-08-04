from pydantic import BaseModel


class DocumentSummary(BaseModel):
    id: str
    filename: str
    status: str
    uploadedAt: str
