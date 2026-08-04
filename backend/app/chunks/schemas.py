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


class ChunkSummary(BaseModel):
    id: str
    documentId: str
    originalContent: str
    editedContent: str
    isDirty: bool  # always False server-side; client-only concept
