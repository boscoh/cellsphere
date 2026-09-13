import * as THREE from 'three'
import { BODY_CHUNK_CELLS } from './constants'
import { bodyMat } from './materials'

// Pooled body InstancedMeshes: one pool per (length, width) bucket, growing in
// fixed-size chunks. Each chunk clones the bucket geometry template because its
// per-instance attributes must be independent of other chunks (cell-dj4).
// Split out of cells.js (cell-cv6.5).

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

function bodyBucket(length, width) {
  return Math.round(length / GEO_STEP) * 1000 + Math.round(width / 0.001)
}

export function disposeBodyGeos() {
  const cache = bodyGeoCache
  for (const geo of cache.values()) geo.dispose()
  cache.clear()
}

export function initBodyPools(sim) {
  sim.bodyPools = new Map()
}

function getPool(sim, length, width) {
  const bucket = bodyBucket(length, width)
  let entry = sim.bodyPools.get(bucket)
  if (!entry) {
    entry = { bucket, template: bodyGeoFor(length, width), chunks: [] }
    sim.bodyPools.set(bucket, entry)
  }
  return entry
}

function attachChunk(sim, chunk) {
  if (!chunk.attached) {
    sim.scene.add(chunk.mesh)
    chunk.attached = true
  }
}

function detachChunk(sim, chunk) {
  if (chunk.attached) {
    sim.scene.remove(chunk.mesh)
    chunk.attached = false
  }
}

function createBodyChunk(sim, entry) {
  // Each chunk owns a geometry clone. instanceParalysed is a per-instance
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
  const paralysed = new THREE.InstancedBufferAttribute(
    new Float32Array(BODY_CHUNK_CELLS).fill(0),
    1,
  )
  paralysed.setUsage(THREE.DynamicDrawUsage)
  mesh.geometry.setAttribute('instanceParalysed', paralysed)
  const chunk = {
    mesh,
    free: [],
    live: 0,
    count: 0,
    paralysed,
    attached: false,
  }
  sim.scene.add(mesh)
  chunk.attached = true
  return chunk
}

function allocChunkSlot(sim, entry) {
  for (const chunk of entry.chunks) {
    if (chunk.free.length) {
      const slot = chunk.free.pop()
      attachChunk(sim, chunk)
      return { chunk, slot }
    }
  }
  for (const chunk of entry.chunks) {
    if (chunk.count < BODY_CHUNK_CELLS) {
      const slot = chunk.count++
      attachChunk(sim, chunk)
      return { chunk, slot }
    }
  }
  const chunk = createBodyChunk(sim, entry)
  entry.chunks.push(chunk)
  return { chunk, slot: chunk.count++ }
}

function zeroMatrix(sim, mesh, slot) {
  const o = sim._dummy
  o.position.set(0, 0, 0)
  o.rotation.set(0, 0, 0)
  o.scale.set(0, 0, 0)
  o.updateMatrix()
  mesh.setMatrixAt(slot, o.matrix)
}

export function addBody(sim, d, length) {
  const entry = getPool(sim, length, d.width)
  const { chunk, slot } = allocChunkSlot(sim, entry)
  chunk.live++
  chunk.mesh.count = chunk.count
  d.bodyBucket = entry.bucket
  d.bodyChunk = chunk
  d.bodySlot = slot
  if (chunk.paralysed) chunk.paralysed.setX(slot, 0)
  setBodyColor(sim, d, d.color)
  chunk.mesh.instanceMatrix.needsUpdate = true
}

export function setBodyColor(sim, d, color) {
  if (d.bodyBucket == null) return
  const entry = sim.bodyPools.get(d.bodyBucket)
  const chunk = d.bodyChunk
  if (!entry || !chunk || !chunk.mesh) return
  chunk.mesh.setColorAt(d.bodySlot, color)
  if (chunk.mesh.instanceColor) chunk.mesh.instanceColor.needsUpdate = true
}

export function setInstanceColor(sim, d) {
  setBodyColor(sim, d, d.color)
}

export function removeBody(sim, d) {
  if (d.bodyBucket == null) return
  const entry = sim.bodyPools.get(d.bodyBucket)
  const chunk = d.bodyChunk
  if (entry && chunk && chunk.mesh) {
    zeroMatrix(sim, chunk.mesh, d.bodySlot)
    chunk.free.push(d.bodySlot)
    chunk.live--
    if (chunk.live === 0) {
      detachChunk(sim, chunk)
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
export function rehomeBody(sim, d, newLength) {
  const nb = bodyBucket(newLength, d.width)
  if (d.bodyBucket == null) {
    addBody(sim, d, newLength)
    return true
  }
  if (nb === d.bodyBucket) return false
  removeBody(sim, d)
  addBody(sim, d, newLength)
  return true
}

export function renderBodies(sim) {
  for (const d of sim.cells) {
    if (d.bodyBucket == null) continue
    const chunk = d.bodyChunk
    if (!chunk || !chunk.mesh) continue
    const mesh = chunk.mesh
    const sc = d.fade >= 1 ? sim._one : sim._v9.set(d.fade, d.fade, d.fade)
    sim._m.compose(d.pos, d.quat, sc)
    mesh.setMatrixAt(d.bodySlot, sim._m)
    mesh.instanceMatrix.needsUpdate = true
    // Predator-latched prey glows purple at the rim so it's obvious it's held.
    if (chunk.paralysed) {
      chunk.paralysed.setX(d.bodySlot, d.paralysed ? 1 : 0)
      chunk.paralysed.needsUpdate = true
    }
  }
}

export function disposeBodyPools(sim) {
  for (const entry of sim.bodyPools.values()) {
    for (const chunk of entry.chunks) {
      if (chunk.mesh) {
        sim.scene.remove(chunk.mesh)
        chunk.mesh.geometry.dispose()
        chunk.mesh.dispose()
        chunk.mesh = null
      }
    }
  }
  sim.bodyPools.clear()
}
