from enum import StrEnum


class DocumentStatus(StrEnum):
    """Canonical `documents.status` column values - single source of truth
    for the literals previously duplicated as bare strings across
    documents/router.py, chunks/router.py, and documents/pipeline.py."""

    UPLOADED = "uploaded"
    CHUNKING = "chunking"
    READY = "ready"
    FAILED = "failed"


# Shared by documents/router.py (upload extension validation) and
# documents/extraction.py (extract_text's extension dispatch) - a plain data
# constant with no behavior of its own, so importing it doesn't pull
# extraction logic into the router.
SUPPORTED_DOCUMENT_EXTENSIONS = frozenset({".pdf", ".docx", ".md", ".txt"})

# HTTPException detail codes shared by documents/router.py and
# chunks/router.py - both raise these for the same conditions on their
# respective sibling endpoints (a document mid-pipeline, or missing
# entirely). Previously two separate, independently-maintained copies of
# the same two literals, one per file.
DOCUMENT_PROCESSING_ERROR = "document_processing"
DOCUMENT_NOT_FOUND_ERROR = "document_not_found"
