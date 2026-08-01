import { describe, expect, it } from 'vitest'

import { fuzzyMatchesFilename } from './fuzzyMatch'

describe('fuzzyMatchesFilename', () => {
  it('matches an exact (case-insensitive) filename', () => {
    expect(fuzzyMatchesFilename('smoke-test.txt', 'smoke-test.txt')).toBe(true)
    expect(fuzzyMatchesFilename('SMOKE-TEST.TXT', 'smoke-test.txt')).toBe(true)
  })

  it('matches a plain (case-insensitive) substring of the filename', () => {
    expect(fuzzyMatchesFilename('smoke', 'smoke-test.txt')).toBe(true)
    expect(fuzzyMatchesFilename('SMOKE', 'smoke-test.txt')).toBe(true)
    expect(fuzzyMatchesFilename('.txt', 'smoke-test.txt')).toBe(true)
  })

  it('matches a query with a single-character typo against the intended filename', () => {
    // "smoek" is "smoke" with two letters transposed.
    expect(fuzzyMatchesFilename('smoek', 'smoke-test.txt')).toBe(true)
    expect(fuzzyMatchesFilename('architcture', 'architecture-guide.pdf')).toBe(true)
    expect(fuzzyMatchesFilename('onboaridng', 'onboarding-notes.docx')).toBe(true)
  })

  it('does not match a clearly unrelated query (the threshold is not so loose it matches everything)', () => {
    expect(fuzzyMatchesFilename('banana', 'smoke-test.txt')).toBe(false)
    expect(fuzzyMatchesFilename('xyz123', 'architecture-guide.pdf')).toBe(false)
    expect(fuzzyMatchesFilename('quarterly-report', 'onboarding-notes.docx')).toBe(false)
  })

  it('treats an empty query as matching everything', () => {
    expect(fuzzyMatchesFilename('', 'smoke-test.txt')).toBe(true)
  })

  it('does not crash on filenames with no letter/digit tokens', () => {
    expect(fuzzyMatchesFilename('smoke', '---...---')).toBe(false)
  })
})
