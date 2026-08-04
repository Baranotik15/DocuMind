import type { JSX } from 'react'
import type { PerspectiveCamera } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { useEffect, useRef, useState } from 'react'

import { Alert, Box, Button, Group, Loader, Modal, Stack, Text, Title } from '@mantine/core'
import ForceGraph3D from '3d-force-graph'
import { useNavigate } from 'react-router-dom'
import { BackSide, Group as ThreeGroup, Mesh, MeshBasicMaterial, MOUSE, SphereGeometry, Vector3 } from 'three'

// Side-effect only - no JSX here references `classes` anymore (the last
// local class, chunkTextScrollArea, moved to the app-wide scrollbar rule in
// global.css), but this file still needs to stay imported so its
// `:global(.float-tooltip-kap)` rule (styling a div 3d-force-graph's own
// float-tooltip dependency injects directly into the DOM) ships in the
// bundle.
import './ChunkGraphPanel.module.css'
import { apiClient } from '../api/client'
import type { Chunk, ChunkGraphNode } from '../api/types'

// UMAP's raw output sits in a small numeric range (roughly -10..10) - scaled
// up so nodes actually spread out at 3d-force-graph's default camera/link
// distances, instead of rendering as one tight cluster.
const POSITION_SCALE = 40

// How fast a left-button drag pans the camera across the graph - OrbitControls'
// own default (1) as a named constant, not a magic number at the call site,
// so it's a single obvious place to retune if panning feels too slow/fast.
const GRAPH_PAN_SPEED = 1

// Idle auto-rotate speed (OrbitControls' own default is 2, a full turn
// every ~30s) - kept slow/subtle since this is just an idle flourish, not a
// primary way to view the graph (real rotation is still the RIGHT-drag
// above). Paused while the pointer is over the panel (see the mouseenter/
// mouseleave listeners below) so it doesn't fight an operator's own
// interaction.
const GRAPH_AUTO_ROTATE_SPEED = 0.5

// Multiplies the initial fit-to-cluster camera distance (see
// computeMaxPairwiseDistance/the cameraPosition call below) - 1.0 would put
// the two farthest-apart nodes' own CENTERS exactly on the view frustum's
// edge, but each node also has its own rendered radius (nodeRelSize), so a
// perfectly tight fit would still visibly clip the outermost spheres. A
// little headroom keeps every node's whole sphere on-screen instead of just
// its center point.
const GRAPH_INITIAL_ZOOM_PADDING = 1.15

// Radius of every node's sphere (three.js scene units, same scale as
// POSITION_SCALE) - previously handed to `nodeRelSize`, now applied
// directly since nodes render via a custom `nodeThreeObject` (see below),
// not 3d-force-graph's default sphere.
const GRAPH_NODE_RADIUS = 4

// One shared geometry reused across every node's Mesh (see
// `nodeThreeObject` below) - all node spheres are the same size, so there's
// no reason to allocate a separate SphereGeometry per node.
const nodeSphereGeometry = new SphereGeometry(GRAPH_NODE_RADIUS, 16, 16)

// Outline effect: a second, slightly larger sphere rendered BEHIND each
// node using its BACK faces only (`side: BackSide` in nodeThreeObject
// below) - the classic "inverted hull" outline technique, not a flat
// stroke/border (spheres have no meaningful 2D "edge" to stroke, and an
// EdgesGeometry outline on a low-poly sphere would show its triangulation,
// not a clean silhouette). Slightly bigger than the node itself so the
// back faces peek out from behind it as a rim, from any viewing angle -
// per explicit request, nodes were hard to tell apart where they overlap
// without some kind of contour.
const GRAPH_NODE_OUTLINE_SCALE = 1.15
const nodeOutlineGeometry = new SphereGeometry(GRAPH_NODE_RADIUS * GRAPH_NODE_OUTLINE_SCALE, 16, 16)
// Matching the page's own `voidBg` (theme.ts) was the first attempt here,
// on the theory that the outline should read as a "gap" - in practice it
// disappeared entirely against that same background (only visible as a
// sliver where two nodes actually overlapped), per explicit correction.
// A step lighter than both `voidBg` (#101B36) and `--doc-surface`
// (#131B2E) - still a muted slate, not a bright accent, but genuinely
// distinguishable as a rim around every node, not just where they overlap.
const nodeOutlineColor = '#2A3550'

// Node/link opacity and material: 3d-force-graph's DEFAULT node spheres and
// linkWidth>0 links both render with `MeshLambertMaterial`, which shades by
// scene lighting - even a fully saturated color reads as muted/dull
// wherever a surface isn't facing the light directly. Per explicit
// "make it more neon" request, both use a plain `MeshBasicMaterial`
// instead (below, via `nodeThreeObject`/`linkMaterial`) - unlit, so the
// raw HSL color (see buildDocumentColors) renders at full, flat intensity
// with no shading to mute it, which is what actually reads as "neon"
// against this panel's dark background.
const GRAPH_LINK_OPACITY = 0.75

/**
 * The exact shape of the objects this component hands to 3d-force-graph's
 * `graphData` call below - `id`/`documentId`/`filename`/`position` come
 * straight from the backend's `ChunkGraphNode`, plus the `color` and fixed
 * `fx`/`fy`/`fz` coordinates this component derives itself. NOT the same
 * type as `ChunkGraphNode`. 3d-force-graph's own TypeScript defs type every
 * node handed to callbacks (`nodeLabel`, `onNodeClick`, ...) as a near-
 * untyped `object` (see `NodeObject` in three-forcegraph's own .d.ts, which
 * the library's public types re-export) - there's no way to parametrize the
 * `ForceGraph3D` constructor itself with a custom node type (its default
 * export is a plain `const`, not a generic factory), so those callbacks
 * below cast back to this shape to read our own custom fields. That's safe
 * specifically because these are exactly the objects this component itself
 * constructed and handed to the library a few lines earlier (see the
 * `nodes` array built in the `getChunkGraph().then(...)` below) - nothing
 * the library invents on its own.
 */
interface GraphNodeDatum {
  id: string
  documentId: string
  filename: string
  color: string
  fx: number
  fy: number
  fz: number
  /** This chunk's own 0-indexed position within its document (reading order) - see ChunkGraphNode.position. */
  position: number
}

/**
 * Shared by the hover label AND the click modal's title, so both read
 * identically: "<filename> — chunk <1-based number>". `position` is the
 * chunk's 0-indexed position within its own document (assigned via
 * `enumerate()` when its row is first inserted - see backend/app/
 * pipeline.py's `run_pipeline`), so `+ 1` here matches the exact same
 * 1-based "Chunk N" numbering ChunkPreviewPage shows for this same chunk
 * (see its own `chunkNumberByChunkId`, similarly `index + 1` over the same
 * backend-ordered chunk list).
 */
function chunkNodeLabel(node: GraphNodeDatum): string {
  return `${node.filename} — chunk ${node.position + 1}`
}

/**
 * Chunk text often comes from source documents hard-wrapped at ~80 columns
 * (a single `\n` mid-paragraph, not a real paragraph break) - rendered
 * as-is, that makes the text look like it's ignoring the modal's actual
 * width instead of reflowing to fill it. Collapses each single newline
 * (one NOT immediately followed by another) into a space, so prose
 * reflows to the container's real width, while a genuine blank-line
 * paragraph break (`\n\n`) is left alone - paired with `white-space:
 * pre-line` below, which still renders that surviving break as a blank
 * line.
 */
function reflowChunkText(text: string): string {
  return text.replace(/([^\n])\n(?!\n)/g, '$1 ')
}

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
      // 85%/68% (was 70%/60%) - per explicit request, the original values
      // read as too pale/dull against this panel's dark background.
      colors.set(node.documentId, `hsl(${hue}, 85%, 68%)`)
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
 * The average of every node's (already `POSITION_SCALE`d) `fx`/`fy`/`fz` -
 * i.e. roughly the middle of wherever the actual cluster of chunks ended up,
 * not the coordinate origin. OrbitControls' own default orbit pivot
 * (`controls.target`) is hardcoded to (0, 0, 0), which only happens to
 * coincide with the cluster's real center by coincidence - UMAP's output
 * isn't guaranteed to center itself there. Orbiting around the wrong pivot
 * makes the whole cluster visibly swing across the screen during a drag,
 * which reads as "the nodes are moving" even though their world positions
 * never change - reassigning `controls.target` to this centroid (see the
 * call site below) is what actually fixes that, not anything about the
 * nodes themselves.
 */
function computeCentroid(nodes: GraphNodeDatum[]): { x: number; y: number; z: number } {
  const sum = nodes.reduce(
    (acc, node) => ({ x: acc.x + node.fx, y: acc.y + node.fy, z: acc.z + node.fz }),
    { x: 0, y: 0, z: 0 },
  )
  return { x: sum.x / nodes.length, y: sum.y / nodes.length, z: sum.z / nodes.length }
}

/**
 * The distance between the two nodes that are farthest apart from EACH
 * OTHER (not from the centroid, and not the bounding box's own corner-to-
 * corner diagonal, which no real node necessarily sits on) - the real
 * "diameter" of however spread out this particular cluster actually is.
 * O(n^2) all-pairs comparison - fine at this app's per-document chunk
 * counts; not worth a bounding-box approximation for the corpus sizes this
 * graph is ever built from. Used below to size the initial camera distance
 * so the cluster fills the view without clipping either of those two
 * farthest-apart nodes.
 */
function computeMaxPairwiseDistance(nodes: GraphNodeDatum[]): number {
  let maxDistanceSquared = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].fx - nodes[j].fx
      const dy = nodes[i].fy - nodes[j].fy
      const dz = nodes[i].fz - nodes[j].fz
      const distanceSquared = dx * dx + dy * dy + dz * dz
      if (distanceSquared > maxDistanceSquared) {
        maxDistanceSquared = distanceSquared
      }
    }
  }
  return Math.sqrt(maxDistanceSquared)
}

/**
 * The 3D chunk-embedding map: each node is a chunk, positioned at its
 * backend-computed UMAP coordinates (see GET /internal/dashboard/chunk-graph)
 * so semantically-similar chunks land near each other - not a physics
 * simulation from scratch, the meaningful layout already comes from the
 * backend. Positions are pinned via `fx`/`fy`/`fz` (d3-force's "fixed
 * position" fields, which 3d-force-graph/three-forcegraph respect) so the
 * force engine doesn't fight the UMAP layout by re-scattering nodes with
 * generic charge/link forces - and, for the same reason, dragging a node is
 * disabled outright (`enableNodeDrag(false)` below): letting an operator
 * drag one around would let them visually contradict the semantic-
 * similarity layout, which would be meaningless, not just discouraged.
 * Nodes/links are colored per source document (buildDocumentColors/
 * buildSameDocumentLinks above) - "like Obsidian's graph view", per explicit
 * request. Orbit/pan/zoom navigation is `3d-force-graph`'s own default
 * behavior, not custom code here.
 *
 * `3d-force-graph` is an imperative, canvas/WebGL-based library (built on
 * Three.js) - not a React component - so it's mounted/torn down by hand in
 * an effect rather than rendered declaratively, the same shape as any
 * other "wrap an imperative widget" integration. The one bit of ordinary
 * React-rendered JSX in this component is the click-to-preview Modal below
 * (see onNodeClick in the effect) - everything else stays exactly that
 * imperative "mount a 3rd-party widget in a ref" shape.
 */
export function ChunkGraphPanel(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // True until the one-shot getChunkGraph() fetch below resolves - shows a
  // spinner over the (otherwise blank) canvas area while it's in flight,
  // per explicit request, the same treatment DashboardPage's own stat
  // charts got for their own first load.
  const [isGraphDataLoading, setIsGraphDataLoading] = useState(true)

  // The clicked node (if any) driving the modal below - null means the
  // modal is closed. Set synchronously by onNodeClick (see the effect
  // below); the chunk's actual TEXT is fetched separately (chunkText/
  // chunkTextError/chunkTextLoading) since the graph endpoint this
  // component already fetches from only carries positions, not chunk
  // bodies - there's no single-chunk-by-id endpoint, so getting the text
  // means reusing apiClient.getChunks(documentId) and finding this one
  // chunk's entry in it.
  const [selectedNode, setSelectedNode] = useState<GraphNodeDatum | null>(null)
  const [chunkText, setChunkText] = useState<string | null>(null)
  const [chunkTextError, setChunkTextError] = useState<string | null>(null)
  const [chunkTextLoading, setChunkTextLoading] = useState(false)
  // Caches apiClient.getChunks(documentId) results per document, so
  // clicking multiple chunks from the SAME document (a common case - a
  // document's own chunks tend to cluster together in the graph) doesn't
  // refetch that whole document's chunk list again on every click. Not
  // invalidated on a timer/event - this graph is only ever open alongside a
  // one-shot fetch of its own (see getChunkGraph below), so a document's
  // chunk list can't meaningfully change out from under an open session.
  const chunksCacheRef = useRef<Map<string, Chunk[]>>(new Map())
  // Guards an in-flight chunk-text fetch from an earlier click against
  // clobbering state after the operator has already clicked a DIFFERENT
  // node before that first fetch resolved - same "cancelled"-style guard as
  // the graph-data fetch below, just keyed by which node's click actually
  // asked for this particular fetch.
  const latestClickedNodeIdRef = useRef<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    // controlType: 'orbit' (THREE.OrbitControls), not the library's own
    // default 'trackball' (THREE.TrackballControls) - trackball allows
    // free rotation around ANY axis (including roll), which reads as the
    // whole scene/nodes tumbling around; orbit clamps to a fixed up-vector
    // and always orbits the camera around one fixed target point, which is
    // what actually matches "the nodes are the fixed center, the screen/
    // camera moves around them" - per explicit correction, this is a real
    // difference in feel, not just a rewording of the same behavior.
    // `controlType` is constructor-only (see 3d-force-graph's own
    // ConfigOptions type) - it can't be changed via a chainable call after
    // the fact.
    const graph = new ForceGraph3D(container, { controlType: 'orbit' })
      .backgroundColor('rgba(0,0,0,0)')
      .width(container.clientWidth)
      .height(container.clientHeight)
      .nodeLabel((node) => chunkNodeLabel(node as unknown as GraphNodeDatum))
      // Flat, unlit spheres (see GRAPH_NODE_RADIUS/GRAPH_LINK_OPACITY's own
      // comment above for why) - replaces the default nodeRelSize/nodeColor
      // sphere (which used the scene-lit MeshLambertMaterial) entirely. Each
      // node is actually a small Group of two meshes - the outline sphere
      // (see nodeOutlineGeometry's own comment for the inverted-hull
      // technique) added FIRST so the colored sphere draws on top of/in
      // front of it.
      .nodeThreeObject((node) => {
        const graphNode = node as unknown as GraphNodeDatum
        const group = new ThreeGroup()
        group.add(new Mesh(nodeOutlineGeometry, new MeshBasicMaterial({ color: nodeOutlineColor, side: BackSide })))
        group.add(new Mesh(nodeSphereGeometry, new MeshBasicMaterial({ color: graphNode.color })))
        return group
      })
      // Same unlit-material swap as nodeThreeObject above, for links -
      // linkWidth>0 (below) makes 3d-force-graph render links as lit
      // cylinders by default, which needs its own explicit material
      // override; linkColor/linkOpacity only configure the DEFAULT
      // material, not one supplied here.
      .linkMaterial((link) => {
        const graphLink = link as unknown as { color: string }
        return new MeshBasicMaterial({ color: graphLink.color, transparent: true, opacity: GRAPH_LINK_OPACITY })
      })
      .linkWidth(1.5)
      .showNavInfo(false)
      .enableNodeDrag(false)
      .onNodeClick((node) => {
        const graphNode = node as unknown as GraphNodeDatum
        latestClickedNodeIdRef.current = graphNode.id
        setSelectedNode(graphNode)
        setChunkText(null)
        setChunkTextError(null)
        setChunkTextLoading(true)

        const cachedChunks = chunksCacheRef.current.get(graphNode.documentId)
        const chunksPromise = cachedChunks
          ? Promise.resolve(cachedChunks)
          : apiClient.getChunks(graphNode.documentId).then((documentChunks) => {
              chunksCacheRef.current.set(graphNode.documentId, documentChunks)
              return documentChunks
            })

        void chunksPromise
          .then((documentChunks) => {
            if (latestClickedNodeIdRef.current !== graphNode.id) {
              return
            }
            // editedContent (not originalContent) - the live/current text,
            // matching how ChunkPreviewPage itself treats these two fields
            // (originalContent is only the pre-edit snapshot).
            const match = documentChunks.find((chunk) => chunk.id === graphNode.id)
            if (match) {
              setChunkText(match.editedContent)
            } else {
              setChunkTextError('Could not find this chunk - it may have been deleted or merged since this graph was last loaded.')
            }
          })
          .catch(() => {
            if (latestClickedNodeIdRef.current === graphNode.id) {
              setChunkTextError("Failed to load this chunk's text.")
            }
          })
          .finally(() => {
            if (latestClickedNodeIdRef.current === graphNode.id) {
              setChunkTextLoading(false)
            }
          })
      })

    // LEFT-drag pans across the x/y plane; RIGHT-drag orbits the camera
    // around the (fixed) nodes - "rotate" here has only ever meant the
    // camera/field of view orbiting a fixed target, never the nodes moving
    // (they're pinned via fx/fy/fz above regardless of which control does
    // what). Wheel still zooms (`enableZoom`, on by default - untouched
    // here). There's no chainable config for any of this on ForceGraph3D
    // itself, so `.controls()` (typed as a bare `object` in its own d.ts)
    // reaches the underlying OrbitControls instance directly - cast to the
    // real `OrbitControls` type (from `@types/three`) rather than an ad-hoc
    // inline shape, since `target`/`update()` below need it too.
    const controls = graph.controls() as OrbitControls
    controls.mouseButtons.LEFT = MOUSE.PAN
    controls.mouseButtons.RIGHT = MOUSE.ROTATE
    // Named so it's a single, obvious place to retune - not a magic number
    // buried in the OrbitControls call site.
    controls.panSpeed = GRAPH_PAN_SPEED

    // Idle auto-rotate, paused whenever the pointer is actually over the
    // panel - starts back up on mouseleave rather than staying off for the
    // rest of the session, per explicit request ("a little rotation by
    // default when the mouse ISN'T over the 3D map").
    controls.autoRotate = true
    controls.autoRotateSpeed = GRAPH_AUTO_ROTATE_SPEED
    const stopAutoRotate = () => {
      controls.autoRotate = false
    }
    const startAutoRotate = () => {
      controls.autoRotate = true
    }
    container.addEventListener('mouseenter', stopAutoRotate)
    container.addEventListener('mouseleave', startAutoRotate)

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
      setIsGraphDataLoading(false)
      const documentColors = buildDocumentColors(data.nodes)
      const nodes: GraphNodeDatum[] = data.nodes.map((node) => ({
        id: node.id,
        documentId: node.documentId,
        filename: node.filename,
        color: documentColors.get(node.documentId) ?? '#3D6BFF',
        fx: node.x * POSITION_SCALE,
        fy: node.y * POSITION_SCALE,
        fz: node.z * POSITION_SCALE,
        position: node.position,
      }))
      const links = buildSameDocumentLinks(data.nodes, documentColors)
      graph.graphData({ nodes, links })

      // Re-pivots orbit rotation onto the cluster's actual center - see
      // computeCentroid's own comment for why this can't just stay at
      // OrbitControls' default (0, 0, 0).
      if (nodes.length > 0) {
        const centroid = computeCentroid(nodes)
        controls.target.set(centroid.x, centroid.y, centroid.z)

        // Zooms the initial view in as close as the cluster's actual
        // spread allows without clipping it - 3d-force-graph's own default
        // camera distance has no idea how spread out THIS graph's UMAP
        // coordinates are, which is why the cluster used to render tiny in
        // the middle of a mostly-empty box. Keeps the camera's existing
        // viewing DIRECTION (whatever 3d-force-graph's default framing
        // already was) and only rescales its distance from the centroid -
        // a full re-aim isn't needed, just how far back it sits.
        if (nodes.length > 1) {
          const maxDistance = computeMaxPairwiseDistance(nodes)
          const radius = maxDistance / 2
          const perspectiveCamera = graph.camera() as PerspectiveCamera
          const verticalFovRadians = (perspectiveCamera.fov * Math.PI) / 180
          const fitDistance = (radius / Math.sin(verticalFovRadians / 2)) * GRAPH_INITIAL_ZOOM_PADDING

          const currentPosition = graph.cameraPosition()
          const direction = new Vector3(currentPosition.x, currentPosition.y, currentPosition.z).sub(
            new Vector3(centroid.x, centroid.y, centroid.z),
          )
          if (direction.lengthSq() === 0) {
            // Degenerate only if the default camera ever started exactly
            // at the centroid (shouldn't happen in practice) - falls back
            // to looking down the z-axis rather than producing a NaN
            // position from normalizing a zero-length vector.
            direction.set(0, 0, 1)
          }
          direction.normalize().multiplyScalar(fitDistance)

          graph.cameraPosition(
            { x: centroid.x + direction.x, y: centroid.y + direction.y, z: centroid.z + direction.z },
            centroid,
            0,
          )
        }

        // Applies the target/position changes above immediately, rather
        // than waiting for the next drag to silently jump to them.
        controls.update()
      }
    })

    return () => {
      cancelled = true
      resizeObserver.disconnect()
      container.removeEventListener('mouseenter', stopAutoRotate)
      container.removeEventListener('mouseleave', startAutoRotate)
      graph._destructor()
      container.replaceChildren()
    }
  }, [])

  return (
    <>
      {/* Outer wrapper is ALSO `position: 'relative'` (redundant with the
          inner div's own, but harmless) purely so the loading overlay below
          can anchor to it via `position: 'absolute'` - the overlay is
          deliberately a SIBLING of the graph div, not a React child inside
          it, since that div's own children are owned entirely by
          3d-force-graph's direct DOM manipulation (it replaceChildren()s
          this div on cleanup and appends its own canvas into it) - a React
          child living inside the same node would fight that instead of
          just sitting visually on top of it. */}
      <Box style={{ width: '100%', height: '100%', position: 'relative' }}>
        {/* `position: 'relative'` here is load-bearing, not decorative:
            three.js/three-render-objects position the actual WebGL canvas
            (and any overlay elements) with `position: absolute`, which
            anchors to the nearest *positioned* ancestor - without one here,
            that anchor was some unrelated ancestor further up the page (or
            the viewport itself), which is why the rendered graph was
            showing up detached from this card entirely instead of filling
            it. No minHeight here deliberately - this should fill its parent
            Paper exactly (which itself is stretched by the outer Group to
            match the Messages/Dislikes chart stack's height precisely),
            not impose its own floor that could make it taller than that
            stack. */}
        <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />
        {isGraphDataLoading ? (
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Loader color="sparkOrange" />
          </Box>
        ) : null}
      </Box>

      {/* Same Modal convention as ChatPage/ChunkPreviewPage/UploadPage
          (opened/onClose, radius="lg"). `size="1200px"` - twice this app's
          usual `size="lg"` (~620px) - a whole chunk's text needs more
          reading width than this app's other, narrower confirm-only
          Modals. The text itself sits in its own capped-height, scrolled
          box (scrollbar styled by the app-wide rule in global.css, applied
          automatically) rather than letting the Modal grow arbitrarily
          tall for a long chunk. `title` is a real
          `<Title order={4}>` (same "section heading" component the
          Messages sent/Dislikes charts use, not Mantine's own default
          title styling, which read too close in size to the body text
          below it) so it visually reads as a heading over the chunk text.
          `closeButtonProps` recolors the X to this app's alertMagenta
          accent (same red used for the dislike button/delete confirms/
          error Alerts elsewhere) with that same color's `-light` tinted
          background (the automatic Mantine variant-color CSS var the
          `variant="light"` Alert below also resolves to) - a plain neutral
          backdrop read as too quiet, per explicit request for a more
          noticeable red. `radius="xl"` keeps that backdrop a full circle
          regardless of this component's own default. */}
      <Modal
        opened={selectedNode !== null}
        onClose={() => setSelectedNode(null)}
        title={selectedNode ? <Title order={4}>{chunkNodeLabel(selectedNode)}</Title> : ''}
        radius="lg"
        size="1200px"
        closeButtonProps={{
          c: 'alertMagenta',
          radius: 'xl',
          // Default size is 28px (Mantine's own --cb-size-md) - enlarged
          // per explicit request (56px read as slightly too big on a
          // follow-up look, dialed back to 40px), the X glyph itself
          // scales with it automatically (CloseButton's own iconSize
          // defaults to 70% of this size, not a separate fixed value).
          size: 40,
          style: { backgroundColor: 'var(--mantine-color-alertMagenta-light)' },
        }}
      >
        <Stack gap="lg">
          {chunkTextLoading ? (
            <Text c="dimmed">Loading chunk text...</Text>
          ) : chunkTextError ? (
            <Alert color="alertMagenta" variant="light" radius="lg">
              {chunkTextError}
            </Alert>
          ) : (
            <Box style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {/* white-space: pre-line (not pre-wrap) - see reflowChunkText
                  above: single hard-wrapped newlines are already collapsed
                  to spaces before this renders, so this only needs to keep
                  honoring the real paragraph breaks that survived that. */}
              <Text ff="monospace" style={{ whiteSpace: 'pre-line' }}>
                {chunkText ? reflowChunkText(chunkText) : chunkText}
              </Text>
            </Box>
          )}
          <Group justify="flex-end">
            {/* Deep-links into ChunkPreviewPage at this exact chunk via a
                `?chunk=` query param the route itself has no built-in
                support for - ChunkPreviewPage reads it once its own chunks
                have loaded and jumps/focuses to it (see its own
                pendingChunkFocus state/effect). */}
            <Button
              variant="filled"
              color="sparkOrange"
              radius="xl"
              onClick={() => {
                if (!selectedNode) {
                  return
                }
                navigate(`/upload/${selectedNode.documentId}/chunks?chunk=${selectedNode.id}`)
              }}
            >
              Open in document
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  )
}
