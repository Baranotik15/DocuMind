"""Shared formatting helpers for `document.*` dashboard event `detail`
strings - kept separate from documents/router.py and documents/pipeline.py
so both call sites (and their tests) share one implementation instead of
three independently-maintained copies of the same string-building logic."""


def format_file_size(size_bytes: int) -> str:
    """Human-readable byte count ('5.1 KB', '2.3 MB', '842 B') - binary
    (1024-based) units, one decimal place once the unit is bigger than
    bytes. Mirrors frontend/src/utils/formatFileSize.ts's non-null branch
    exactly (same thresholds/rounding) so a size reads identically whether
    seen in the Upload page's Size column or here in a dashboard event's
    detail. Unlike the frontend helper, this one never has to render a
    `null`/unknown size itself - see build_document_event_detail below,
    which omits the filesize line entirely in that case instead of calling
    this with a placeholder."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    units = ("KB", "MB", "GB")
    value = size_bytes / 1024
    unit_index = 0
    while value >= 1024 and unit_index < len(units) - 1:
        value /= 1024
        unit_index += 1
    return f"{value:.1f} {units[unit_index]}"


def build_document_event_detail(
    filename: str, file_size_bytes: int | None, token_count: int | None = None
) -> str:
    """The shared `detail` string every document.* dashboard event uses:
    'filename = <name>', plus a second line 'filesize = <human-readable>'
    when `file_size_bytes` is not None, plus a third line
    'tokens = <count>' when `token_count` is not None. Each line is
    omitted entirely - no trailing newline, no placeholder text - when its
    value is None: `file_size_bytes` is None for a legacy pre-migration row
    that predates the file_size_bytes column (0006_documents_file_size.py);
    `token_count` is None for every event except document.chunking_succeeded
    (see documents/pipeline.py's _replace_chunks - the only call site that
    knows a token count, since it's computed from the chunks just embedded).
    Unlike file size, a token count has no unit conversion - it's rendered
    as a plain integer."""
    detail = f"filename = {filename}"
    if file_size_bytes is not None:
        detail = f"{detail}\nfilesize = {format_file_size(file_size_bytes)}"
    if token_count is not None:
        detail = f"{detail}\ntokens = {token_count}"
    return detail
