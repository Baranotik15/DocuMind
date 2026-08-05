# Structured Chunking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split documents at their real structural boundaries (headings)
wherever recoverable, falling back through a fixed priority chain down to
today's paragraph/sentence/fixed-size behavior - per
`.claude/specs/structured-chunking.md`.

**Architecture:** Two new leaf modules under `app/chunks/` - `headings.py`
(format-agnostic text-pattern heading detection: markdown syntax, numbered
pseudo-headings) and `tokens.py` (token counting). `app/documents/
extraction.py` is extended to also return format-native heading signals
(DOCX paragraph styles, PDF outline/font-size) alongside the exact-text
contract it already has. `app/chunks/splitting.py`'s `split_into_chunks` is
replaced by `split_document`, which slices at whichever heading signal is
available (falling back to `headings.py`'s text-pattern detectors, then to
one whole-document section) and token-limits each resulting section via the
same paragraph -> sentence -> hard-cut fallback shape already in the
codebase. `documents/pipeline.py`/`documents/tasks.py` thread the new
`headings` data through; the manual chunk-boundary Save path
(`run_pipeline_with_manual_chunks`) is untouched.

**Tech Stack:** Python, `tiktoken` (new dependency - token counting),
`reportlab` (new dev/test-only dependency - generating PDF fixtures with
real outlines/font sizes in tests, same role `python-docx` already plays
for DOCX fixtures in `tests/test_documents.py`), `pypdf` (already a
dependency - `PdfReader.outline` for tier 2, `page.extract_text
(visitor_text=...)` for tier 4), `python-docx` (already a dependency -
`paragraph.style.name` for tier 2).

---

## Key design decisions (read before starting)

- **Tiers 1 (markdown `#`) and 3 (numbered pseudo-headings) are pure text
  functions, not extraction-format-specific** - they live in
  `app/chunks/headings.py` and are tried by `split_document` itself
  whenever it receives no headings, regardless of *why* it received none
  (a `.txt` upload never had any; a Save-triggered automatic re-chunk only
  has the operator's edited plain text, never the original file bytes, so
  it can't get tier 2/4 signals either but can still get 1/3). This is
  simpler than making extraction.py special-case `.md` for tier 1.
- **Tiers 2 (DOCX styles / PDF outline) and 4 (PDF font-size) genuinely
  need the original file bytes** - they live in `app/documents/
  extraction.py`, computed once during initial-upload extraction, and are
  NOT available on the Save-without-manual-boundaries re-chunk path (which
  only ever has already-extracted/edited text, no file bytes) - that path
  passes `headings=None` and relies on `split_document`'s own tier 1/3
  fallback.
- **All heading levels are section boundaries** - a document isn't
  filtered down to "only H1" or similar; every detected heading (any
  level) starts a new section. Finer sections are better for retrieval
  precision than fewer, bigger ones.
- **A section's own heading line is its first line** - slicing happens at
  each heading's character offset, same boundary-list slicing pattern
  `_split_into_paragraph_segments` already uses, so `"".join(sections) ==
  text` always holds.
- **Chunk size limit moves from `max_chars` to `max_tokens`**, counted
  with `tiktoken`'s `cl100k_base` encoding (matches the
  `text-embedding-3-small`/`gpt-4o-mini` family this app already uses).
  New default: `DEFAULT_MAX_TOKENS = 400` (roughly equivalent to the old
  1500-character default, now measured accurately).
- **PDF fixtures are generated in-test via `reportlab`**, not hand-crafted
  binary files - same idiom `tests/test_documents.py`'s `_build_docx_bytes`
  already uses for DOCX, applied to PDF (set font size per text run, add
  outline entries).

---

### Task 1: Token counting helper

**Files:**
- Create: `backend/app/chunks/tokens.py`
- Modify: `backend/requirements.txt` (add `tiktoken`)
- Test: `backend/tests/test_tokens.py`

**Contracts:**

```python
# backend/app/chunks/tokens.py

def count_tokens(text: str) -> int:
    """Returns the token count `text` would have under this app's
    embedding model's tokenizer (cl100k_base, shared by
    text-embedding-3-small and gpt-4o-mini). Empty string -> 0.
    Encoder is loaded once at module import time (tiktoken.get_encoding
    is not cheap to call per-invocation) and reused."""
    ...
```

**Step 1: Write the failing test**

`test_tokens.py`: assert `count_tokens("")  == 0`; assert `count_tokens("hello world")` is a small positive int matching `len(tiktoken.get_encoding("cl100k_base").encode("hello world"))` computed directly in the test (don't hardcode a magic number - compute the expected value the same way, so the test documents the *contract* rather than pinning tiktoken's exact tokenization of one string); assert token count scales up for a much longer string (`count_tokens(long_text) > count_tokens(short_text)`).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_tokens.py -v`
Expected: FAIL (`app.chunks.tokens` doesn't exist yet)

**Step 2: Implement**

Add `tiktoken` to `requirements.txt`, install it (`pip install tiktoken` into `backend/.venv`, or `docker compose exec backend pip install tiktoken` - whichever this session's environment needs; note the backend Docker image also needs rebuilding later once all tasks land, not per-task). Implement `count_tokens` per the contract above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_tokens.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/chunks/tokens.py backend/tests/test_tokens.py backend/requirements.txt
git commit -m "feat(chunks): add tiktoken-based token counting helper"
```

---

### Task 2: Format-agnostic heading detection (tiers 1 and 3)

**Files:**
- Create: `backend/app/chunks/headings.py`
- Test: `backend/tests/test_headings.py`

**Contracts:**

```python
# backend/app/chunks/headings.py
from dataclasses import dataclass


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
    ...


def detect_numbered_headings(text: str) -> list[HeadingMarker]:
    """Tier 3. Matches numbered/lettered pseudo-heading lines at the
    start of a line - dotted numeric prefixes ('1. Introduction', '2.1
    Overview', '3) Something') and 'Section N'/'Chapter N' (case-
    insensitive). `level` = the dotted-number depth (1 -> level 1, 2.1 ->
    level 2); 'Section'/'Chapter' lines are always level 1. To avoid
    matching ordinary numbered list items, only treat a numbered line as
    a heading candidate if it's short (no more than ~80 chars) and its
    first line doesn't end mid-sentence (no trailing lowercase-letter-
    then-nothing pattern typical of a truncated list item - use your
    judgment on the exact heuristic, document it in a comment, and cover
    the false-positive case in tests). Returns [] if none found. Ordered
    by offset ascending."""
    ...
```

**Step 1: Write the failing tests**

`test_headings.py`, for `detect_markdown_headings`:
- `"# Title\n\nBody"` -> one marker, `offset=0`, `level=1`.
- `"Intro\n\n## Section\n\nBody"` -> one marker at the `##` line's offset, `level=2`.
- Multiple headings of mixed levels -> markers in ascending offset order, correct levels each.
- No `#` anywhere -> `[]`.
- A `#` that isn't at the start of a line (e.g. mid-sentence "C# is a language") -> not matched.

For `detect_numbered_headings`:
- `"1. Introduction\n\nBody text.\n\n2. Overview\n\nMore text."` -> two markers, levels both 1, offsets at each numbered line's start.
- `"2.1 Background\n\nBody"` -> one marker, `level=2`.
- `"Section 3: Refunds\n\nBody"` -> one marker, `level=1`.
- A numbered LIST ("1. Buy milk\n2. Walk the dog\n3. Call mom") should NOT all become headings - assert this returns `[]` or something clearly distinguishable from a real section split (this is the key false-positive case to nail down).
- No numeric/section pattern anywhere -> `[]`.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_headings.py -v`
Expected: FAIL (module doesn't exist yet)

**Step 2: Implement**

Implement both functions per the contracts. Use `re` (already used this way in `splitting.py` - follow that file's compiled-module-level-regex pattern).

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_headings.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/chunks/headings.py backend/tests/test_headings.py
git commit -m "feat(chunks): add markdown and numbered-heading detection (tiers 1, 3)"
```

---

### Task 3: Extraction returns structure - DOCX heading styles (tier 2)

**Files:**
- Modify: `backend/app/documents/extraction.py`
- Modify: `backend/tests/test_documents.py` (existing `extract_text` call
  sites and assertions - see below)
- Reference: `backend/app/chunks/headings.py` (Task 2, for `HeadingMarker`)

**Contracts:**

```python
# backend/app/documents/extraction.py
from dataclasses import dataclass
from app.chunks.headings import HeadingMarker


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
    """Unchanged."""


def extract_document(filename: str, data: bytes) -> ExtractedDocument:
    """Replaces extract_text. Same extension dispatch/validation as
    before (raises UnsupportedFileTypeError for the same cases)."""
    ...
```

Remove `extract_text` entirely (no back-compat wrapper - every caller
moves to `extract_document(...).text` or uses `.headings` too, per this
project's existing no-compat-shims convention).

```python
def _extract_docx_document(data: bytes) -> ExtractedDocument:
    """Joins paragraph text exactly as the old _extract_docx_text did
    ("\n".join(p.text for p in document.paragraphs)). While joining,
    tracks the running character offset of each paragraph; whenever a
    paragraph's `paragraph.style.name` matches r'^Heading (\d+)$'
    (python-docx's own built-in style naming), records a HeadingMarker at
    that paragraph's start offset with level = the matched digit. A
    'Title'-styled paragraph (Word's Title style, distinct from 'Heading
    N') counts as level 1 too. Order preserved."""
    ...
```

**Integration:**
- `_extract_pdf_document` is added in Task 4, not here - stub it to
  `ExtractedDocument(text=_extract_pdf_text(data), headings=[])` for this
  task (reusing the private helper that already exists) so PDF extraction
  keeps working while DOCX is landed first; Task 4 replaces the stub.
- `documents/router.py`, `documents/tasks.py` don't call extraction yet in
  this task - that's Task 6. This task only changes `extraction.py` and
  its own direct tests.

**Step 1: Write the failing tests**

Update `tests/test_documents.py`:
- Replace every `extract_text(...)` call with `extract_document(...).text`
  (existing assertions unchanged otherwise) for the `.txt`/`.md`/
  unsupported-extension tests - these should keep passing once the rename
  lands.
- New: `_build_docx_bytes` needs a way to set a paragraph's style - add an
  optional `styles: list[str | None] = None` parallel list param (one
  entry per paragraph, `None` = default/"Normal"), using
  `document.add_paragraph(text, style=style)` when given.
- New test: a DOCX with `["Overview", "Body one.", "Details", "Body
  two."]` and styles `[None, None, None, None]` -> `extract_document(...)
  .headings == []` (no heading styles used at all).
- New test: same paragraphs with styles `["Heading 1", None, "Heading 2",
  None]` -> two markers, levels 1 and 2, offsets matching where
  "Overview"/"Details" actually start in the joined text (compute the
  expected offset from the joined text itself, e.g. `text.index
  ("Details")`, don't hardcode a byte count).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_documents.py -v`
Expected: FAIL

**Step 2: Implement**

Implement `ExtractedDocument`, `extract_document`, `_extract_docx_document`
per the contracts. Keep `_extract_pdf_text`'s existing body as-is for now
(Task 4 replaces its caller, not its logic).

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_documents.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/documents/extraction.py backend/tests/test_documents.py
git commit -m "feat(documents): extract_document returns DOCX heading-style structure (tier 2)"
```

---

### Task 4: PDF outline and font-size heading detection (tiers 2, 4)

**Files:**
- Modify: `backend/app/documents/extraction.py`
- Modify: `backend/requirements.txt` (add `reportlab`)
- Modify: `backend/tests/test_documents.py`

**Contracts:**

```python
def _extract_pdf_document(data: bytes) -> ExtractedDocument:
    """Joins per-page text exactly as the old _extract_pdf_text did
    ("\n".join(page.extract_text() or "" for page in reader.pages)).
    Tries the PDF's own embedded outline first (tier 2, via
    PdfReader.outline - a nested list of Destination-like objects, each
    with a .title and a page reference); if at least one outline entry's
    title can be located in the joined text (via _locate_heading_offsets),
    uses those as headings and skips tier 4 entirely for this document.
    Otherwise falls back to font-size analysis (tier 4): re-extracts each
    page via page.extract_text(visitor_text=...), recording (text_run,
    font_size) fragments; computes each page's dominant font size (the
    mode); any run rendered notably larger than that dominant size (pick
    a threshold - e.g. at least 20% larger - and document your choice)
    becomes a heading candidate, its own text located via
    _locate_heading_offsets. Distinct candidate sizes are bucketed
    descending into levels (largest size seen = level 1, next distinct
    size = level 2, ...). Returns ExtractedDocument with whichever tier
    fired (or headings=[] if neither did)."""
    ...


def _locate_heading_offsets(full_text: str, titles_in_order: list[str]) -> list[int]:
    """For each title in `titles_in_order`, finds its first occurrence in
    `full_text` at or after the end of the previous match (so duplicate
    titles resolve to distinct occurrences, in the given order) - skips
    (omits, does not raise for) any title that can't be found at all,
    since PDF text extraction can introduce whitespace/ligature
    differences from an outline's stored title string. Returns offsets
    only for titles actually found, same relative order as the input."""
    ...
```

**Integration:**
- `extract_document`'s `.pdf` branch now calls `_extract_pdf_document`
  directly (replace Task 3's stub).

**Step 1: Write the failing tests**

Add a PDF fixture builder to `test_documents.py`, using `reportlab`
(`reportlab.pdfgen.canvas.Canvas`, `reportlab.lib.pagesizes`) - mirror
`_build_docx_bytes`'s shape:

```python
def _build_pdf_bytes(
    lines: list[tuple[str, int]],  # (text, font_size) per line
    outline_titles: list[str] | None = None,  # if given, add these as top-level outline/bookmark entries pointing at the page
) -> bytes: ...
```

Tests:
- A PDF with an outline whose titles match real lines in the page text ->
  `extract_document(...).headings` has one marker per outline title,
  correct offsets (via `text.index(title)`), tier 2 wins.
- A PDF with no outline, but one line rendered at a clearly larger font
  size than the rest (e.g. body at 10pt, one heading line at 18pt) ->
  one marker at that line's offset, tier 4 fires.
- A PDF with no outline and uniform font size throughout -> `headings ==
  []` (neither tier 2 nor 4 has anything to find).
- A PDF with BOTH an outline and a larger-font line -> only tier 2's
  outline-derived markers appear (tier 4 never runs) - assert on marker
  count/positions to confirm this precedence.
- `_locate_heading_offsets` tested directly (no need to go through a real
  PDF for this one): given `full_text` with a repeated substring and a
  `titles_in_order` list containing that substring twice, assert the two
  returned offsets are the two distinct positions in ascending order, not
  the same position twice. Given a title not present in `full_text` at
  all, assert it's simply omitted from the result (no exception).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_documents.py -v`
Expected: FAIL

**Step 2: Implement**

Add `reportlab` to `requirements.txt`. Implement `_extract_pdf_document`
and `_locate_heading_offsets` per the contracts.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_documents.py -v`
Expected: PASS. Also re-run the full suite once here (`pytest tests/ -q`)
since this is the most fiddly task - confirm nothing else regressed.

**Step 4: Commit**

```bash
git add backend/app/documents/extraction.py backend/tests/test_documents.py backend/requirements.txt
git commit -m "feat(documents): extract_document detects PDF outline and font-size headings (tiers 2, 4)"
```

---

### Task 5: Structure-aware splitting, token-limited

**Files:**
- Modify: `backend/app/chunks/splitting.py`
- Modify: `backend/tests/test_documents.py` (the `split_into_chunks`
  tests move/adapt here, or stay in this file - see below)
- Reference: `backend/app/chunks/headings.py` (Task 2),
  `backend/app/chunks/tokens.py` (Task 1)

**Contracts:**

```python
# backend/app/chunks/splitting.py
from app.chunks.headings import HeadingMarker, detect_markdown_headings, detect_numbered_headings
from app.chunks.tokens import count_tokens

DEFAULT_MAX_TOKENS = 400


def split_document(
    text: str,
    headings: list[HeadingMarker] | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> list[str]:
    """Replaces split_into_chunks as the pipeline's entry point. Same
    hard contract: "".join(result) == text exactly, always.

    If `headings` is falsy (None or []), tries detect_markdown_headings
    (tier 1) then detect_numbered_headings (tier 3) on `text` itself
    before giving up on structure entirely.

    If headings (given or tier-1/3-detected) is non-empty, slices `text`
    into sections at each marker's offset (see _split_into_sections) -
    each section's own heading line is its first line. If still empty
    after trying everything, the whole `text` is one section.

    Every section is then passed through _split_section_to_size so no
    returned chunk exceeds max_tokens."""
    ...


def _split_into_sections(text: str, headings: list[HeadingMarker]) -> list[str]:
    """Boundary-list slicing, same pattern as
    _split_into_paragraph_segments below: any headings with offset 0 do
    NOT create an empty leading section; text before the first heading
    (if any headings don't start at 0) becomes its own leading section.
    Concatenating the result reproduces `text` exactly."""
    ...


def _split_section_to_size(section: str, max_tokens: int) -> list[str]:
    """Same shape as today's split_into_chunks body (paragraph-preferred,
    hard-split an oversized paragraph at sentence boundaries falling back
    to a raw cut) but measured in tokens (count_tokens) instead of
    characters throughout - reuses/adapts _split_into_paragraph_segments
    and _hard_split, retargeted from max_chars to max_tokens. Guarantee
    unchanged: every returned piece is <= max_tokens tokens, via
    count_tokens."""
    ...
```

Keep `_split_into_paragraph_segments` (paragraph-boundary slicing, tier 5)
and adapt `_hard_split` (tier 6/7, sentence-then-raw-cut) - both already
exist and are format/size-unit-agnostic in their slicing logic; only the
size check (`len(segment) > max_chars` -> `count_tokens(segment) >
max_tokens`) changes.

Remove `split_into_chunks` entirely (no back-compat wrapper, matches
Task 3's `extract_text` removal).

**Step 1: Write the failing tests**

Move the existing `test_split_into_chunks_*` tests (currently in
`test_documents.py`, see the file read during planning) to call
`split_document(text, max_tokens=N)` instead of `split_into_chunks(text,
max_chars=N)` - same scenarios (short text, multi-paragraph over limit,
huge single paragraph, empty string, default limit), same underlying
behavior expected since `headings=None` with no markdown/numbered
structure in these fixtures means the whole text is one section, so the
tier 5/6/7 path is exercised exactly as before, just token-counted. Adjust
any hardcoded size thresholds in these tests since token count != the old
character count for the same fixture text - recompute expected splits
from `count_tokens`, don't reuse old char-based magic numbers blindly.

New tests, in this file or split_document-specific:
- `split_document(text_with_markdown_headings)` (no `headings` given) ->
  splits at the markdown headings (tier 1 fallback fires inside
  split_document itself).
- `split_document(text, headings=[HeadingMarker(offset=..., level=1),
  ...])` (headings given explicitly, as extraction.py would pass) ->
  splits at those exact offsets, ignoring whatever markdown/numbered
  patterns might coincidentally also be in the text (given headings win,
  tier 1/3 fallback never runs).
- A section between two headings that's itself over `max_tokens` -> gets
  further split by `_split_section_to_size`, so the total result has more
  chunks than there are headings, and every chunk is under the limit.
- Exact-reconstruction property test: for several of the above cases,
  assert `"".join(split_document(text, headings=...)) == text`.

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_documents.py -v`
Expected: FAIL

**Step 2: Implement**

Implement `split_document`, `_split_into_sections`, `_split_section_to_size`
per the contracts, adapting the existing `_split_into_paragraph_segments`/
`_hard_split` bodies to token-counting.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_documents.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/chunks/splitting.py backend/tests/test_documents.py
git commit -m "feat(chunks): split_document - heading-aware sectioning + token-limited fallback"
```

---

### Task 6: Wire structure through the pipeline

**Files:**
- Modify: `backend/app/documents/pipeline.py`
- Modify: `backend/app/documents/tasks.py`
- Modify: `backend/tests/test_pipeline.py`
- Modify: `backend/tests/test_tasks.py`
- Reference: `backend/app/chunks/splitting.py` (Task 5),
  `backend/app/documents/extraction.py` (Tasks 3-4)

**Contracts:**

```python
# backend/app/documents/pipeline.py

def run_pipeline(
    document_id: str,
    source_text: str,
    session: Session,
    headings: list[HeadingMarker] | None = None,
    user_email: str | None = None,
) -> None:
    """Adds `headings`, threaded straight into split_document (replacing
    the current `split_into_chunks(source_text)` call with
    `split_document(source_text, headings=headings)`). None/[] (the
    Save-triggered automatic re-chunk path, and any caller with no
    format-native structure available) lets split_document fall back to
    its own tier 1/3 text-pattern detection - unchanged behavior
    otherwise."""
    ...
```

`run_pipeline_with_manual_chunks` is NOT touched - it never calls
split_document/split_into_chunks, headings are irrelevant to it.

```python
# backend/app/documents/tasks.py

@celery_app.task(name="run_document_pipeline")
def run_document_pipeline(
    document_id: str,
    source_text: str | None = None,
    manual_chunks: list[str] | None = None,
    user_email: str | None = None,
) -> None:
    """Signature unchanged (no new Celery-boundary parameter - headings
    are never passed in from outside this task, see the design decisions
    section above). The third branch (both source_text and manual_chunks
    None - initial-processing path) now calls extract_document instead of
    extract_text, and threads its .headings into run_pipeline alongside
    .text. The other two branches (source_text given; manual_chunks
    given) pass headings=None to run_pipeline / don't call it at all,
    respectively - unchanged from today except run_pipeline's new
    keyword-only-by-convention param defaulting to None."""
    ...
```

**Integration:**
- `documents/tasks.py`'s initial-processing branch currently does:
  `data = deps.get_storage().read(row.storage_key); extracted_text =
  extract_text(row.filename, data); run_pipeline(document_id,
  extracted_text, session, user_email=user_email)`. Becomes: `extracted =
  extract_document(row.filename, data); run_pipeline(document_id,
  extracted.text, session, headings=extracted.headings,
  user_email=user_email)`.
- Update the `from app.documents.extraction import ...` import in both
  `pipeline.py` (if it imports anything from extraction - check current
  imports) and `tasks.py`.

**Step 1: Write the failing tests**

`test_pipeline.py`: extend the existing `test_run_pipeline_success_...`
test (or add a new one) to pass `headings=[HeadingMarker(offset=...,
level=1), ...]` into `run_pipeline` for a `source_text` containing two
distinct sections at those offsets, and assert the resulting `chunks`
rows (ordered by `position`) split at those section boundaries rather
than wherever paragraph/token limits alone would have put them. Also keep
a `headings=None` case asserting today's behavior (single flowing text,
no explicit headings) still produces the same *kind* of result as before
(paragraph/token-limited), now via split_document under the hood.

`test_tasks.py`: extend `run_document_pipeline`'s initial-processing-path
test(s) to patch `app.documents.tasks.extract_document` (not
`extract_text`, which no longer exists) returning a fixed
`ExtractedDocument(text=..., headings=[...])`, and assert the resulting
chunks reflect those headings (same style of assertion as the pipeline
test above).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_pipeline.py tests/test_tasks.py -v`
Expected: FAIL

**Step 2: Implement**

Wire `headings` through per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_pipeline.py tests/test_tasks.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/documents/pipeline.py backend/app/documents/tasks.py backend/tests/test_pipeline.py backend/tests/test_tasks.py
git commit -m "feat(documents): thread extracted heading structure through the chunking pipeline"
```

---

### Task 7: Full regression pass and live smoke test

**Files:** None new - verification only.

**Step 1: Full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q`
Expected: PASS (every test, not just the ones touched this feature -
watch specifically for anything in `test_chunks_router.py` or
`test_documents_router.py` that asserted on chunk *count* or *content*
for a fixture document, since token-based limits can shift exact chunk
counts from the old char-based ones - fix any such assertion to match the
new, correct behavior rather than forcing old numbers).

**Step 2: Rebuild containers**

```bash
docker compose up -d --build backend worker
```

(New dependencies - `tiktoken`, `reportlab` - need to be in the built
image; `reportlab` only needs to be present if it ends up in the base
`requirements.txt` rather than a test-only extra - confirm which before
this step.)

**Step 3: Live smoke test**

Upload a real markdown file with a few `##` headings through the running
app (Upload page), open it in Chunk Preview, and confirm the chunk
boundaries land at those headings rather than at arbitrary points -
same manual-verification spirit as this session's earlier live checks
(see project memory on this app's testing conventions - no automated
browser tool, live checks are how UI-facing behavior gets confirmed).

**Step 4: Commit** (only if Step 1 required fixes)

```bash
git add -A
git commit -m "test: fix chunk-count assertions for token-based split_document"
```
