import { describe, expect, it } from 'vitest'

import { CHUNK_BOUNDARY_MARKER } from './chunkBoundaryMarker'

describe('CHUNK_BOUNDARY_MARKER', () => {
  it('is a non-empty, human-readable label', () => {
    expect(CHUNK_BOUNDARY_MARKER.length).toBeGreaterThan(0)
  })
})
