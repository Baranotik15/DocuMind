import { describe, expect, it } from 'vitest'

import { formatDateTime } from './formatDateTime'

describe('formatDateTime', () => {
  it('formats a local (no-offset) ISO timestamp as DD.MM.YYYY HH:mm', () => {
    // A date-time string with no timezone designator is parsed by the JS
    // `Date` constructor as local time (not UTC), so this input/output pair
    // holds regardless of which timezone the test runner itself is in - this
    // is the exact example from the request: "01.08.2026 18:57".
    expect(formatDateTime('2026-08-01T18:57:00')).toBe('01.08.2026 18:57')
  })

  it('pads single-digit day, month, hour, and minute with a leading zero', () => {
    expect(formatDateTime('2026-01-05T03:07:00')).toBe('05.01.2026 03:07')
  })
})
