import type { JSX } from 'react'

import { useEffect, useRef } from 'react'

import ForceGraph3D from '3d-force-graph'

import { apiClient } from '../api/client'
import type { ChunkGraphNode } from '../api/types'

// UMAP's raw output sits in a small numeric range (roughly -10..10) - scaled
// up so nodes actually spread out at 3d-force-graph's default camera/link
// distances, instead of rendering as one tight cluster.
const POSITION_SCALE = 40

/**
 * Deterministic per-document color: a golden-angle hue wheel keyed by the
 * order each documentId first appears in the node list (not the document's
 * own uuid, which has no natural ordering to derive a hue from). Same
 * "assign categorical colors by index" device as BAR_COLORS elsewhere in
 * this app, just generalized to however many documents actually exist
 * instead of a fixed-size palette.
 */
function buildDocumentColors(nodes: ChunkGraphNode[]): Map<string, string> {
  const colors = new Map<string, string>()
  for (const node of nodes) {
    if (!colors.has(node.documentId)) {
      const hue = (colors.size * 137.508) % 360
      colors.set(node.documentId, `hsl(${hue}, 70%, 60%)`)
    }
  }
  return colors
}

/**
 * Chunks within the same document are chained in reading order - chunk 1 to
 * chunk 2, chunk 2 to chunk 3, and so on - not connected to every other
 * chunk in the document (a complete subgraph got visually dense fast and
 * didn't read as "order", per explicit correction). Each link is colored to
 * match that document's node color. `position` (the chunk's real position
 * within its document, from the backend - not its index in this array) is
 * what determines the chain order.
 */
function buildSameDocumentLinks(nodes: ChunkGraphNode[], documentColors: Map<string, string>) {
  const nodesByDocument = new Map<string, ChunkGraphNode[]>()
  for (const node of nodes) {
    const documentNodes = nodesByDocument.get(node.documentId) ?? []
    documentNodes.push(node)
    nodesByDocument.set(node.documentId, documentNodes)
  }

  const links: { source: string; target: string; color: string }[] = []
  for (const [documentId, documentNodes] of nodesByDocument) {
    const color = documentColors.get(documentId) ?? '#3D6BFF'
    const orderedNodes = [...documentNodes].sort((a, b) => a.position - b.position)
    for (let i = 0; i < orderedNodes.length - 1; i++) {
      links.push({ source: orderedNodes[i].id, target: orderedNodes[i + 1].id, color })
    }
  }
  return links
}

/**
 * The 3D chunk-embedding map: each node is a chunk, positioned at its
 * backend-computed UMAP coordinates (see GET /internal/dashboard/chunk-graph)
 * so semantically-similar chunks land near each other - not a physics
 * simulation from scratch, the meaningful layout already comes from the
 * backend. Positions are pinned via `fx`/`fy`/`fz` (d3-force's "fixed
 * position" fields, which 3d-force-graph/three-forcegraph respect) so the
 * force engine doesn't fight the UMAP layout by re-scattering nodes with
 * generic charge/link forces. Nodes/links are colored per source document
 * (buildDocumentColors/buildSameDocumentLinks above) - "like Obsidian's
 * graph view", per explicit request. Orbit/pan/zoom navigation is
 * `3d-force-graph`'s own default behavior, not custom code here.
 *
 * `3d-force-graph` is an imperative, canvas/WebGL-based library (built on
 * Three.js) - not a React component - so it's mounted/torn down by hand in
 * an effect rather than rendered declaratively, the same shape as any
 * other "wrap an imperative widget" integration.
 */
export function ChunkGraphPanel(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const graph = new ForceGraph3D(container)
      .backgroundColor('rgba(0,0,0,0)')
      .width(container.clientWidth)
      .height(container.clientHeight)
      .nodeLabel('filename')
      .nodeRelSize(4)
      .nodeColor('color')
      .linkOpacity(0.45)
      .linkColor('color')
      .linkWidth(1.5)
      .showNavInfo(false)

    // The one-time `container.clientWidth`/`clientHeight` reads above are
    // just a reasonable first guess - this ResizeObserver is what actually
    // keeps the canvas matching this container's real size afterward. It's
    // not optional/defensive: this container's size comes from a CSS flex
    // layout (matching the Messages/Dislikes chart stack's height), which
    // can settle to its final size on a later frame than this effect runs
    // on, and can change again later without the *window* ever resizing -
    // a `window.resize`-only listener (what used to be here) misses
    // exactly that case, which is why the canvas kept drifting out of
    // sync with its own box. Per spec, ResizeObserver also fires once
    // immediately on `.observe()`, so this alone covers the initial-size
    // case too.
    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      graph.width(width).height(height)
    })
    resizeObserver.observe(container)

    let cancelled = false
    void apiClient.getChunkGraph().then((data) => {
      if (cancelled) {
        return
      }
      const documentColors = buildDocumentColors(data.nodes)
      const nodes = data.nodes.map((node) => ({
        id: node.id,
        documentId: node.documentId,
        filename: node.filename,
        color: documentColors.get(node.documentId) ?? '#3D6BFF',
        fx: node.x * POSITION_SCALE,
        fy: node.y * POSITION_SCALE,
        fz: node.z * POSITION_SCALE,
      }))
      const links = buildSameDocumentLinks(data.nodes, documentColors)
      graph.graphData({ nodes, links })
    })

    return () => {
      cancelled = true
      resizeObserver.disconnect()
      graph._destructor()
      container.replaceChildren()
    }
  }, [])

  // `position: 'relative'` is load-bearing, not decorative: three.js/
  // three-render-objects position the actual WebGL canvas (and any
  // overlay elements) with `position: absolute`, which anchors to the
  // nearest *positioned* ancestor - without one here, that anchor was some
  // unrelated ancestor further up the page (or the viewport itself),
  // which is why the rendered graph was showing up detached from this
  // card entirely instead of filling it. No minHeight here deliberately -
  // this should fill its parent Paper exactly (which itself is stretched
  // by the outer Group to match the Messages/Dislikes chart stack's
  // height precisely), not impose its own floor that could make it taller
  // than that stack.
  return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />
}
