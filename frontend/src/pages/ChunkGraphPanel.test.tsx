import type { ChunkGraphNode } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { waitFor } from '@testing-library/react'

import { ChunkGraphPanel } from './ChunkGraphPanel'
import { renderWithProviders } from '../test-utils'

// jsdom has no WebGL, so the real 3d-force-graph/Three.js can't construct a
// renderer in tests - mock the whole module with a chainable stub that
// records calls, the same way this file would use the real (chainable)
// API, and assert on the wiring (fetch happened, graphData got the right
// node/link shape) rather than anything rendered.
const chainableMethods = [
  'backgroundColor',
  'width',
  'height',
  'nodeLabel',
  'nodeRelSize',
  'nodeColor',
  'linkOpacity',
  'linkColor',
  'linkWidth',
  'showNavInfo',
  'graphData',
] as const

let graphStub: Record<(typeof chainableMethods)[number] | '_destructor', ReturnType<typeof vi.fn>>

function createGraphStub() {
  const stub = {} as typeof graphStub
  for (const method of chainableMethods) {
    stub[method] = vi.fn(() => stub)
  }
  stub._destructor = vi.fn()
  return stub
}

vi.mock('3d-force-graph', () => ({
  default: vi.fn().mockImplementation(function ForceGraph3DMock() {
    return graphStub
  }),
}))

describe('ChunkGraphPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  const nodes: ChunkGraphNode[] = [
    { id: 'chunk-1', documentId: 'doc-1', filename: 'a.pdf', x: 0, y: 0, z: 0, position: 0 },
    { id: 'chunk-2', documentId: 'doc-1', filename: 'a.pdf', x: 1, y: 1, z: 1, position: 1 },
    { id: 'chunk-3', documentId: 'doc-2', filename: 'b.pdf', x: -1, y: -1, z: -1, position: 0 },
  ]

  beforeEach(() => {
    graphStub = createGraphStub()
    fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ nodes }) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the chunk graph and feeds it to the 3D graph as nodes + same-document links', async () => {
    renderWithProviders(<ChunkGraphPanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/internal/dashboard/chunk-graph', expect.anything())
    })

    await waitFor(() => {
      expect(graphStub.graphData).toHaveBeenCalled()
    })

    const [{ nodes: graphNodes, links: graphLinks }] = graphStub.graphData.mock.calls[0]

    expect(graphNodes).toHaveLength(3)
    expect(graphNodes.map((node: { id: string }) => node.id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])

    // doc-1 has 2 chunks -> exactly 1 link between them; doc-2 has only 1
    // chunk -> no link possible for it.
    expect(graphLinks).toHaveLength(1)
    expect(graphLinks[0]).toMatchObject({ source: 'chunk-1', target: 'chunk-2' })

    // Same document -> same node color; different document -> different color.
    const colorByNodeId = new Map(graphNodes.map((node: { id: string; color: string }) => [node.id, node.color]))
    expect(colorByNodeId.get('chunk-1')).toBe(colorByNodeId.get('chunk-2'))
    expect(colorByNodeId.get('chunk-1')).not.toBe(colorByNodeId.get('chunk-3'))
    expect(graphLinks[0].color).toBe(colorByNodeId.get('chunk-1'))
  })

  it('chains same-document chunks in position order (1-2, 2-3, ...) rather than connecting every pair', async () => {
    const threeChunkDocument: ChunkGraphNode[] = [
      // Deliberately out of position order in the array, and with
      // mismatched ids, to prove the chain follows `position` - not
      // array/insertion order and not id order.
      { id: 'z-chunk', documentId: 'doc-1', filename: 'a.pdf', x: 0, y: 0, z: 0, position: 2 },
      { id: 'a-chunk', documentId: 'doc-1', filename: 'a.pdf', x: 0, y: 0, z: 0, position: 0 },
      { id: 'm-chunk', documentId: 'doc-1', filename: 'a.pdf', x: 0, y: 0, z: 0, position: 1 },
    ]
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ nodes: threeChunkDocument }) } as Response),
    )

    renderWithProviders(<ChunkGraphPanel />)

    await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())
    const [{ links: graphLinks }] = graphStub.graphData.mock.calls[0]

    // 3 chunks in 1 document -> exactly 2 links (a chain), not 3 (which an
    // all-pairs/complete subgraph would produce).
    expect(graphLinks).toHaveLength(2)
    expect(graphLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'a-chunk', target: 'm-chunk' }),
        expect.objectContaining({ source: 'm-chunk', target: 'z-chunk' }),
      ]),
    )
  })

  it('fixes each node at its backend-provided position (scaled), rather than leaving it to physics', async () => {
    renderWithProviders(<ChunkGraphPanel />)

    await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())
    const [{ nodes: graphNodes }] = graphStub.graphData.mock.calls[0]

    const node2 = graphNodes.find((node: { id: string }) => node.id === 'chunk-2')
    expect(node2.fx).toBeCloseTo(node2.fy)
    expect(node2.fx).not.toBe(0)
  })

  it('cleans up the graph instance on unmount', async () => {
    const { unmount } = renderWithProviders(<ChunkGraphPanel />)
    await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

    unmount()

    expect(graphStub._destructor).toHaveBeenCalled()
  })

  it('resizes the graph to whatever ResizeObserver reports, not just the size read once at mount', async () => {
    // test-setup.ts's global ResizeObserver stub is a total no-op (nothing
    // else in the app needs its callback to actually fire) - this test
    // needs a controllable one, so it swaps `window.ResizeObserver` for
    // just this test with a fake that captures the callback and lets the
    // test invoke it manually with a fake contentRect. A direct assignment
    // (not `vi.stubGlobal`, which tries to redefine the property and fails
    // - test-setup.ts's own `Object.defineProperty` call left it
    // non-configurable) works because that same call left it `writable`.
    const originalResizeObserver = window.ResizeObserver
    let observedCallback: ResizeObserverCallback | null = null
    const observe = vi.fn()
    const disconnect = vi.fn()
    window.ResizeObserver = vi.fn().mockImplementation(function ResizeObserverMock(callback: ResizeObserverCallback) {
      observedCallback = callback
      return { observe, disconnect, unobserve: vi.fn() }
    }) as unknown as typeof ResizeObserver

    const { unmount } = renderWithProviders(<ChunkGraphPanel />)
    await waitFor(() => expect(observe).toHaveBeenCalled())

    observedCallback?.(
      [{ contentRect: { width: 555, height: 321 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    )

    expect(graphStub.width).toHaveBeenCalledWith(555)
    expect(graphStub.height).toHaveBeenCalledWith(321)

    unmount()
    expect(disconnect).toHaveBeenCalled()

    window.ResizeObserver = originalResizeObserver
  })
})
