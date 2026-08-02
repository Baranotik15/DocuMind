import { describe, expect, it } from 'vitest'

import { redistributeLines } from './redistributeLines'

describe('redistributeLines', () => {
  it('moves lines down: from the start of the lower text to the end of the upper text', () => {
    const [upper, lower] = redistributeLines('a\nb', 'c\nd\ne', 2)
    expect(upper).toBe('a\nb\nc\nd')
    expect(lower).toBe('e')
  })

  it('moves lines up: from the end of the upper text to the start of the lower text', () => {
    const [upper, lower] = redistributeLines('a\nb\nc', 'd\ne', -2)
    expect(upper).toBe('a')
    expect(lower).toBe('b\nc\nd\ne')
  })

  it('a zero delta is a no-op', () => {
    expect(redistributeLines('a\nb', 'c\nd', 0)).toEqual(['a\nb', 'c\nd'])
  })

  it('clamps a downward move to however many lines the lower side actually has', () => {
    const [upper, lower] = redistributeLines('a', 'b', 10)
    expect(upper).toBe('a\nb')
    expect(lower).toBe('')
  })

  it('clamps an upward move to however many lines the upper side actually has', () => {
    const [upper, lower] = redistributeLines('a', 'b', -10)
    expect(upper).toBe('')
    expect(lower).toBe('a\nb')
  })

  it('moving lines into an already-empty lower side does not introduce a phantom blank line', () => {
    const [upper, lower] = redistributeLines('a\nb', '', 1)
    expect(upper).toBe('a\nb')
    expect(lower).toBe('')
  })

  it('moving lines into an already-empty upper side does not introduce a phantom blank line', () => {
    const [upper, lower] = redistributeLines('', 'a\nb', -1)
    expect(upper).toBe('')
    expect(lower).toBe('a\nb')
  })

  it('moving from an already-empty giving side is a no-op beyond clamping to zero', () => {
    // Positive delta gives from lowerText - empty lower has nothing to give.
    expect(redistributeLines('a\nb', '', 1)).toEqual(['a\nb', ''])
    // Negative delta gives from upperText - empty upper has nothing to give.
    expect(redistributeLines('', 'a\nb', -1)).toEqual(['', 'a\nb'])
  })

  it('conserves total line count across a move', () => {
    const upperBefore = 'a\nb\nc'
    const lowerBefore = 'd\ne'
    const totalBefore = 5
    for (const delta of [-2, -1, 0, 1, 2]) {
      const [upper, lower] = redistributeLines(upperBefore, lowerBefore, delta)
      const total = toLineCount(upper) + toLineCount(lower)
      expect(total).toBe(totalBefore)
    }
  })
})

function toLineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}
