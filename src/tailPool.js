import * as THREE from 'three'
import { P, SURFACE, TAIL_SEGMENTS, TAIL_CHUNK_CELLS } from './constants.js'
import { tailGeo, tailMat } from './materials.js'

// Tail instance pool and placement. Slots are packed per chunk so mesh.count is
// exact; freeing a slot moves the last live slot into the hole. Cells and the
// physics loop never touch chunk internals: the render sync pass claims,
// inherits or releases a slot. Operates on a View.

const TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS * TAIL_SEGMENTS

function makeTailAttrs() {
  const pos = new THREE.InstancedBufferAttribute(
    new Float32Array(TAIL_CHUNK_SIZE * 3),
    3,
  )
  const x = new THREE.InstancedBufferAttribute(
    new Float32Array(TAIL_CHUNK_SIZE * 3),
    3,
  )
  const y = new THREE.InstancedBufferAttribute(
    new Float32Array(TAIL_CHUNK_SIZE * 3),
    3,
  )
  const scale = new THREE.InstancedBufferAttribute(
    new Float32Array(TAIL_CHUNK_SIZE * 2),
    2,
  )
  const aura = new THREE.InstancedBufferAttribute(
    new Float32Array(TAIL_CHUNK_SIZE),
    1,
  )
  for (const a of [pos, x, y, scale, aura]) a.setUsage(THREE.DynamicDrawUsage)
  return { pos, x, y, scale, aura }
}

export function createTailChunk(view) {
  // Each chunk owns a geometry clone so its compact per-segment attributes
  // (midpoint, axis X, up Y, scale) are independent of other chunks.
  const geo = tailGeo.clone()
  const attrs = makeTailAttrs()
  geo.setAttribute('aSegPos', attrs.pos)
  geo.setAttribute('aSegX', attrs.x)
  geo.setAttribute('aSegY', attrs.y)
  geo.setAttribute('aSegScale', attrs.scale)
  geo.setAttribute('aAura', attrs.aura)
  const mesh = new THREE.InstancedMesh(geo, tailMat, TAIL_CHUNK_SIZE)
  // Tail segments are spread across the whole sphere; the cached bounding
  // sphere is wrong/stale, so a zoom-in would cull visible segments.
  mesh.frustumCulled = false
  mesh.setColorAt(0, new THREE.Color(1, 1, 1))
  mesh.instanceColor.needsUpdate = true
  mesh.count = 0
  view.scene.add(mesh)
  const chunk = {
    mesh,
    live: 0,
    owners: new Array(TAIL_CHUNK_CELLS).fill(null),
    attrs,
    attrList: [attrs.pos, attrs.x, attrs.y, attrs.scale, attrs.aura],
  }
  view.tailChunks.push(chunk)
  return chunk
}

// Tail cell slots are packed contiguously from 0..live-1, so `mesh.count` can
// exclude every unused (reserved or freed) instance from the draw.
function allocTailSlot(view) {
  for (const chunk of view.tailChunks) {
    if (chunk.live < TAIL_CHUNK_CELLS) {
      const slot = chunk.live++
      chunk.mesh.count = chunk.live * TAIL_SEGMENTS
      return { chunk, slot }
    }
  }
  const chunk = createTailChunk(view)
  const slot = chunk.live++
  chunk.mesh.count = chunk.live * TAIL_SEGMENTS
  return { chunk, slot }
}

function freeTailSlot(view, d) {
  const chunk = d.tailChunk
  if (!chunk || !chunk.mesh) return
  const slot = d.tailSlot
  const last = chunk.live - 1
  if (slot !== last) {
    // Move the last live slot into the hole so live slots stay contiguous. Its
    // segment attributes are recomputed by placeTail each frame, but the
    // per-instance color lives outside placeTail and must be rewritten.
    const owner = chunk.owners[last]
    chunk.owners[slot] = owner
    if (owner) {
      owner.tailSlot = slot
      setTailColor(view, owner)
    }
  }
  chunk.owners[last] = null
  chunk.live = last
  chunk.mesh.count = last * TAIL_SEGMENTS
  d.tailChunk = null
  d.tailSlot = -1
}

export function releaseTail(view, d) {
  clearTail(view, d)
  freeTailSlot(view, d)
}

export function disposeTailPool(view) {
  for (const chunk of view.tailChunks) {
    if (chunk.mesh) {
      view.scene.remove(chunk.mesh)
      chunk.mesh.geometry.dispose()
      chunk.mesh.dispose()
      chunk.mesh = null
    }
  }
  view.tailChunks = []
}

export function setTailColor(view, d) {
  if (!d.color || !d.tailChunk || !d.tailChunk.mesh) return
  const mesh = d.tailChunk.mesh
  const base = d.tailSlot * TAIL_SEGMENTS
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    mesh.setColorAt(base + i, d.color)
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

function markTailRange(view, chunk, base) {
  if (!view.renderer) return
  const S = TAIL_SEGMENTS
  chunk.attrs.pos.addUpdateRange(base * 3, S * 3)
  chunk.attrs.x.addUpdateRange(base * 3, S * 3)
  chunk.attrs.y.addUpdateRange(base * 3, S * 3)
  chunk.attrs.scale.addUpdateRange(base * 2, S * 2)
}

// Collapse a cell's segments to zero scale so they draw nothing. Positions and
// axes are left stale; the shader multiplies them by the zero scale.
function hideTailSegments(chunk, base) {
  const s = chunk.attrs.scale.array
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    s[(base + i) * 2] = 0
    s[(base + i) * 2 + 1] = 0
  }
}

export function clearTail(view, d) {
  const chunk = d.tailChunk
  if (!chunk || !chunk.mesh) return
  const base = d.tailSlot * TAIL_SEGMENTS
  hideTailSegments(chunk, base)
  markTailRange(view, chunk, base)
  for (const a of chunk.attrList) a.needsUpdate = true
}

export function placeTail(view, d) {
  const chunk = d.tailChunk
  if (!chunk || !chunk.mesh) return null
  const base = d.tailSlot * TAIL_SEGMENTS
  if (d.sideHidden) {
    hideTailSegments(chunk, base)
    markTailRange(view, chunk, base)
    return chunk
  }
  const dirs = d.tailDirs
  // Tail length is P.TAIL_BODY × body length (body ≈ 2·radius), so the tail
  // scales proportionally with the cell.
  const pitch = ((P.TAIL_BODY * 2 * d.radius) / TAIL_SEGMENTS) * d.tailGrow
  const draw = pitch * P.TAIL_LINK_FILL
  const ts = view.tailScale
  const { pos, x: ax, y: ay, scale, aura } = chunk.attrs
  const posArr = pos.array
  const xArr = ax.array
  const yArr = ay.array
  const sArr = scale.array
  const auraArr = aura.array
  // The rim marker on the tail: the assembly's ramping aura, or the latched-prey
  // flag — the same value the body writes, so a held cell glows head to tail.
  const cellAura = Math.max(d.aura || 0, d.paralysed ? 1 : 0)
  const a = view._v1
    .copy(d.pos)
    .addScaledVector(d.heading, -(d.radius - d.width * P.TAIL_HINGE))
  a.setLength(SURFACE)
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const b = view._v2.copy(a).addScaledVector(dirs[i], pitch)
    b.setLength(SURFACE)
    const x = view._v3.subVectors(b, a).normalize()
    // The cross-section is circular, so only the segment axis matters: use the
    // outward sphere normal as the up vector (z is derived in the shader).
    const n = view._v4.copy(a).add(b).normalize()
    const y = view._v5.copy(n).addScaledVector(x, -n.dot(x))
    if (y.lengthSq() < 1e-12) y.set(0, 1, 0).addScaledVector(x, -x.y)
    y.normalize()
    const k = base + i
    const p = k * 3
    posArr[p] = (a.x + b.x) * 0.5
    posArr[p + 1] = (a.y + b.y) * 0.5
    posArr[p + 2] = (a.z + b.z) * 0.5
    xArr[p] = x.x
    xArr[p + 1] = x.y
    xArr[p + 2] = x.z
    yArr[p] = y.x
    yArr[p + 1] = y.y
    yArr[p + 2] = y.z
    sArr[k * 2] = draw
    sArr[k * 2 + 1] = ts
    auraArr[k] = cellAura
    a.copy(b)
  }
  markTailRange(view, chunk, base)
  return chunk
}

// Bind a freshly allocated slot to a cell. Ownership, colour and the tail chain
// are the pool's business, so physics never touches chunk internals.
export function claimTailSlot(view, d) {
  const { chunk, slot } = allocTailSlot(view)
  chunk.owners[slot] = d
  d.tailChunk = chunk
  d.tailSlot = slot
  setTailColor(view, d)
}

// Hand the parent's slot to a daughter so the tail does not visibly jump when a
// cell divides. The parent ends up slotless, which makes releaseTail/clearTail
// no-ops for it, so no transfer flag is needed.
export function inheritTailSlot(view, from, to) {
  const chunk = from.tailChunk
  const slot = from.tailSlot
  from.tailChunk = null
  from.tailSlot = -1
  if (!chunk) return
  chunk.owners[slot] = to
  to.tailChunk = chunk
  to.tailSlot = slot
  setTailColor(view, to)
}
