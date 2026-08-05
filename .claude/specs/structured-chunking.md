# Structured Chunking

## Goal
Replace the current paragraph-boundary-then-fixed-character chunker with a
signal-priority chunker that splits documents at their actual structural
boundaries (headings) wherever that structure is recoverable, only falling
back to today's paragraph/sentence/fixed-size behavior when it isn't - so
retrieval returns whole topical sections instead of arbitrary 1500-character
slices that can start or end mid-thought.

## Requirements

- Chunking tries the following signals in order, per document, and uses the
  first one that finds at least one boundary in that document (a document
  never mixes two "boundary" tiers - once a tier fires, lower tiers don't
  also run on the same document):
  1. Markdown heading syntax (`#`, `##`, `###`, ...) - `.md` uploads only,
     since the extractor doesn't invent syntax for formats that don't have
     it.
  2. Native document heading styles - DOCX paragraph styles ("Heading 1",
     "Heading 2", ...) and PDF's embedded outline/bookmarks, when present.
  3. Numbered/lettered pseudo-headings detected in the extracted text (e.g.
     "1. Introduction", "2.1 Overview", "Section 3:").
  4. PDF font-size/weight jumps (text rendered notably larger and/or bolder
     than the page's dominant body-text size) - PDF only, and only when
     tier 2's embedded outline isn't present for that file.
  5. Paragraph (blank-line) boundaries - today's primary signal, becomes
     the fallback once no heading-level signal (tiers 1-4) found anything.
- Tiers 1-4 decide where a document splits into top-level *sections*.
  Tiers 5-7 (paragraph, sentence, fixed-size) are unchanged in role: they
  decide how to further split a single section - or, when no tier 1-4
  signal fired at all, the whole document - once it's still bigger than
  the configured max chunk size. A section under the max size stays one
  chunk, however small.
- The configured chunk size limit moves from a character count to a token
  count, measured with the same tokenizer family the embedding model
  actually uses - today's `max_chars` default (1500) is a stand-in for
  this and gets replaced, not kept as a second parallel limit.
- Every chunk produced, regardless of which tier(s) fired, still
  concatenates back to the exact original extracted text - the existing
  exact-reconstruction guarantee (`"".join(chunks) == text`) is a hard
  carry-over requirement, not something this change is allowed to loosen.
  It's relied on elsewhere (e.g. ChunkPreviewPage's whole-document search).
- Applies to both chunking entry points that exist today: the automatic
  path (initial upload, and Save without manual boundaries) and manual
  chunk-boundary Save is unaffected (it already bypasses the algorithmic
  splitter entirely and stays that way).
- `.txt` uploads have no structural signal available at any tier above
  paragraph - they fall straight through tiers 1-4 to paragraph/sentence/
  fixed-size, same as an unstructured document in any other format would.

## Acceptance Criteria
- [ ] A Markdown document with `#`/`##` headings is split at those heading
      boundaries (tier 1), not at arbitrary paragraph/character counts.
- [ ] A DOCX document using Word's built-in Heading styles is split at
      those heading boundaries (tier 2) without needing tier 1's markdown
      syntax.
- [ ] A PDF with an embedded outline/bookmarks is split at that outline's
      structure (tier 2).
- [ ] A DOCX or PDF with no native heading styles/outline, but with visible
      numbered section headers in the text ("1. Introduction", "2.1 ..."),
      is split at those (tier 3).
- [ ] A PDF with none of the above, but a clear larger/bolder font used for
      section titles, is split at those font-size/weight jumps (tier 4).
- [ ] A document with no structural signal at any tier (plain `.txt`, or a
      PDF/DOCX with none of tiers 1-4 present) falls back to today's
      paragraph -> sentence -> fixed-size behavior, now measured in tokens
      instead of characters.
- [ ] Any single section (or the whole document, in the no-structure case)
      that's still over the configured token limit is further split by
      paragraph, then sentence, then a hard token-count cut - same
      fallback order as today, just token-measured.
- [ ] For every document processed, `"".join(chunks)` still equals the
      exact text `extract_text` produced for it.
- [ ] Manual-boundary Save (`manualBoundaries: true`) behavior is
      unchanged - this feature only touches the automatic splitter.

## Non-Goals
- Semantic/embedding-based splitting (cutting where sentence-to-sentence
  embedding similarity drops) - not part of this pass.
- OCR or any handling for scanned/image-only PDFs with no text layer -
  out of scope, as already established for this project.
- Special handling for tables or lists so they're never split mid-structure
  - a real concern, but not one this pass commits to solving.
- Changing anything about the manual chunk-boundary editing/resize feature
  itself (`.claude/specs/manual-chunk-boundaries.md`) - only the automatic
  splitter it falls back to when boundaries weren't manually touched.
- A per-file-extension user-facing setting/toggle to pick a chunking
  strategy - the tier order is the same fixed chain for every upload,
  chosen automatically per document based on what signal is actually
  present in it.

## Open Questions
- Minimum section size: if two headings land very close together (e.g. a
  one-line section between two H2s), should tiny sections be merged
  forward into a neighbor, or is a very small chunk acceptable as-is?
  Leaning toward "acceptable as-is" (more precise retrieval, no arbitrary
  merge-threshold to tune) unless real documents show this is a problem in
  practice.
- Should a chunk record which tier actually produced it (e.g. surfaced in
  the chunk-graph or as dashboard-event detail), for later debugging of
  which documents fall back to fixed-size? Not required for this pass, but
  cheap to add if useful.
