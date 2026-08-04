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
