import re

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


def split_into_chunks(text: str, max_chars: int = 1500) -> list[str]:
    """Splits `text` into an ordered list of chunk strings such that
    "".join(chunks) == text EXACTLY - boundary-insertion only, no
    trimming/normalization (this is a hard contract: the spec's
    acceptance criteria depend on exact reconstruction). Prefers
    paragraph (blank-line) boundaries; a paragraph longer than max_chars
    is hard-split further (at sentence boundaries, falling back to a raw
    character cut) without dropping any characters.

    Guarantee: every returned chunk (including the last) has length
    <= max_chars, since oversized paragraphs are always hard-split rather
    than ever standing as a single oversized chunk.
    """
    if not text:
        return []

    chunks: list[str] = []
    current = ""
    for segment in _split_into_paragraph_segments(text):
        if len(segment) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_hard_split(segment, max_chars))
        elif current and len(current) + len(segment) > max_chars:
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


def _hard_split(segment: str, max_chars: int) -> list[str]:
    """Splits a single oversized paragraph segment into pieces no longer
    than max_chars, preferring to cut right after a sentence boundary
    that falls within the current window, falling back to a raw
    character cut at the window edge otherwise. Slice-boundary based, so
    no characters are dropped."""
    if len(segment) <= max_chars:
        return [segment]

    boundary_positions = [match.end() for match in _SENTENCE_BOUNDARY_RE.finditer(segment)]
    pieces: list[str] = []
    start = 0
    length = len(segment)
    while start < length:
        limit = start + max_chars
        if limit >= length:
            pieces.append(segment[start:])
            break
        candidates = [pos for pos in boundary_positions if start < pos <= limit]
        end = candidates[-1] if candidates else limit
        pieces.append(segment[start:end])
        start = end
    return pieces
