import io
from pathlib import Path

import pytest
from docx import Document as DocxDocument
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as pdf_canvas

from app.chunks.headings import HeadingMarker
from app.chunks.splitting import split_document
from app.chunks.tokens import count_tokens
from app.documents.extraction import (
    UnsupportedFileTypeError,
    _locate_heading_offsets,
    extract_document,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"

# Must match the text baked into tests/fixtures/sample.pdf by the fixture
# generator (see the commit message / PR description for how it was made).
PDF_FIXTURE_KNOWN_TEXT = "DocuMind sample PDF fixture for extraction tests."


def _build_docx_bytes(paragraphs: list[str], styles: list[str | None] | None = None) -> bytes:
    document = DocxDocument()
    for index, paragraph in enumerate(paragraphs):
        style = styles[index] if styles else None
        if style:
            document.add_paragraph(paragraph, style=style)
        else:
            document.add_paragraph(paragraph)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _build_pdf_bytes(
    lines: list[tuple[str, int]], outline_titles: list[str] | None = None
) -> bytes:
    """Builds a single-page PDF with one `text` line per (text, font_size)
    tuple, each drawn at that font size (mirrors _build_docx_bytes's role
    for DOCX fixtures, using reportlab instead of python-docx). If
    `outline_titles` is given, adds each as a top-level PDF outline/
    bookmark entry pointing at the page - a distinct bookmark key per
    title is required here, since reportlab's Canvas.addOutlineEntry
    mixes up titles when multiple entries share the same key (reusing one
    key for every entry made every outline title resolve to the *last*
    title added, confirmed against this installed reportlab version)."""
    buffer = io.BytesIO()
    canvas = pdf_canvas.Canvas(buffer, pagesize=letter)
    _, height = letter
    y = height - 72
    for text, font_size in lines:
        canvas.setFont("Helvetica", font_size)
        canvas.drawString(72, y, text)
        y -= font_size + 6
    if outline_titles:
        for index, title in enumerate(outline_titles):
            key = f"heading-{index}"
            canvas.bookmarkPage(key)
            canvas.addOutlineEntry(title, key, level=0)
    canvas.showPage()
    canvas.save()
    return buffer.getvalue()


# --- extract_document: text -------------------------------------------------


def test_extract_text_txt_returns_exact_content() -> None:
    content = "Hello, world!\nSecond line.\n"

    result = extract_document("notes.txt", content.encode("utf-8")).text

    assert result == content


def test_extract_text_md_returns_exact_content() -> None:
    content = "# Heading\n\nBody text with **emphasis**.\n"

    result = extract_document("README.md", content.encode("utf-8")).text

    assert result == content


def test_extract_text_is_case_insensitive_on_extension() -> None:
    content = "Uppercase extension still works."

    result = extract_document("NOTES.TXT", content.encode("utf-8")).text

    assert result == content


def test_extract_text_pdf_returns_known_text() -> None:
    data = (FIXTURES_DIR / "sample.pdf").read_bytes()

    result = extract_document("sample.pdf", data).text

    assert PDF_FIXTURE_KNOWN_TEXT in result


def test_extract_text_docx_returns_paragraph_text() -> None:
    data = _build_docx_bytes(["First paragraph.", "Second paragraph."])

    result = extract_document("notes.docx", data).text

    assert "First paragraph." in result
    assert "Second paragraph." in result


def test_extract_text_raises_for_unsupported_extension() -> None:
    with pytest.raises(UnsupportedFileTypeError):
        extract_document("virus.exe", b"whatever bytes")


def test_extract_text_raises_for_extensionless_filename() -> None:
    with pytest.raises(UnsupportedFileTypeError):
        extract_document("no_extension_at_all", b"whatever bytes")


# --- extract_document: DOCX heading styles (tier 2) -------------------------


def test_extract_document_docx_no_heading_styles_returns_no_headings() -> None:
    data = _build_docx_bytes(["First paragraph.", "Second paragraph."])

    result = extract_document("notes.docx", data)

    assert result.headings == []


def test_extract_document_docx_all_normal_style_returns_no_headings() -> None:
    paragraphs = ["Overview", "Body one.", "Details", "Body two."]
    data = _build_docx_bytes(paragraphs, styles=[None, None, None, None])

    result = extract_document("notes.docx", data)

    assert result.headings == []


def test_extract_document_docx_heading_styles_produce_markers() -> None:
    paragraphs = ["Overview", "Body one.", "Details", "Body two."]
    data = _build_docx_bytes(paragraphs, styles=["Heading 1", None, "Heading 2", None])

    result = extract_document("notes.docx", data)

    overview_offset = result.text.index("Overview")
    details_offset = result.text.index("Details")
    assert result.headings == [
        HeadingMarker(offset=overview_offset, level=1),
        HeadingMarker(offset=details_offset, level=2),
    ]


# --- extract_document: PDF outline / font-size headings (tiers 2, 4) -------


def test_extract_document_pdf_with_outline_uses_outline_titles() -> None:
    lines = [
        ("Introduction", 12),
        ("Body text explaining the overview of this document.", 12),
        ("Conclusion", 12),
        ("Body text wrapping everything up.", 12),
    ]
    data = _build_pdf_bytes(lines, outline_titles=["Introduction", "Conclusion"])

    result = extract_document("outline.pdf", data)

    assert result.headings == [
        HeadingMarker(offset=result.text.index("Introduction"), level=1),
        HeadingMarker(offset=result.text.index("Conclusion"), level=1),
    ]


def test_extract_document_pdf_no_outline_larger_font_line_is_heading() -> None:
    lines = [
        ("Body text at normal size before the heading.", 10),
        ("A Bigger Heading Line", 18),
        ("Body text at normal size after the heading.", 10),
        ("More body text to strengthen the normal-size mode.", 10),
    ]
    data = _build_pdf_bytes(lines)

    result = extract_document("no-outline.pdf", data)

    assert result.headings == [
        HeadingMarker(offset=result.text.index("A Bigger Heading Line"), level=1),
    ]


def test_extract_document_pdf_uniform_font_no_outline_returns_no_headings() -> None:
    lines = [
        ("Line one is here.", 12),
        ("Line two follows along.", 12),
        ("Line three wraps it up nicely.", 12),
    ]
    data = _build_pdf_bytes(lines)

    result = extract_document("uniform.pdf", data)

    assert result.headings == []


def test_extract_document_pdf_outline_wins_over_larger_font_line() -> None:
    lines = [
        ("Introduction", 12),
        ("Body text explaining things in normal size.", 12),
        ("A Bigger Heading Line", 18),
        ("More normal body text after the big line.", 12),
    ]
    data = _build_pdf_bytes(lines, outline_titles=["Introduction"])

    result = extract_document("both.pdf", data)

    # Only the outline-derived marker appears - if tier 4 had also run
    # (rather than being skipped once tier 2 fired), "A Bigger Heading
    # Line" would show up as a second marker here too.
    assert result.headings == [
        HeadingMarker(offset=result.text.index("Introduction"), level=1),
    ]


def test_locate_heading_offsets_resolves_duplicate_titles_to_distinct_offsets() -> None:
    full_text = "Intro\n\nBody one.\n\nIntro\n\nBody two."
    first_offset = full_text.index("Intro")
    second_offset = full_text.index("Intro", first_offset + len("Intro"))
    assert first_offset != second_offset

    result = _locate_heading_offsets(full_text, ["Intro", "Intro"])

    assert result == [first_offset, second_offset]


def test_locate_heading_offsets_omits_titles_not_found() -> None:
    full_text = "Alpha\n\nBody.\n\nGamma\n\nMore body."

    result = _locate_heading_offsets(full_text, ["Alpha", "Missing Title", "Gamma"])

    assert result == [full_text.index("Alpha"), full_text.index("Gamma")]


# --- split_document ---------------------------------------------------------
#
# Hard contract: "".join(split_document(text, ...)) == text EXACTLY, always -
# no trimming, no whitespace normalization, no dropped characters.
#
# Guarantee this implementation provides beyond the bare minimum: every
# returned chunk (not just all-but-the-last) has count_tokens(chunk) <=
# max_tokens. This is achievable because a paragraph whose own token count
# exceeds max_tokens is hard-split further (at sentence boundaries, falling
# back to a raw character cut) rather than ever being allowed to stand as a
# single oversized chunk.
#
# These fixtures have no markdown/numbered structure, so split_document's
# tier 1/3 fallback finds nothing and the whole text is one section - same
# paragraph/sentence/raw-cut behavior split_into_chunks used to have,
# exercised through split_document's token-counted _split_section_to_size.


def test_split_document_short_text_returns_single_chunk() -> None:
    text = "Just a short paragraph, well under the limit."

    result = split_document(text, max_tokens=1500)

    assert result == [text]
    assert "".join(result) == text


def test_split_document_multi_paragraph_over_limit_splits_on_paragraphs() -> None:
    paragraph = "Lorem ipsum dolor sit amet. " * 3
    text = "\n\n".join([paragraph] * 5)
    # A single paragraph fits under this limit but two back-to-back don't,
    # so each chunk holds (at most) one paragraph - computed from the
    # fixture's actual token count rather than reusing the old char-based
    # max_chars=200 magic number, since token count != character count.
    max_tokens = count_tokens(paragraph) + 5

    result = split_document(text, max_tokens=max_tokens)

    assert "".join(result) == text
    assert len(result) > 1
    for chunk in result:
        assert count_tokens(chunk) <= max_tokens


def test_split_document_huge_single_paragraph_hard_splits() -> None:
    sentence = "This is one sentence in a very long paragraph. "
    text = sentence * 50  # no blank lines anywhere in the whole string
    max_tokens = 50
    assert count_tokens(text) > max_tokens  # sanity: fixture must exceed the limit

    result = split_document(text, max_tokens=max_tokens)

    assert "".join(result) == text
    assert len(result) > 1
    for chunk in result:
        assert count_tokens(chunk) <= max_tokens


def test_split_document_empty_string_returns_empty_list() -> None:
    result = split_document("")

    assert result == []
    assert "".join(result) == ""


def test_split_document_uses_default_max_tokens() -> None:
    # Sized well past DEFAULT_MAX_TOKENS (80, deliberately small - about
    # 3-4 lines of body text) so this fixture reliably exercises the
    # default without hardcoding an unrelated char count.
    text = "x" * 5000
    assert count_tokens(text) > 80  # sanity: fixture must exceed the default

    result = split_document(text)

    assert "".join(result) == text
    assert len(result) > 1
    for chunk in result:
        assert count_tokens(chunk) <= 80


# --- split_document: heading-aware sectioning -------------------------------


def test_split_document_no_headings_given_falls_back_to_markdown_tier() -> None:
    text = (
        "# Intro\n\nSome intro text.\n\n"
        "## Details\n\nMore body text here, still short.\n"
    )
    details_offset = text.index("## Details")

    result = split_document(text, max_tokens=1500)

    assert result == [text[:details_offset], text[details_offset:]]
    assert "".join(result) == text


def test_split_document_given_headings_win_over_markdown_tier() -> None:
    # The text also contains '#'-prefixed lines that tier 1 would detect
    # on its own - given headings must be used as-is and tier 1/3 must
    # never run, so the split lands only at the explicitly given offset,
    # not at either '#' line.
    text = "# Heading A\n\nSome body.\n\n# Heading B\n\nMore body.\n"
    custom_offset = text.index("Some body")
    headings = [HeadingMarker(offset=custom_offset, level=1)]

    result = split_document(text, headings=headings, max_tokens=1500)

    assert result == [text[:custom_offset], text[custom_offset:]]
    assert "".join(result) == text
    # The second section still contains the untouched "# Heading B" line -
    # proof tier 1 never ran against it.
    assert "# Heading B" in result[1]


def test_split_document_oversized_section_is_split_further() -> None:
    heading1 = "# Intro\n\n"
    body1 = "Short body.\n\n"
    heading2 = "# Details\n\n"
    body2 = "This is one sentence in a very long paragraph. " * 30
    text = heading1 + body1 + heading2 + body2
    max_tokens = 50
    assert count_tokens(body2) > max_tokens  # sanity: second section must overflow

    result = split_document(text, max_tokens=max_tokens)

    assert "".join(result) == text
    # Two headings, but the oversized second section produces more than
    # one chunk on its own, so the total exceeds the heading count.
    assert len(result) > 2
    for chunk in result:
        assert count_tokens(chunk) <= max_tokens
