from pydantic import BaseModel


class DashboardEventSummary(BaseModel):
    id: str
    type: str
    timestamp: str
    detail: str
    userEmail: str | None = None
