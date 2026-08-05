from enum import StrEnum


class DashboardEventType(StrEnum):
    """Canonical `dashboard_events.type` values passed to
    dashboard_events.recording.record_event_sync/record_event_async - the
    full set ever recorded, kept together so a new call site can reuse an
    existing value instead of inventing a slightly different string."""

    DOCUMENT_UPLOADED = "document.uploaded"
    DOCUMENT_DELETED = "document.deleted"
    DOCUMENT_CHUNKING_STARTED = "document.chunking_started"
    DOCUMENT_CHUNKING_SUCCEEDED = "document.chunking_succeeded"
    DOCUMENT_CHUNKING_FAILED = "document.chunking_failed"
    ANALYSIS_RUN_COMPLETED = "analysis.run_completed"
    ANALYSIS_RUN_FAILED = "analysis.run_failed"
