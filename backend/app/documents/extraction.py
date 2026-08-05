import io
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from docx import Document as DocxDocument
from pypdf import PdfReader

from app.chunks.headings import HeadingMarker
from app.documents.constants import SUPPORTED_DOCUMENT_EXTENSIONS

# python-docx's built-in heading style naming - "Heading 1", "Heading 2", ...
# The captured digit becomes the marker's level. Word's 'Title' style has no
# numbered sibling and is handled separately (see _heading_level_for_style).
_DOCX_HEADING_STYLE_RE = re.compile(r"^Heading (\d+)$")

# Tier 4 heading-candidate threshold: a PDF text run is treated as a heading
# candidate when its font size is at least 20% larger than its page's
# dominant (most common) body-text size. Chosen empirically: ordinary
# in-body emphasis (bold text, running heads, superscripts) rarely pushes a
# run's rendered size more than ~10-15% above the surrounding body font on
# its own, while genuine heading styles are typically 25-80%+ larger (e.g.
# 10pt body vs. 14-18pt heading). 20% sits comfortably between those two
# bands, so it catches real heading-sized jumps while tolerating minor
# rendering noise in reported font metrics.
_FONT_SIZE_HEADING_RATIO = 1.2


@dataclass(frozen=True)
class ExtractedDocument:
    """Result of extract_document - `text` has the exact same contract
    extract_text used to (pypdf join for .pdf, paragraph join for .docx,
    verbatim UTF-8 decode for .md/.txt). `headings` carries whatever
    *format-native* structural signal this file's extraction could
    recover (tier 2 for .docx/.pdf, tier 4 for .pdf without an outline) -
    always [] for .md/.txt, and possibly [] for .docx/.pdf too if neither
    signal was present. Tiers 1/3 are NOT computed here - see
    chunks/splitting.py's split_document, which tries those itself
    whenever `headings` is empty."""

    text: str
    headings: list[HeadingMarker]


class UnsupportedFileTypeError(Exception):
    """Raised by extract_document for any extension other than .pdf, .docx,
    .md, .txt (case-insensitive)."""


def extract_document(filename: str, data: bytes) -> ExtractedDocument:
    """Extracts plain text - and, where recoverable, format-native heading
    structure - from `data` based on filename's extension. .pdf via pypdf,
    .docx via python-docx, .md/.txt via UTF-8 decode (no structure signal
    for the latter two - see ExtractedDocument)."""
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_DOCUMENT_EXTENSIONS:
        raise UnsupportedFileTypeError(f"Unsupported file type: {filename}")
    if extension == ".pdf":
        return _extract_pdf_document(data)
    if extension == ".docx":
        return _extract_docx_document(data)
    return ExtractedDocument(text=data.decode("utf-8"), headings=[])


def _extract_pdf_text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _extract_pdf_document(data: bytes) -> ExtractedDocument:
    """Joins per-page text exactly as _extract_pdf_text does. Tries the
    PDF's own embedded outline first (tier 2); if at least one outline
    title can be located in the joined text, uses those as headings and
    skips tier 4 entirely. Otherwise falls back to font-size analysis
    (tier 4): any text run rendered notably larger than its page's
    dominant font size becomes a heading candidate (see
    _FONT_SIZE_HEADING_RATIO). Returns headings=[] if neither tier found
    anything."""
    reader = PdfReader(io.BytesIO(data))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)

    outline_headings = _pdf_outline_headings(reader, text)
    if outline_headings:
        return ExtractedDocument(text=text, headings=outline_headings)

    return ExtractedDocument(text=text, headings=_pdf_font_size_headings(reader, text))


def _pdf_outline_headings(reader: PdfReader, text: str) -> list[HeadingMarker]:
    """Tier 2. Flattens the PDF's outline/bookmark tree (if any) into
    ordered (title, level) pairs - nesting depth becomes the heading level,
    top-level entries are level 1 - then locates each title's offset in
    `text`. Returns [] if there's no outline, or if none of its titles can
    be located at all, so the caller falls through to tier 4."""
    try:
        outline = reader.outline
    except Exception:
        # pypdf can raise on malformed/nonstandard outline structures found
        # in the wild; treat that the same as "no outline" rather than
        # failing extraction over a heading signal that's only ever a
        # nice-to-have.
        outline = []
    candidates = _flatten_outline(outline)
    if not candidates:
        return []
    return _headings_with_levels(text, candidates)


def _pdf_font_size_headings(reader: PdfReader, text: str) -> list[HeadingMarker]:
    """Tier 4. Per page, captures (text run, font size) fragments via
    page.extract_text(visitor_text=...), computes that page's dominant
    (mode) font size as its body-text baseline, and flags any run at least
    _FONT_SIZE_HEADING_RATIO times that size as a heading candidate.
    Distinct candidate sizes across the whole document are bucketed
    descending into levels (largest size seen = level 1, next distinct
    size = level 2, ...); each candidate's run text is then located in
    `text` the same way tier 2's outline titles are."""
    candidates: list[tuple[str, float]] = []
    for page in reader.pages:
        runs: list[tuple[str, float]] = []

        def _visitor(
            run_text: str, cm, tm, font_dict, font_size: float, _runs: list = runs
        ) -> None:
            stripped = run_text.strip()
            if stripped:
                _runs.append((stripped, font_size))

        page.extract_text(visitor_text=_visitor)
        if not runs:
            continue
        dominant_size = Counter(size for _, size in runs).most_common(1)[0][0]
        threshold = dominant_size * _FONT_SIZE_HEADING_RATIO
        candidates.extend((run_text, size) for run_text, size in runs if size >= threshold)

    if not candidates:
        return []

    distinct_sizes = sorted({size for _, size in candidates}, reverse=True)
    level_by_size = {size: index + 1 for index, size in enumerate(distinct_sizes)}
    titled_candidates = [(run_text, level_by_size[size]) for run_text, size in candidates]
    return _headings_with_levels(text, titled_candidates)


def _flatten_outline(outline) -> list[tuple[str, int]]:
    """Walks pypdf's PdfReader.outline shape - a list mixing Destination-
    like entries and nested lists (pypdf's convention for representing a
    heading's children: a sublist immediately follows the parent entry it
    belongs to) - into a flat, reading-order list of (title, level) pairs.
    Nesting depth becomes the heading level: top-level entries are level 1,
    one level of nesting is level 2, and so on."""
    flattened: list[tuple[str, int]] = []
    _flatten_outline_into(outline, level=1, out=flattened)
    return flattened


def _flatten_outline_into(items, level: int, out: list[tuple[str, int]]) -> None:
    for item in items:
        if isinstance(item, list):
            _flatten_outline_into(item, level=level + 1, out=out)
        elif item.title:
            out.append((str(item.title), level))


def _locate_heading_offsets(full_text: str, titles_in_order: list[str]) -> list[int]:
    """For each title in `titles_in_order`, finds its first occurrence in
    `full_text` at or after the end of the previous match (so duplicate
    titles resolve to distinct occurrences, in the given order) - skips
    (omits, does not raise for) any title that can't be found at all,
    since PDF text extraction can introduce whitespace/ligature
    differences from an outline's stored title string. Returns offsets
    only for titles actually found, same relative order as the input."""
    offsets: list[int] = []
    search_start = 0
    for title in titles_in_order:
        index = full_text.find(title, search_start)
        if index == -1:
            continue
        offsets.append(index)
        search_start = index + len(title)
    return offsets


def _headings_with_levels(
    full_text: str, candidates: list[tuple[str, int]]
) -> list[HeadingMarker]:
    """Pairs each (title, level) candidate with its located offset in
    `full_text`, using the exact same sequential, skip-if-missing matching
    semantics as _locate_heading_offsets (duplicated here in miniature so a
    title's heading level travels alongside its offset, which a bare
    list[int] can't carry)."""
    markers: list[HeadingMarker] = []
    search_start = 0
    for title, level in candidates:
        index = full_text.find(title, search_start)
        if index == -1:
            continue
        markers.append(HeadingMarker(offset=index, level=level))
        search_start = index + len(title)
    return markers


def _extract_docx_document(data: bytes) -> ExtractedDocument:
    """Joins paragraph text exactly as the old _extract_docx_text did
    ("\\n".join(p.text for p in document.paragraphs)). While joining,
    tracks each paragraph's running character offset and records a
    HeadingMarker whenever its style is one of Word's built-in 'Heading N'
    styles (level = N) or the 'Title' style (level 1)."""
    document = DocxDocument(io.BytesIO(data))
    lines: list[str] = []
    headings: list[HeadingMarker] = []
    offset = 0
    for paragraph in document.paragraphs:
        style_name = paragraph.style.name if paragraph.style is not None else None
        level = _heading_level_for_style(style_name)
        if level is not None:
            headings.append(HeadingMarker(offset=offset, level=level))
        lines.append(paragraph.text)
        offset += len(paragraph.text) + 1  # +1 for the '\n' join separator
    return ExtractedDocument(text="\n".join(lines), headings=headings)


def _heading_level_for_style(style_name: str | None) -> int | None:
    """Maps a python-docx paragraph style name to a heading level, or None
    if the style isn't a heading style. 'Heading N' -> N; Word's built-in
    'Title' style -> 1 (it has no numbered sibling)."""
    if style_name is None:
        return None
    if style_name == "Title":
        return 1
    match = _DOCX_HEADING_STYLE_RE.match(style_name)
    return int(match.group(1)) if match else None
