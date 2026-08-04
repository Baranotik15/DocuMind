import io
from pathlib import Path

from docx import Document as DocxDocument
from pypdf import PdfReader

from app.documents.constants import SUPPORTED_DOCUMENT_EXTENSIONS


class UnsupportedFileTypeError(Exception):
    """Raised by extract_text for any extension other than .pdf, .docx,
    .md, .txt (case-insensitive)."""


def extract_text(filename: str, data: bytes) -> str:
    """Extracts plain text from `data` based on filename's extension.
    .pdf via pypdf, .docx via python-docx, .md/.txt via UTF-8 decode."""
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_DOCUMENT_EXTENSIONS:
        raise UnsupportedFileTypeError(f"Unsupported file type: {filename}")
    if extension == ".pdf":
        return _extract_pdf_text(data)
    if extension == ".docx":
        return _extract_docx_text(data)
    return data.decode("utf-8")


def _extract_pdf_text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _extract_docx_text(data: bytes) -> str:
    document = DocxDocument(io.BytesIO(data))
    return "\n".join(paragraph.text for paragraph in document.paragraphs)
