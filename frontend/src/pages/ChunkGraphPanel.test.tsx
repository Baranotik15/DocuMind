import type { JSX } from 'react'

import type { Chunk, ChunkGraphNode } from '../api/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MantineProvider } from '@mantine/core'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { ChunkGraphPanel } from './ChunkGraphPanel'
import { renderWithProviders, screen } from '../test-utils'

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
  'enableNodeDrag',
  'onNodeClick',
  'graphData',
] as const

let graphStub: Record<(typeof chainableMethods)[number] | '_destructor' | 'controls' | 'camera' | 'cameraPosition', ReturnType<typeof vi.fn>>

function createGraphStub() {
  const stub = {} as typeof graphStub
  for (const method of chainableMethods) {
    stub[method] = vi.fn(() => stub)
  }
  stub._destructor = vi.fn()
  // Not chainable (unlike the methods above) - real 3d-force-graph returns
  // the underlying OrbitControls instance, not the graph itself, so this
  // stub returns a bare object with just the members ChunkGraphPanel
  // actually touches (mouseButtons/panSpeed, plus target.set/update for the
  // centroid re-pivot) instead of `stub`.
  stub.controls = vi.fn(() => ({ mouseButtons: {}, target: { set: vi.fn() }, update: vi.fn() }))
  // Also not chainable - real 3d-force-graph returns the actual
  // THREE.PerspectiveCamera (camera()) and a plain {x,y,z} (cameraPosition(),
  // called here with no args as a getter) rather than the graph itself.
  // A fixed fov/position is enough for the zoom-to-fit math to run without
  // throwing - this file doesn't assert on the exact camera framing.
  stub.camera = vi.fn(() => ({ fov: 50 }))
  stub.cameraPosition = vi.fn(() => ({ x: 0, y: 0, z: 100 }))
  return stub
}

vi.mock('3d-force-graph', () => ({
  default: vi.fn().mockImplementation(function ForceGraph3DMock() {
    return graphStub
  }),
}))

/** Renders a fake JSON Response the same way every other page's fetch-stubbing tests do. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Bare display of the current MemoryRouter location, so a test can assert
 * on where "Open in document" actually navigated to without a real matched
 * Route for the target page - same technique ChunkPreviewPage.test.tsx uses
 * (a sentinel placeholder on the "other" route), just showing the location
 * itself instead of a fixed placeholder string, since this test cares about
 * the exact path + query string produced. */
function LocationProbe(): JSX.Element {
  const location = useLocation()
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>
}

function renderChunkGraphPanelWithLocationProbe(): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={['/dashboard']}>
        <ChunkGraphPanel />
        <LocationProbe />
      </MemoryRouter>
    </MantineProvider>,
  )
}

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

    // Cast directly at the call site (rather than relying on the `let`'s
    // own declared type) - TypeScript's control-flow analysis otherwise
    // narrows `observedCallback` down to exactly `null` here (and therefore
    // this whole optional call to `never`), since the only assignment it
    // can see is the literal `= null` initializer; the real reassignment
    // happens inside the ResizeObserverMock closure above, which CFA
    // doesn't account for.
    ;(observedCallback as ResizeObserverCallback | null)?.(
      [{ contentRect: { width: 555, height: 321 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    )

    expect(graphStub.width).toHaveBeenCalledWith(555)
    expect(graphStub.height).toHaveBeenCalledWith(321)

    unmount()
    expect(disconnect).toHaveBeenCalled()

    window.ResizeObserver = originalResizeObserver
  })

  describe('Node interaction', () => {
    it('disables node dragging - the layout is semantic (backend UMAP positions), not something an operator should be able to fight', async () => {
      renderWithProviders(<ChunkGraphPanel />)
      await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

      expect(graphStub.enableNodeDrag).toHaveBeenCalledWith(false)
    })

    it('labels each node with its filename and 1-based chunk number (position is 0-indexed backend-side)', async () => {
      renderWithProviders(<ChunkGraphPanel />)
      await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

      const [labelAccessor] = graphStub.nodeLabel.mock.calls[0]
      expect(labelAccessor({ filename: 'a.pdf', position: 0 })).toBe('a.pdf — chunk 1')
      expect(labelAccessor({ filename: 'a.pdf', position: 1 })).toBe('a.pdf — chunk 2')
    })

    function stubGraphAndChunksFetch(chunksByDocument: Record<string, Chunk[]>): void {
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/internal/dashboard/chunk-graph')) {
          return Promise.resolve(jsonResponse({ nodes }))
        }
        for (const [documentId, documentChunks] of Object.entries(chunksByDocument)) {
          if (url.endsWith(`/internal/documents/${documentId}/chunks`)) {
            return Promise.resolve(jsonResponse(documentChunks))
          }
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    }

    it('opens a modal with the clicked chunk\'s filename/number and its live (edited) text on click', async () => {
      stubGraphAndChunksFetch({
        'doc-1': [
          { id: 'chunk-1', documentId: 'doc-1', originalContent: 'Original text.', editedContent: 'Edited chunk text.', isDirty: true },
          { id: 'chunk-2', documentId: 'doc-1', originalContent: 'Second.', editedContent: 'Second edited.', isDirty: false },
        ],
      })

      renderWithProviders(<ChunkGraphPanel />)
      await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

      const [clickHandler] = graphStub.onNodeClick.mock.calls[0]
      clickHandler({ id: 'chunk-1', documentId: 'doc-1', filename: 'a.pdf', position: 0 })

      expect(await screen.findByText('a.pdf — chunk 1')).toBeInTheDocument()
      expect(await screen.findByText('Edited chunk text.')).toBeInTheDocument()
      // originalContent is the pre-edit snapshot - never what's shown here.
      expect(screen.queryByText('Original text.')).not.toBeInTheDocument()
    })

    it('shows a plain error state if the clicked chunk is missing from its document\'s chunk list', async () => {
      stubGraphAndChunksFetch({
        // doc-1's chunk list no longer contains 'chunk-1' - e.g. deleted/
        // merged since the graph was generated.
        'doc-1': [{ id: 'chunk-2', documentId: 'doc-1', originalContent: 'x', editedContent: 'x', isDirty: false }],
      })

      renderWithProviders(<ChunkGraphPanel />)
      await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

      const [clickHandler] = graphStub.onNodeClick.mock.calls[0]
      clickHandler({ id: 'chunk-1', documentId: 'doc-1', filename: 'a.pdf', position: 0 })

      expect(await screen.findByText(/Could not find this chunk/)).toBeInTheDocument()
    })

    it('shows a plain error state if fetching the chunk list itself fails', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/internal/dashboard/chunk-graph')) {
          return Promise.resolve(jsonResponse({ nodes }))
        }
        return Promise.resolve(jsonResponse({ detail: 'boom' }, 500))
      })

      renderWithProviders(<ChunkGraphPanel />)
      await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

      const [clickHandler] = graphStub.onNodeClick.mock.calls[0]
      clickHandler({ id: 'chunk-1', documentId: 'doc-1', filename: 'a.pdf', position: 0 })

      expect(await screen.findByText(/Failed to load this chunk/)).toBeInTheDocument()
    })

    it('caches a document\'s chunk list across clicks on multiple chunks from that same document', async () => {
      stubGraphAndChunksFetch({
        'doc-1': [
          { id: 'chunk-1', documentId: 'doc-1', originalContent: 'x', editedContent: 'First.', isDirty: false },
          { id: 'chunk-2', documentId: 'doc-1', originalContent: 'x', editedContent: 'Second.', isDirty: false },
        ],
      })

      renderWithProviders(<ChunkGraphPanel />)
      await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

      const [clickHandler] = graphStub.onNodeClick.mock.calls[0]
      clickHandler({ id: 'chunk-1', documentId: 'doc-1', filename: 'a.pdf', position: 0 })
      expect(await screen.findByText('First.')).toBeInTheDocument()

      clickHandler({ id: 'chunk-2', documentId: 'doc-1', filename: 'a.pdf', position: 1 })
      expect(await screen.findByText('Second.')).toBeInTheDocument()

      const chunkListFetches = (fetchMock.mock.calls as unknown[][]).filter((call) => String(call[0]).endsWith('/internal/documents/doc-1/chunks'))
      expect(chunkListFetches).toHaveLength(1)
    })

    it('navigates to the chunk editor at the exact clicked chunk via "Open in document"', async () => {
      stubGraphAndChunksFetch({
        'doc-1': [{ id: 'chunk-1', documentId: 'doc-1', originalContent: 'x', editedContent: 'Edited chunk text.', isDirty: false }],
      })

      renderChunkGraphPanelWithLocationProbe()
      await waitFor(() => expect(graphStub.graphData).toHaveBeenCalled())

      const [clickHandler] = graphStub.onNodeClick.mock.calls[0]
      clickHandler({ id: 'chunk-1', documentId: 'doc-1', filename: 'a.pdf', position: 0 })
      await screen.findByText('Edited chunk text.')

      fireEvent.click(screen.getByRole('button', { name: 'Open in document' }))

      expect(await screen.findByTestId('location-probe')).toHaveTextContent('/upload/doc-1/chunks?chunk=chunk-1')
    })
  })
})
