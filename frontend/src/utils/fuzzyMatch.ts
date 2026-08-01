/**
 * Hand-rolled trigram (3-character n-gram) based fuzzy filename matcher - no
 * fuzzy-search library dependency (see `formatDateTime.ts` for the same
 * "hand-roll a small utility instead of adding a package" precedent this
 * codebase follows, per `.claude/context/design-principles.md`'s Icons
 * section). Used by the Upload page's filename search so a typo in the
 * query (e.g. "smoek") still finds the intended file ("smoke-test.txt")
 * instead of requiring an exact/substring match.
 */

/**
 * Breaks a lowercased string into its overlapping 3-character substrings
 * (trigrams) - e.g. "smoke" -> {"smo", "mok", "oke"}. This is the practical
 * stand-in for "matching by syllable-sized pieces" without needing real
 * linguistic syllable segmentation, which isn't reliably doable for the
 * mixed-language filenames already in this app (e.g.
 * "Геометрия._Киселев А.П._2004 -328с.pdf"). Strings shorter than 3
 * characters produce an empty set - too short to fuzzy-score meaningfully,
 * they still get a chance via the substring fast-path in
 * `fuzzyMatchesFilename` below.
 */
function trigrams(value: string): Set<string> {
  const normalized = value.toLowerCase()
  const grams = new Set<string>()
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    grams.add(normalized.slice(index, index + 3))
  }
  return grams
}

/**
 * Splits a filename into its word-like tokens (runs of letters/digits,
 * Unicode-aware), dropping punctuation/separators and the extension dot
 * along with them - e.g. "smoke-test.txt" -> ["smoke", "test", "txt"].
 */
function wordTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Sørensen-Dice coefficient between two trigram sets: `2 * |intersection| /
 * (|A| + |B|)` - a standard string-similarity measure (1 = identical
 * trigram sets, 0 = no shared trigrams). Two empty sets (both inputs
 * shorter than 3 characters) are treated as a perfect match rather than
 * dividing by zero.
 */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1
  }
  if (a.size === 0 || b.size === 0) {
    return 0
  }
  let intersectionSize = 0
  for (const gram of a) {
    if (b.has(gram)) {
      intersectionSize += 1
    }
  }
  return (2 * intersectionSize) / (a.size + b.size)
}

// Below this Dice score, two trigram sets are considered unrelated rather
// than "probably a typo of each other". Tuned empirically (see
// fuzzyMatch.test.ts): a single-character typo/transposition against a
// short filename token (e.g. "smoek" ~ "smoke") scores ~0.33, comfortably
// above this; clearly unrelated queries score 0 against real filenames in
// practice, well below it.
const FUZZY_MATCH_THRESHOLD = 0.3

/**
 * True if `query` is a fuzzy/typo-tolerant match for `filename`.
 *
 * An exact case-insensitive substring match always counts (the fast path) -
 * a real substring match should never be excluded just because the *whole*
 * filename's trigram similarity happens to be diluted by other words or an
 * extension.
 *
 * Otherwise, `filename` is split into its individual word tokens (see
 * `wordTokens`) and `query`'s trigram set is compared against EACH token's
 * trigram set separately, taking the best (highest) Dice score across them.
 * Comparing `query` against the *whole* multi-word filename directly (one
 * combined trigram set) would dilute a short query's similarity to just one
 * of its words - e.g. "smoek" against the full "smoke-test.txt" scores far
 * lower than against just the "smoke" token alone, since "test"/"txt"
 * contribute unrelated trigrams to the denominator without being what's
 * actually being searched for. Per-token comparison is also a closer match
 * for "matching by syllable-sized pieces": each token is a natural word-
 * sized chunk of the filename, the practical equivalent of a syllable here.
 */
export function fuzzyMatchesFilename(query: string, filename: string): boolean {
  if (query === '') {
    return true
  }

  const lowerFilename = filename.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (lowerFilename.includes(lowerQuery)) {
    return true
  }

  const queryGrams = trigrams(lowerQuery)
  const tokens = wordTokens(filename)
  if (tokens.length === 0) {
    return false
  }

  const bestScore = Math.max(...tokens.map((token) => diceCoefficient(queryGrams, trigrams(token))))
  return bestScore >= FUZZY_MATCH_THRESHOLD
}
