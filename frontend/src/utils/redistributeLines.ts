/**
 * Pure line-redistribution math for the Chunk Preview page's boundary-drag
 * handle (see `ChunkPreviewPage.tsx`) - kept separate from the DOM/mouse-event
 * wiring, same "hand-roll a small, independently testable utility" precedent
 * as `fuzzyMatch.ts`/`formatDateTime.ts`.
 */

/**
 * Splits `text` into lines on `\n`, treating an empty string as zero lines
 * (not one) - `''.split('\n')` returns `['']`, a phantom blank line, which
 * would otherwise make an empty chunk look like it has one line to give/take.
 */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/**
 * Moves whole lines across the boundary between `upperText` and `lowerText`.
 * Positive `lineDelta` moves that many lines from the START of `lowerText`
 * to the END of `upperText` (dragging the boundary down); negative moves
 * from the END of `upperText` to the START of `lowerText` (dragging up);
 * `0` is a no-op. The requested count is always clamped to whatever's
 * actually available on the giving side, so this can never produce a
 * negative-length result or invent lines that don't exist.
 */
export function redistributeLines(upperText: string, lowerText: string, lineDelta: number): [string, string] {
  if (lineDelta === 0) {
    return [upperText, lowerText]
  }

  const upperLines = toLines(upperText)
  const lowerLines = toLines(lowerText)

  if (lineDelta > 0) {
    const moving = lowerLines.splice(0, Math.min(lineDelta, lowerLines.length))
    return [[...upperLines, ...moving].join('\n'), lowerLines.join('\n')]
  }

  const count = Math.min(-lineDelta, upperLines.length)
  const moving = upperLines.splice(upperLines.length - count, count)
  return [upperLines.join('\n'), [...moving, ...lowerLines].join('\n')]
}
