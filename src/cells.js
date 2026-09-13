import * as THREE from 'three'
import {
  SURFACE,
  MAX_CELLS,
  MIN_RADIUS,
  MAX_RADIUS,
  START_RADIUS,
  ENERGY_MAX,
  METABOLISM,
  MOVE_COST,
  TURN_COST,
  PRED_METABOLISM,
  MAX_SPIN,
  RED_SIZE,
  MITO_TIME,
  MITO_HOLD,
  MITO_FADE,
  MITO_NEAR,
  MITO_SEP,
  MITO_DETACH,
  MITO_REST,
  WIDTH,
  TAIL_SEGMENTS,
  TAIL_LINK,
  TAIL_LINK_FILL,
  TAIL_BODY,
  TAIL_HINGE,
  TAIL_CHUNK_CELLS,
  BODY_CHUNK_CELLS,
} from './constants'
import { randomSurfacePoint, randomTangent, smoothstep } from './math'
import { bodyMat, tailGeo, tailMat } from './materials'

const GEO_STEP = 0.01
const TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS * TAIL_SEGMENTS
const BREED_BLUE = 0
const BREED_RED = 1
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

export function computeCellColor(breed) {
  // Color is constant per breed — size already conveys growth.
  if (breed === BREED_RED) return new THREE.Color().setHSL(0.015, 0.78, 0.5)
  return new THREE.Color().setHSL(0.37, 0.5, 0.5)
}

function setCellColor(d) {
  d.color.copy(computeCellColor(d.breed))
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

function setInstanceColor(sim, d) {
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

export function rehomeBody(sim, d, newLength) {
  const nb = bodyBucket(newLength, d.width)
  if (d.bodyBucket == null) {
    addBody(sim, d, newLength)
    return
  }
  if (nb === d.bodyBucket) return
  removeBody(sim, d)
  addBody(sim, d, newLength)
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
  for (const a of [pos, x, y, scale]) a.setUsage(THREE.DynamicDrawUsage)
  return { pos, x, y, scale }
}

export function createTailChunk(sim) {
  // Each chunk owns a geometry clone so its compact per-segment attributes
  // (midpoint, axis X, up Y, scale) are independent of other chunks.
  const geo = tailGeo.clone()
  const attrs = makeTailAttrs()
  geo.setAttribute('aSegPos', attrs.pos)
  geo.setAttribute('aSegX', attrs.x)
  geo.setAttribute('aSegY', attrs.y)
  geo.setAttribute('aSegScale', attrs.scale)
  const mesh = new THREE.InstancedMesh(geo, tailMat, TAIL_CHUNK_SIZE)
  // Tail segments are spread across the whole sphere; the cached bounding
  // sphere is wrong/stale, so a zoom-in would cull visible segments.
  mesh.frustumCulled = false
  mesh.setColorAt(0, new THREE.Color(1, 1, 1))
  mesh.instanceColor.needsUpdate = true
  mesh.count = 0
  sim.scene.add(mesh)
  const chunk = {
    mesh,
    live: 0,
    owners: new Array(TAIL_CHUNK_CELLS).fill(null),
    attrs,
    attrList: [attrs.pos, attrs.x, attrs.y, attrs.scale],
  }
  sim.tailChunks.push(chunk)
  return chunk
}

// Tail cell slots are packed contiguously from 0..live-1, so `mesh.count` can
// exclude every unused (reserved or freed) instance from the draw.
export function allocTailSlot(sim) {
  for (const chunk of sim.tailChunks) {
    if (chunk.live < TAIL_CHUNK_CELLS) {
      const slot = chunk.live++
      chunk.mesh.count = chunk.live * TAIL_SEGMENTS
      return { chunk, slot }
    }
  }
  const chunk = createTailChunk(sim)
  const slot = chunk.live++
  chunk.mesh.count = chunk.live * TAIL_SEGMENTS
  return { chunk, slot }
}

function freeTailSlot(sim, d) {
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
      setTailColor(sim, owner)
    }
  }
  chunk.owners[last] = null
  chunk.live = last
  chunk.mesh.count = last * TAIL_SEGMENTS
  d.tailChunk = null
  d.tailSlot = -1
}

export function releaseTail(sim, d) {
  if (d.tailTransfer) return
  clearTail(sim, d)
  freeTailSlot(sim, d)
}

export function disposeTailPool(sim) {
  for (const chunk of sim.tailChunks) {
    if (chunk.mesh) {
      sim.scene.remove(chunk.mesh)
      chunk.mesh.geometry.dispose()
      chunk.mesh.dispose()
      chunk.mesh = null
    }
  }
  sim.tailChunks = []
}

function makeTailDirs(heading) {
  const back = heading.clone().negate().normalize()
  const dirs = []
  for (let i = 0; i < TAIL_SEGMENTS; i++) dirs.push(back.clone())
  return dirs
}

function makeTailChain(pos, heading, radius) {
  const n = TAIL_SEGMENTS + 1
  const pts = []
  const vel = []
  const vt = []
  const q = []
  for (let i = 0; i < n; i++) {
    pts.push(new THREE.Vector3())
    vel.push(new THREE.Vector3())
    vt.push(new THREE.Vector3())
    q.push(new THREE.Vector3())
  }
  const root = pos.clone().addScaledVector(heading, -radius)
  root.setLength(SURFACE)
  pts[0].copy(root)
  const back = heading.clone().negate()
  for (let i = 1; i < n; i++) {
    pts[i].copy(pts[i - 1]).addScaledVector(back, TAIL_LINK).setLength(SURFACE)
  }
  return { pts, vel, vt, q }
}

const sizeF = (breed) => (breed === BREED_RED ? RED_SIZE : 1)

export function radiusFromEnergy(energy, breed = BREED_BLUE) {
  const f = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX) / ENERGY_MAX
  return (MIN_RADIUS + f * (MAX_RADIUS - MIN_RADIUS)) * sizeF(breed)
}

function energyFromRadius(radius, breed = BREED_BLUE) {
  const base = radius / sizeF(breed)
  const f = (base - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS)
  return THREE.MathUtils.clamp(f, 0, 1) * ENERGY_MAX
}

export function createCell(sim, tail, pos, heading, length, breed = Math.random() < 0.5 ? BREED_BLUE : BREED_RED) {
  const chain = makeTailChain(pos, heading, length)
  const d = {
    radius: length,
    width: WIDTH * sizeF(breed),
    energy: energyFromRadius(length, breed),
    mass: length * length * 0.25,
    color: new THREE.Color(),
    breed,
    pos,
    vel: heading.clone().multiplyScalar(0.3),
    heading,
    tailDirs: makeTailDirs(heading),
    tailCarrier: heading.clone().negate().normalize(),
    tailPts: chain.pts,
    tailVel: chain.vel,
    tailVT: chain.vt,
    tailQ: chain.q,
    tailLag: 0,
    tailBend: 0,
    steer: 0,
    tailPhase: Math.random() * Math.PI * 2,
    slow: 1,
    foodDir: new THREE.Vector3(),
    foodAmt: 0,
    foodPeak: 0,
    preyDir: new THREE.Vector3(),
    preyAmt: 0,
    headingRate: 0,
    drive: 0,
    paralysed: false,
    target: null,
    detach: false,
    detachT: 0,
    detachFrom: null,
    split: false,
    splitPending: false,
    mito: null,
    splitting: false,
    dead: false,
    sideHidden: false,
    tailGrow: 1,
    fade: 1,
    rest: 0,
    tailChunk: tail.chunk,
    tailSlot: tail.slot,
    absorbAcc: 0,
    bodyBucket: null,
    bodyChunk: null,
    bodySlot: null,
    quat: new THREE.Quaternion(),
  }
  setCellColor(d)
  tail.chunk.owners[tail.slot] = d
  addBody(sim, d, length)
  setTailColor(sim, d)
  return d
}

export function makeCell(sim, breed) {
  if (breed === undefined) {
    breed = Math.random() < 0.5 ? BREED_BLUE : BREED_RED
  }
  const length = (START_RADIUS + Math.random() * 0.04) * sizeF(breed)
  const pos = randomSurfacePoint()
  const normal = pos.clone().normalize()
  const heading = randomTangent(normal)
  return createCell(sim, allocTailSlot(sim), pos, heading, length, breed)
}

function setSize(sim, d, energy, checkSplit) {
  const next = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX)
  const r = radiusFromEnergy(next, d.breed)
  d.energy = next
  d.mass = Math.max(r * r * 0.25, 0.05)
  if (r !== d.radius) {
    d.radius = r
    const nb = bodyBucket(r, d.width)
    if (nb !== d.bodyBucket) {
      setCellColor(d)
      rehomeBody(sim, d, r)
      setInstanceColor(sim, d)
      setTailColor(sim, d)
    }
  }
  if (checkSplit && next >= ENERGY_MAX - 1e-6 && !d.splitPending) d.split = true
  else if (next < ENERGY_MAX - 1e-6) d.splitPending = false
}

export function gainEnergy(sim, cell, amount) {
  const d = cell
  setSize(sim, d, d.energy + amount, true)
}

export function drainEnergy(sim, d, amount) {
  setSize(sim, d, d.energy - amount, false)
}

export function updateEnergy(sim, d, dt) {
  if (METABOLISM <= 0 && MOVE_COST <= 0 && TURN_COST <= 0 && PRED_METABOLISM <= 0) return
  if (d.mito || d.splitting || d.split) return
  if (d.energy > 0) {
    // Locomotion costs: swimming scales with drive (thrust), turning with the
    // heading rate normalised by MAX_SPIN, so effort drains energy on top of
    // the passive metabolism.
    const spin = MAX_SPIN > 0 ? Math.min(Math.abs(d.headingRate) / MAX_SPIN, 1) : 0
    // A predator with no prey latched burns PRED_METABOLISM on top, so reds
    // starve quickly when there is nothing to hunt.
    const pred = d.breed === BREED_RED && !d.target ? PRED_METABOLISM : 0
    const cost =
      METABOLISM + pred + MOVE_COST * Math.max(d.drive || 0, 0) + TURN_COST * spin
    drainEnergy(sim, d, cost * dt)
  }
  if (d.energy <= 0) d.dead = true
}

// A predator that is about to divide while still feeding first lets go of its
// prey and swims clear for MITO_DETACH seconds, so the daughters don't split
// out on top of the prey it was draining.
export function beginDetach(sim, d) {
  d.detach = true
  d.detachT = 0
  d.detachFrom = d.target
  d.target = null
  d.drive = 0
}

export function updateDetach(sim, d, dt) {
  if (!d.detach) return
  d.detachT += dt
  if (d.detachT >= MITO_DETACH) {
    d.detach = false
    d.detachFrom = null
  }
}

export function mitose(sim, parent) {
  const d = parent
  if (sim.cells.length + 2 > MAX_CELLS) {
    d.split = false
    d.splitPending = true
    return
  }
  d.splitPending = false
  d.split = false
  // Each daughter starts at half the parent's length so the two fit exactly
  // inside the parent's silhouette (2 x childLen == parent body length) — no pop.
  const childLen = d.radius * 0.5
  const phead = d.heading.clone()
  const n0 = d.pos.clone().normalize()
  const startPos = d.pos.clone()
  const headBack = phead
    .clone()
    .negate()
    .addScaledVector(n0, phead.dot(n0))
    .normalize()
  const headFront = headBack.clone().negate()
  const half = childLen * 0.5
  const snap = (v) => v.multiplyScalar(SURFACE / (v.length() || 1))
  const backPos = snap(startPos.clone().addScaledVector(headBack, -half * MITO_NEAR))
  const frontPos = snap(startPos.clone().addScaledVector(headBack, half * MITO_NEAR))

  const back = createCell(sim, allocTailSlot(sim), backPos, headBack, childLen, d.breed)
  const front = createCell(
    sim,
    { chunk: d.tailChunk, slot: d.tailSlot },
    frontPos,
    headFront,
    childLen,
    d.breed,
  )
  back.splitting = true
  front.splitting = true
  back.tailGrow = 0
  // The front daughter owns the parent's tail slot now; the fading parent has
  // no tail of its own (its body fades, the daughter's tail grows in place).
  d.tailTransfer = true
  d.tailChunk = null
  d.tailSlot = -1
  front.mito = {
    t: 0,
    dur: MITO_TIME,
    parent,
    back,
    front,
    startPos,
    headBack,
    half,
  }
  d.splitting = true
  d.mitoParent = true
  sim.cells.push(back)
  sim.cells.push(front)
}

export function setTailColor(sim, d) {
  if (!d.color || !d.tailChunk || !d.tailChunk.mesh) return
  const mesh = d.tailChunk.mesh
  const base = d.tailSlot * TAIL_SEGMENTS
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    mesh.setColorAt(base + i, d.color)
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

function markTailRange(sim, chunk, base) {
  if (!sim.renderer) return
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

export function clearTail(sim, d) {
  const chunk = d.tailChunk
  if (!chunk || !chunk.mesh) return
  const base = d.tailSlot * TAIL_SEGMENTS
  hideTailSegments(chunk, base)
  markTailRange(sim, chunk, base)
  for (const a of chunk.attrList) a.needsUpdate = true
}

export function placeTail(sim, d) {
  const chunk = d.tailChunk
  if (!chunk || !chunk.mesh) return null
  const base = d.tailSlot * TAIL_SEGMENTS
  if (d.sideHidden) {
    hideTailSegments(chunk, base)
    markTailRange(sim, chunk, base)
    return chunk
  }
  const dirs = d.tailDirs
  // Tail length is TAIL_BODY × body length (body ≈ 2·radius), so the tail
  // scales proportionally with the cell.
  const pitch = ((TAIL_BODY * 2 * d.radius) / TAIL_SEGMENTS) * d.tailGrow
  const draw = pitch * TAIL_LINK_FILL
  const ts = sim.tailScale
  const { pos, x: ax, y: ay, scale } = chunk.attrs
  const posArr = pos.array
  const xArr = ax.array
  const yArr = ay.array
  const sArr = scale.array
  const a = sim._v1
    .copy(d.pos)
    .addScaledVector(d.heading, -(d.radius - d.width * TAIL_HINGE))
  a.setLength(SURFACE)
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const b = sim._v2.copy(a).addScaledVector(dirs[i], pitch)
    b.setLength(SURFACE)
    const x = sim._v3.subVectors(b, a).normalize()
    // The cross-section is circular, so only the segment axis matters: use the
    // outward sphere normal as the up vector (z is derived in the shader).
    const n = sim._v4.copy(a).add(b).normalize()
    const y = sim._v5.copy(n).addScaledVector(x, -n.dot(x))
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
    a.copy(b)
  }
  markTailRange(sim, chunk, base)
  return chunk
}

export function updateMito(sim, d, simDt) {
  const m = d.mito
  if (!m) return
  m.t += simDt
  const frac = THREE.MathUtils.clamp(m.t / m.dur, 0, 1)
  const fadeEnd = MITO_HOLD + MITO_FADE
  const fadeK = smoothstep(
    THREE.MathUtils.clamp((frac - MITO_HOLD) / MITO_FADE, 0, 1),
  )
  const sep = smoothstep(
    THREE.MathUtils.clamp((frac - fadeEnd) / (1 - fadeEnd), 0, 1),
  )
  const spread = MITO_NEAR + (MITO_SEP - MITO_NEAR) * sep
  const dist = m.half * spread

  const pd = m.parent
  pd.pos.copy(m.startPos)
  placeMitoChild(sim, m, m.back, -dist)
  placeMitoChild(sim, m, m.front, dist)

  m.back.tailGrow = fadeK
  m.back.drive = 0
  m.front.drive = 0

  const opac = 1 - fadeK
  pd.fade = Math.max(opac, 0)
  if (opac <= 0) {
    if (!m.fadeDone) {
      m.fadeDone = true
      removeBody(sim, pd)
      // The front daughter took over the parent's tail slot, so don't clear it.
      if (!pd.tailTransfer) clearTail(sim, pd)
    }
  }

  if (m.t >= m.dur) finalizeMito(d, m)
}

function finalizeMito(d, m) {
  d.mito = null
  m.back.splitting = false
  m.front.splitting = false
  m.back.rest = MITO_REST
  m.front.rest = MITO_REST
  m.parent.dead = true
}

function placeMitoChild(sim, m, cell, dist) {
  const d = cell
  d.pos.copy(m.startPos).addScaledVector(m.headBack, dist)
  d.pos.setLength(SURFACE)
  const n = sim._v10.copy(d.pos).normalize()
  const fwd = sim._v11
    .copy(d.heading)
    .addScaledVector(n, -d.heading.dot(n))
    .normalize()
  const right = sim._v12.crossVectors(fwd, n)
  if (right.lengthSq() < 1e-6) {
    right.set(0, 1, 0).addScaledVector(n, -n.y).normalize()
  } else {
    right.normalize()
  }
  d.quat.setFromRotationMatrix(sim._m.makeBasis(fwd, n, right))
}
