from enum import StrEnum


class DocumentStatus(StrEnum):
    """Canonical `documents.status` column values - single source of truth
    for the literals previously duplicated as bare strings inside raw SQL
    across routers/documents.py, routers/chat.py, and services/pipeline.py."""

    UPLOADED = "uploaded"
    CHUNKING = "chunking"
    READY = "ready"
    FAILED = "failed"


class ChatRole(StrEnum):
    """Canonical `chat_messages.role` column values."""

    USER = "user"
    ASSISTANT = "assistant"


class DashboardEventType(StrEnum):
    """Canonical `dashboard_events.type` values passed to
    services.events.record_event_sync/record_event_async - the full set
    ever recorded, kept together so a new call site can reuse an existing
    value instead of inventing a slightly different string."""

    DOCUMENT_UPLOADED = "document.uploaded"
    DOCUMENT_DELETED = "document.deleted"
    DOCUMENT_CHUNKING_STARTED = "document.chunking_started"
    DOCUMENT_CHUNKING_SUCCEEDED = "document.chunking_succeeded"
    DOCUMENT_CHUNKING_FAILED = "document.chunking_failed"
    CHAT_MESSAGE_SENT = "chat.message_sent"


# Shared by routers/documents.py (upload extension validation) and
# services/documents.py (extract_text's extension dispatch) - a plain data
# constant with no behavior of its own, so importing it doesn't pull
# extraction logic into the router.
SUPPORTED_DOCUMENT_EXTENSIONS = frozenset({".pdf", ".docx", ".md", ".txt"})
