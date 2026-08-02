/**
 * The Chunk Preview page's boundary-marker word (see `ChunkPreviewPage.tsx`
 * and `.claude/specs/manual-chunk-boundaries.md`). Displayed as a persistent
 * label on the `BoundaryHandle` between every pair of adjacent chunks - it
 * never travels over the wire or gets persisted, it exists purely to make
 * the boundary visually explicit next to the drag handle that resizes it.
 */
export const CHUNK_BOUNDARY_MARKER = '[--- chunk boundary ---]'
