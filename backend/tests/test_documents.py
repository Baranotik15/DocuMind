import io
from pathlib import Path

import pytest
from docx import Document as DocxDocument

from app.chunks.splitting import split_into_chunks
from app.documents.extraction import UnsupportedFileTypeError, extract_text

FIXTURES_DIR = Path(__file__).parent / "fixtures"

# Must match the text baked into tests/fixtures/sample.pdf by the fixture
# generator (see the commit message / PR description for how it was made).
PDF_FIXTURE_KNOWN_TEXT = "DocuMind sample PDF fixture for extraction tests."


def _build_docx_bytes(paragraphs: list[str]) -> bytes:
    document = DocxDocument()
    for paragraph in paragraphs:
        document.add_paragraph(paragraph)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


# --- extract_text ---------------------------------------------------------


def test_extract_text_txt_returns_exact_content() -> None:
    content = "Hello, world!\nSecond line.\n"

    result = extract_text("notes.txt", content.encode("utf-8"))

    assert result == content


def test_extract_text_md_returns_exact_content() -> None:
    content = "# Heading\n\nBody text with **emphasis**.\n"

    result = extract_text("README.md", content.encode("utf-8"))

    assert result == content


def test_extract_text_is_case_insensitive_on_extension() -> None:
    content = "Uppercase extension still works."

    result = extract_text("NOTES.TXT", content.encode("utf-8"))

    assert result == content


def test_extract_text_pdf_returns_known_text() -> None:
    data = (FIXTURES_DIR / "sample.pdf").read_bytes()

    result = extract_text("sample.pdf", data)

    assert PDF_FIXTURE_KNOWN_TEXT in result


def test_extract_text_docx_returns_paragraph_text() -> None:
    data = _build_docx_bytes(["First paragraph.", "Second paragraph."])

    result = extract_text("notes.docx", data)

    assert "First paragraph." in result
    assert "Second paragraph." in result


def test_extract_text_raises_for_unsupported_extension() -> None:
    with pytest.raises(UnsupportedFileTypeError):
        extract_text("virus.exe", b"whatever bytes")


def test_extract_text_raises_for_extensionless_filename() -> None:
    with pytest.raises(UnsupportedFileTypeError):
        extract_text("no_extension_at_all", b"whatever bytes")


# --- split_into_chunks -----------------------------------------------------
#
# Hard contract: "".join(split_into_chunks(text)) == text EXACTLY, always -
# no trimming, no whitespace normalization, no dropped characters.
#
# Guarantee this implementation provides beyond the bare minimum: every
# returned chunk (not just all-but-the-last) has length <= max_chars. This
# is achievable because a paragraph longer than max_chars is hard-split
# (at sentence boundaries, falling back to a raw character cut) rather than
# ever being allowed to stand as an oversized chunk.


def test_split_into_chunks_short_text_returns_single_chunk() -> None:
    text = "Just a short paragraph, well under the limit."

    result = split_into_chunks(text, max_chars=1500)

    assert result == [text]
    assert "".join(result) == text


def test_split_into_chunks_multi_paragraph_over_limit_splits_on_paragraphs() -> None:
    paragraph = "Lorem ipsum dolor sit amet. " * 3
    text = "\n\n".join([paragraph] * 5)

    result = split_into_chunks(text, max_chars=200)

    assert "".join(result) == text
    assert len(result) > 1
    for chunk in result:
        assert len(chunk) <= 200


def test_split_into_chunks_huge_single_paragraph_hard_splits() -> None:
    sentence = "This is one sentence in a very long paragraph. "
    text = sentence * 50  # no blank lines anywhere in the whole string

    result = split_into_chunks(text, max_chars=200)

    assert "".join(result) == text
    assert len(result) > 1
    for chunk in result:
        assert len(chunk) <= 200


def test_split_into_chunks_empty_string_returns_empty_list() -> None:
    result = split_into_chunks("")

    assert result == []
    assert "".join(result) == ""


def test_split_into_chunks_uses_default_max_chars() -> None:
    text = "x" * 3000

    result = split_into_chunks(text)

    assert "".join(result) == text
    assert len(result) > 1
    for chunk in result:
        assert len(chunk) <= 1500
