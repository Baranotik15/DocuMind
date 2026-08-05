from app.chunks.headings import (
    HeadingMarker,
    detect_markdown_headings,
    detect_numbered_headings,
)


# --- detect_markdown_headings (tier 1) ---------------------------------


def test_markdown_single_h1_at_start_of_text() -> None:
    text = "# Title\n\nBody"

    result = detect_markdown_headings(text)

    assert result == [HeadingMarker(offset=0, level=1)]


def test_markdown_h2_mid_document() -> None:
    text = "Intro\n\n## Section\n\nBody"

    result = detect_markdown_headings(text)

    assert result == [HeadingMarker(offset=text.index("## Section"), level=2)]


def test_markdown_multiple_headings_mixed_levels_ascending_offset_order() -> None:
    text = "# Title\n\nIntro text.\n\n## First\n\nBody one.\n\n### Sub\n\nBody two.\n\n## Second\n\nBody three."

    result = detect_markdown_headings(text)

    assert result == [
        HeadingMarker(offset=text.index("# Title"), level=1),
        HeadingMarker(offset=text.index("## First"), level=2),
        HeadingMarker(offset=text.index("### Sub"), level=3),
        HeadingMarker(offset=text.index("## Second"), level=2),
    ]


def test_markdown_no_hash_anywhere_returns_empty() -> None:
    text = "Just plain text.\n\nNo markdown here at all."

    assert detect_markdown_headings(text) == []


def test_markdown_hash_mid_sentence_not_matched() -> None:
    text = "C# is a language.\n\nSome more text about C# programming."

    assert detect_markdown_headings(text) == []


def test_markdown_requires_space_after_hashes() -> None:
    # '#NoSpace' is not valid ATX syntax - must not match.
    text = "#NoSpace\n\nBody"

    assert detect_markdown_headings(text) == []


def test_markdown_all_six_levels() -> None:
    text = "\n\n".join(f"{'#' * level} Heading {level}" for level in range(1, 7))

    result = detect_markdown_headings(text)

    assert [marker.level for marker in result] == [1, 2, 3, 4, 5, 6]


# --- detect_numbered_headings (tier 3) ----------------------------------


def test_numbered_dotted_prefix_two_headings_level_one() -> None:
    text = "1. Introduction\n\nBody text.\n\n2. Overview\n\nMore text."

    result = detect_numbered_headings(text)

    assert result == [
        HeadingMarker(offset=text.index("1. Introduction"), level=1),
        HeadingMarker(offset=text.index("2. Overview"), level=1),
    ]


def test_numbered_two_level_dotted_prefix_is_level_two() -> None:
    text = "2.1 Background\n\nBody"

    result = detect_numbered_headings(text)

    assert result == [HeadingMarker(offset=0, level=2)]


def test_numbered_section_colon_pattern_is_level_one() -> None:
    text = "Section 3: Refunds\n\nBody"

    result = detect_numbered_headings(text)

    assert result == [HeadingMarker(offset=0, level=1)]


def test_numbered_chapter_pattern_is_level_one() -> None:
    text = "Chapter 4\n\nBody text about chapter four."

    result = detect_numbered_headings(text)

    assert result == [HeadingMarker(offset=0, level=1)]


def test_numbered_list_false_positive_not_treated_as_headings() -> None:
    # A genuine numbered TO-DO list, not a document's section structure.
    # Each line is a short imperative sentence, not a heading-shaped title.
    text = "1. Buy milk\n2. Walk the dog\n3. Call mom"

    result = detect_numbered_headings(text)

    assert result == []


def test_numbered_no_pattern_anywhere_returns_empty() -> None:
    text = "Just plain text.\n\nNo numbering here at all."

    assert detect_numbered_headings(text) == []


def test_numbered_headings_ordered_by_offset_ascending() -> None:
    text = "1. Intro\n\nBody.\n\n1.1 Sub-point\n\nMore body.\n\n2. Next\n\nEven more."

    result = detect_numbered_headings(text)

    offsets = [marker.offset for marker in result]
    assert offsets == sorted(offsets)
    assert [marker.level for marker in result] == [1, 2, 1]
