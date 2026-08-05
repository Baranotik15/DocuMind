import re

from app.chunks.headings import HeadingMarker, detect_markdown_headings, detect_numbered_headings
from app.chunks.tokens import count_tokens

# A "blank line" paragraph separator: a newline, optional horizontal
# whitespace, then another newline. Deliberately excludes further `\n`
# from the optional-whitespace class so runs of 3+ newlines only consume
# the first pair per match - the remainder is simply carried over as
# leading whitespace on the next paragraph segment. Either way no
# characters are lost, since paragraph segments are built from slice
# boundaries derived from these match positions, never by discarding text.
_PARAGRAPH_SEPARATOR_RE = re.compile(r"\n[ \t\r]*\n")

# A sentence-ending boundary: `.`/`!`/`?` followed by whitespace. Used only
# to choose *where* to cut an oversized paragraph - matched positions are
# cut points, not text that gets removed.
_SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")

# Deliberately small - about 3-4 lines of body text (an average line runs
# roughly 15-20 tokens), per explicit request for much finer-grained
# fallback chunks than the old 1500-character/400-token default. Only
# applies to tiers 5-7 (paragraph/sentence/fixed fallback, see
# _split_section_to_size) - tiers 1-4 still section on real headings first
# regardless of this limit.
DEFAULT_MAX_TOKENS = 80


def split_document(
    text: str,
    headings: list[HeadingMarker] | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> list[str]:
    """Splits `text` into an ordered list of chunk strings such that
    "".join(chunks) == text EXACTLY - boundary-insertion only, no
    trimming/normalization (this is a hard contract, unchanged from the
    split_into_chunks this replaces).

    If `headings` is falsy (None or []), tries detect_markdown_headings
    (tier 1) then detect_numbered_headings (tier 3) on `text` itself
    before giving up on structure entirely - a caller with no format-
    native heading signal (a .txt upload, or the Save-triggered re-chunk
    path which only ever has edited plain text) still gets text-pattern
    section boundaries when they exist.

    If headings (given or tier-1/3-detected) end up non-empty, `text` is
    sliced into sections at each marker's offset (see
    _split_into_sections) - each section's own heading line is its first
    line. Given headings always win over tier 1/3: the fallback detectors
    only run when the caller passed none.

    If no headings are available from any source, the whole `text` is one
    section. Every section is then passed through _split_section_to_size
    so no returned chunk exceeds max_tokens (measured via count_tokens).
    """
    if not text:
        return []

    if not headings:
        headings = detect_markdown_headings(text) or detect_numbered_headings(text)

    sections = _split_into_sections(text, headings) if headings else [text]

    chunks: list[str] = []
    for section in sections:
        chunks.extend(_split_section_to_size(section, max_tokens))
    return chunks


def _split_into_sections(text: str, headings: list[HeadingMarker]) -> list[str]:
    """Boundary-list slicing, same pattern as
    _split_into_paragraph_segments below: builds a sorted boundary-offset
    list from `headings` and slices `text` between consecutive
    boundaries. Headings are sorted defensively here - tier 1/3 detectors
    already return them in offset order, but format-native headings
    passed in from extraction.py (e.g. a PDF's outline entries) aren't
    guaranteed to arrive pre-sorted. A heading at offset 0 does NOT
    create an empty leading section; text before the first heading (if
    its offset isn't 0) becomes its own leading section with no heading.
    Concatenating the result reproduces `text` exactly."""
    offsets = sorted(marker.offset for marker in headings)
    boundaries = [] if offsets[0] == 0 else [0]
    boundaries.extend(offsets)
    boundaries.append(len(text))
    return [text[start:end] for start, end in zip(boundaries, boundaries[1:])]


def _split_section_to_size(section: str, max_tokens: int) -> list[str]:
    """Splits one section (already carved out at heading boundaries, or
    the whole document if there were none) into chunks no larger than
    max_tokens - same shape split_into_chunks used to have: prefers
    paragraph (blank-line) boundaries; a paragraph whose own token count
    exceeds max_tokens is hard-split further (at sentence boundaries,
    falling back to a raw character cut) without dropping any characters.

    Guarantee: every returned chunk (including the last) has
    count_tokens(chunk) <= max_tokens, since oversized paragraphs are
    always hard-split rather than ever standing as a single oversized
    chunk.
    """
    if not section:
        return []

    chunks: list[str] = []
    current = ""
    for segment in _split_into_paragraph_segments(section):
        if count_tokens(segment) > max_tokens:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_hard_split(segment, max_tokens))
        elif current and count_tokens(current + segment) > max_tokens:
            chunks.append(current)
            current = segment
        else:
            current += segment
    if current:
        chunks.append(current)
    return chunks


def _split_into_paragraph_segments(text: str) -> list[str]:
    """Splits `text` into contiguous slices, each ending right after a
    paragraph (blank-line) separator, except the last which ends at the
    end of the string. Concatenating the result reproduces `text`
    exactly, since these are plain slice boundaries, not a
    split-and-rejoin-with-a-guessed-separator operation."""
    boundaries = [0]
    boundaries.extend(match.end() for match in _PARAGRAPH_SEPARATOR_RE.finditer(text))
    boundaries.append(len(text))
    return [text[start:end] for start, end in zip(boundaries, boundaries[1:])]


def _hard_split(segment: str, max_tokens: int) -> list[str]:
    """Splits a single oversized paragraph segment into pieces no larger
    than max_tokens (via count_tokens), preferring to cut right after a
    sentence boundary that falls within the current token-budget window,
    falling back to a raw character cut at the window edge otherwise.
    Slice-boundary based, so no characters are dropped.

    Unlike the old character-counted version, a window's edge can't be
    found by simple arithmetic (tokens don't correspond to a fixed
    number of characters) - _largest_end_within_token_limit finds it by
    search instead of `start + max_tokens`.
    """
    if count_tokens(segment) <= max_tokens:
        return [segment]

    boundary_positions = [match.end() for match in _SENTENCE_BOUNDARY_RE.finditer(segment)]
    pieces: list[str] = []
    start = 0
    length = len(segment)
    while start < length:
        limit = _largest_end_within_token_limit(segment, start, length, max_tokens)
        if limit >= length:
            pieces.append(segment[start:])
            break
        candidates = [pos for pos in boundary_positions if start < pos <= limit]
        end = candidates[-1] if candidates else limit
        pieces.append(segment[start:end])
        start = end
    return pieces


def _largest_end_within_token_limit(text: str, start: int, length: int, max_tokens: int) -> int:
    """Largest `end` (start < end <= length) such that
    count_tokens(text[start:end]) <= max_tokens, found by binary search
    since tiktoken's BPE tokens don't map to a fixed characters-per-token
    ratio. Always advances by at least one character past `start`, so the
    caller can't loop forever even in the pathological case of a single
    character alone exceeding max_tokens."""
    low, high = start + 1, length
    best = low
    while low <= high:
        mid = (low + high) // 2
        if count_tokens(text[start:mid]) <= max_tokens:
            best = mid
            low = mid + 1
        else:
            high = mid - 1
    return best
