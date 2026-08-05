import re
from dataclasses import dataclass

# ATX-style markdown heading: 1-6 '#' characters at the very start of a
# line, followed by a required space (per the CommonMark ATX heading spec -
# '#NoSpace' is a paragraph, not a heading), then the title text up to end
# of line. `re.MULTILINE` makes '^' match after every '\n', not just at
# text start, so headings anywhere in the document are found; a bare '#'
# mid-sentence (e.g. "C# is a language") never matches because it isn't
# preceded by a line start.
_MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6}) .*$", re.MULTILINE)

# Dotted numeric prefix at the start of a line, e.g. "1. Introduction",
# "2.1 Overview", "3) Something". The dotted-number group (\d+(?:\.\d+)*)
# is captured separately so its depth (count of '.'-joined components)
# becomes the heading level. The trailing separator ('.' or ')') is
# OPTIONAL because a multi-level number like "2.1" already ends in a
# digit, not a dot - "2.1 Overview" has no further punctuation before its
# title, unlike single-level "1. Introduction". At least one space is
# always required before the title text - matches this codebase's
# convention elsewhere of anchoring structural patterns at line start via
# `re.MULTILINE`.
_DOTTED_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)*)[.)]? +(\S.*)$", re.MULTILINE)

# 'Section 3', 'Section 3: Refunds', 'Chapter 4' at the start of a line -
# case-insensitive since document authors are inconsistent about casing.
# Always level 1 (these words don't encode nesting depth the way dotted
# numbers do).
_SECTION_CHAPTER_RE = re.compile(
    r"^(?:Section|Chapter) +\d+\b.*$", re.MULTILINE | re.IGNORECASE
)

# Heuristic thresholds for telling a numbered HEADING line ("2.1 Overview")
# apart from an ordinary numbered LIST item ("1. Buy milk"). Neither
# signal alone is reliable (headings can be long titles; short list items
# exist too), so both must hold - see detect_numbered_headings' docstring
# for the full reasoning.
_MAX_HEADING_TITLE_LENGTH = 80

# A title's *last letter* can't tell a heading from a list item - "Overview"
# and "milk" both end in a lowercase letter. What actually differs is
# capitalization of every word after the first: "1. Introduction" and
# "2.1 Overview" are Title Case (single word, trivially "all capitalized"),
# while "1. Buy milk" / "2. Walk the dog" are ordinary sentence case - only
# the leading word (which any sentence capitalizes anyway) is capitalized,
# the rest reads like normal prose. A word is "capitalized" here if its
# first character is uppercase.
_MIN_TITLE_CASE_FRACTION = 0.5


@dataclass(frozen=True)
class HeadingMarker:
    """One detected heading boundary within some already-extracted text.
    `offset` is the character index (into that text) where the heading's
    own title line starts - not where its section's body begins, the
    title line is the first line of the section it introduces (see
    _split_into_sections in splitting.py). `level` is 1-indexed depth
    (H1/Heading 1 = 1, H2/Heading 2 = 2, ...); for signals with no natural
    nesting (tier 3, tier 4) assign level by bucketing distinct sizes/
    depths largest-or-outermost-first."""

    offset: int
    level: int


def detect_markdown_headings(text: str) -> list[HeadingMarker]:
    """Tier 1. Matches ATX-style markdown headings ('#' through '######'
    followed by a space) at the start of a line. Returns [] if none
    found. Ordered by offset ascending."""
    markers = []
    for match in _MARKDOWN_HEADING_RE.finditer(text):
        level = len(match.group(1))
        markers.append(HeadingMarker(offset=match.start(), level=level))
    return markers


def detect_numbered_headings(text: str) -> list[HeadingMarker]:
    """Tier 3. Matches numbered/lettered pseudo-heading lines at the
    start of a line - dotted numeric prefixes ('1. Introduction', '2.1
    Overview', '3) Something') and 'Section N'/'Chapter N' (case-
    insensitive). `level` = the dotted-number depth (1 -> level 1, 2.1 ->
    level 2); 'Section'/'Chapter' lines are always level 1. To avoid
    matching ordinary numbered list items, a dotted-number line is only a
    heading candidate if it's short (<= 80 chars) and Title Case rather
    than ordinary sentence case (see _looks_like_heading_title), AND it
    isn't immediately adjacent - no blank-line paragraph break - to
    another such candidate (see _is_list_item_run): a real heading is
    always followed by body text before the next heading, while a
    numbered list's items sit on consecutive lines with nothing between
    them. Returns [] if none found. Ordered by offset ascending."""
    dotted_candidates: list[HeadingMarker] = []
    for match in _DOTTED_NUMBER_RE.finditer(text):
        if not _looks_like_heading_title(match.group(2)):
            continue
        depth = match.group(1).count(".") + 1
        dotted_candidates.append(HeadingMarker(offset=match.start(), level=depth))

    # An ordinary numbered list ("1. Buy milk\n2. Walk the dog\n3. Call
    # mom") has each of its items pass the single-line title heuristic
    # above individually - short, doesn't end mid-word. What tells a list
    # apart from real section headings is density: real headings are
    # sparse, separated by paragraphs of body text between them, while a
    # list's items sit on immediately consecutive lines with nothing in
    # between. So: any dotted-number candidate whose text run to its
    # neighboring candidate (before or after) contains no blank-line
    # paragraph break is part of a tight run; a candidate with such a
    # neighbor is dropped (a real heading is always separated from the
    # next one by body text). Only dotted-number candidates participate -
    # 'Section'/'Chapter' phrasing doesn't occur in ordinary lists, so
    # those are never filtered here.
    dotted_headings = [
        marker
        for marker in dotted_candidates
        if not _is_list_item_run(marker, dotted_candidates, text)
    ]

    section_headings = [
        HeadingMarker(offset=match.start(), level=1)
        for match in _SECTION_CHAPTER_RE.finditer(text)
    ]

    return sorted(dotted_headings + section_headings, key=lambda marker: marker.offset)


def _looks_like_heading_title(title: str) -> bool:
    """A numbered line's title text is heading-shaped if it's short and
    written in Title Case rather than ordinary sentence case (see
    _MIN_TITLE_CASE_FRACTION above for why this, not the title's trailing
    letter, is the discriminating signal)."""
    stripped = title.strip()
    if not stripped or len(stripped) > _MAX_HEADING_TITLE_LENGTH:
        return False

    trailing_words = stripped.split()[1:]
    if not trailing_words:
        return True  # single-word titles ("Introduction") are trivially Title Case

    capitalized = sum(1 for word in trailing_words if word[:1].isupper())
    return (capitalized / len(trailing_words)) >= _MIN_TITLE_CASE_FRACTION


def _is_list_item_run(
    marker: HeadingMarker, all_candidates: list[HeadingMarker], text: str
) -> bool:
    """True if `marker` sits immediately adjacent (next line, no blank-
    line paragraph break) to another dotted-number candidate - the
    hallmark of a numbered list rather than section headings, which are
    always separated by body text. A candidate with no such neighbor
    (before or after) is a genuine, isolated heading."""
    index = all_candidates.index(marker)
    has_adjacent_before = index > 0 and not _has_blank_line_between(
        text, all_candidates[index - 1].offset, marker.offset
    )
    has_adjacent_after = index < len(all_candidates) - 1 and not _has_blank_line_between(
        text, marker.offset, all_candidates[index + 1].offset
    )
    return has_adjacent_before or has_adjacent_after


def _has_blank_line_between(text: str, start: int, end: int) -> bool:
    """Whether a blank-line paragraph break occurs anywhere in
    text[start:end] - the same separator shape splitting.py's
    _PARAGRAPH_SEPARATOR_RE looks for."""
    return "\n\n" in text[start:end] or "\n\r\n" in text[start:end]
