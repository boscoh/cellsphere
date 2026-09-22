import * as THREE from 'three'
import { BODY_CHUNK_CELLS } from './constants.js'
import { bodyMat } from './materials.js'

// Pooled body InstancedMeshes: one pool per (length, width) bucket, growing in
// fixed-size chunks. Each chunk clones the bucket geometry template because its
// per-instance attributes must be independent of other chunks (cell-dj4).
// Split out of cells.js (cell-cv6.5). Operates on a View (scene + pools).

const GEO_STEP = 0.01
const bodyGeoCache = new Map()

function makeBodyGeo(length, width) {
  const cylLen = Math.max(2 * (length - width), 0.001)
  const geo = new THREE.CapsuleGeometry(width, cylLen, 6, 12)
  geo.rotateZ(Math.PI / 2)
  return geo
}

function bodyGeoFor(length, width) {
  const key = bodyBucket(length, width)
  let geo = bodyGeoCache.get(key)
  if (!geo) {
    geo = makeBodyGeo(length, width)
    bodyGeoCache.set(key, geo)
  }
  return geo
}

export function bodyBucket(length, width) {
  return Math.round(length / GEO_STEP) * 1000 + Math.round(width / 0.001)
}

export function disposeBodyGeos() {
  const cache = bodyGeoCache
  for (const geo of cache.values()) geo.dispose()
  cache.clear()
}

export function initBodyPools(view) {
  view.bodyPools = new Map()
}

function getPool(view, length, width) {
  const bucket = bodyBucket(length, width)
  let entry = view.bodyPools.get(bucket)
  if (!entry) {
    entry = { bucket, template: bodyGeoFor(length, width), chunks: [] }
    view.bodyPools.set(bucket, entry)
  }
  return entry
}

function attachChunk(view, chunk) {
  if (!chunk.attached) {
    view.scene.add(chunk.mesh)
    chunk.attached = true
  }
}

function detachChunk(view, chunk) {
  if (chunk.attached) {
    view.scene.remove(chunk.mesh)
    chunk.attached = false
  }
}

function createBodyChunk(view, entry) {
  // Each chunk owns a geometry clone. aAura is a per-instance
  // attribute, so a shared geometry would let the last-created chunk's
  // attributes win for every chunk in the bucket (cell-dj4).
  const geo = entry.template.clone()
  const mesh = new THREE.InstancedMesh(geo, bodyMat, BODY_CHUNK_CELLS)
  // Instances span the whole shell and change size every frame, so the cached
  // bounding sphere is never accurate; culling would drop visible bodies on
  // close zoom. Bodies are never culled (see render.js 'cull' comment).
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.instanceMatrix.needsUpdate = true
  const aura = new THREE.InstancedBufferAttribute(
    new Float32Array(BODY_CHUNK_CELLS).fill(0),
    1,
  )
  aura.setUsage(THREE.DynamicDrawUsage)
  mesh.geometry.setAttribute('aAura', aura)
  const chunk = {
    mesh,
    free: [],
    live: 0,
    count: 0,
    aura,
    attached: false,
  }
  view.scene.add(mesh)
  chunk.attached = true
  return chunk
}

function allocChunkSlot(view, entry) {
  for (const chunk of entry.chunks) {
    if (chunk.free.length) {
      const slot = chunk.free.pop()
      attachChunk(view, chunk)
      return { chunk, slot }
    }
  }
  for (const chunk of entry.chunks) {
    if (chunk.count < BODY_CHUNK_CELLS) {
      const slot = chunk.count++
      attachChunk(view, chunk)
      return { chunk, slot }
    }
  }
  const chunk = createBodyChunk(view, entry)
  entry.chunks.push(chunk)
  return { chunk, slot: chunk.count++ }
}

function zeroMatrix(view, mesh, slot) {
  const o = view._dummy
  o.position.set(0, 0, 0)
  o.rotation.set(0, 0, 0)
  o.scale.set(0, 0, 0)
  o.updateMatrix()
  mesh.setMatrixAt(slot, o.matrix)
}

export function addBody(view, d, length) {
  const entry = getPool(view, length, d.width)
  const { chunk, slot } = allocChunkSlot(view, entry)
  chunk.live++
  chunk.mesh.count = chunk.count
  d.bodyBucket = entry.bucket
  d.bodyChunk = chunk
  d.bodySlot = slot
  if (chunk.aura) chunk.aura.setX(slot, 0)
  setBodyColor(view, d, d.color)
  chunk.mesh.instanceMatrix.needsUpdate = true
}

export function setBodyColor(view, d, color) {
  if (d.bodyBucket == null) return
  const entry = view.bodyPools.get(d.bodyBucket)
  const chunk = d.bodyChunk
  if (!entry || !chunk || !chunk.mesh) return
  chunk.mesh.setColorAt(d.bodySlot, color)
  if (chunk.mesh.instanceColor) chunk.mesh.instanceColor.needsUpdate = true
}

export function setInstanceColor(view, d) {
  setBodyColor(view, d, d.color)
}

export function removeBody(view, d) {
  if (d.bodyBucket == null) return
  const entry = view.bodyPools.get(d.bodyBucket)
  const chunk = d.bodyChunk
  if (entry && chunk && chunk.mesh) {
    zeroMatrix(view, chunk.mesh, d.bodySlot)
    chunk.free.push(d.bodySlot)
    chunk.live--
    if (chunk.live === 0) {
      detachChunk(view, chunk)
    } else {
      chunk.mesh.instanceMatrix.needsUpdate = true
    }
  }
  d.bodyBucket = null
  d.bodyChunk = null
  d.bodySlot = null
}

// Returns true when the cell moved to a different bucket, so the caller knows
// whether the per-instance colour has to be rewritten.
export function rehomeBody(view, d, newLength) {
  const nb = bodyBucket(newLength, d.width)
  if (d.bodyBucket == null) {
    addBody(view, d, newLength)
    return true
  }
  if (nb === d.bodyBucket) return false
  removeBody(view, d)
  addBody(view, d, newLength)
  return true
}

export function renderBodies(view) {
  for (const d of view.sim.cells) {
    if (d.bodyBucket == null) continue
    const chunk = d.bodyChunk
    if (!chunk || !chunk.mesh) continue
    const mesh = chunk.mesh
    const sc = d.fade >= 1 ? view._one : view._v9.set(d.fade, d.fade, d.fade)
    view._m.compose(d.pos, d.quat, sc)
    mesh.setMatrixAt(d.bodySlot, view._m)
    mesh.instanceMatrix.needsUpdate = true
    // Predator-latched prey glows purple at the rim so it's obvious it's held.
    // The rim marker: the assembly's ramping aura, or the latched-prey flag
    // (a latched green still glows exactly as before). Physics owns `aura`;
    // render only picks the maximum.
    if (chunk.aura) {
      chunk.aura.setX(d.bodySlot, Math.max(d.aura || 0, d.paralysed ? 1 : 0))
      chunk.aura.needsUpdate = true
    }
  }
}

export function disposeBodyPools(view) {
  for (const entry of view.bodyPools.values()) {
    for (const chunk of entry.chunks) {
      if (chunk.mesh) {
        view.scene.remove(chunk.mesh)
        chunk.mesh.geometry.dispose()
        chunk.mesh.dispose()
        chunk.mesh = null
      }
    }
  }
  view.bodyPools.clear()
}
