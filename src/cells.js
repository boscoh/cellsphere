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
  TAIL_TRAIL_RATE,
  TAIL_ARC_MAX,
  TAIL_CARRIER_RATE,
  TAIL_MOTOR_AMP,
  TAIL_DYN_SUB,
  TAIL_OSC_FREQ,
  TAIL_WAVE,
  TAIL_RUDDER_GAIN,
  TAIL_ARC,
  TAIL_HINGE,
  TAIL_DRAG_K,
  TAIL_MOTOR_K,
  TAIL_MOTOR_JOINTS,
  TAIL_BEND_K,
  TAIL_LEN_K,
  TAIL_LEN_DAMP,
  TAIL_DAMP,
  TAIL_CONTACT_D,
  TAIL_CONTACT_K,
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
    killedByPred: false,
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

export function warmTail(sim, d) {
  const S = TAIL_SEGMENTS
  const n0 = sim._v1.copy(d.pos).normalize()
  const behind = sim._v3.copy(d.heading).negate()
  behind.addScaledVector(n0, -behind.dot(n0))
  if (behind.lengthSq() < 1e-8) behind.copy(d.tailCarrier)
  else behind.normalize()
  const pitch = ((TAIL_BODY * 2 * d.radius) / TAIL_SEGMENTS) * d.tailGrow
  d.tailCarrier.copy(behind)
  const root = sim._v2.copy(d.pos).addScaledVector(d.heading, -(d.radius - d.width * TAIL_HINGE))
  root.setLength(SURFACE)
  d.tailPts[0].copy(root)
  for (let i = 1; i <= S; i++) {
    const prev = sim._v4.copy(d.tailPts[i - 1]).addScaledVector(behind, pitch)
    d.tailPts[i].copy(prev.setLength(SURFACE))
  }
  for (let i = 1; i <= S; i++) {
    d.tailVel[i].set(0, 0, 0)
    d.tailVT[i].set(0, 0, 0)
  }
  for (let i = 0; i < S; i++) {
    d.tailDirs[i].copy(d.tailPts[i + 1]).sub(d.tailPts[i])
    if (d.tailDirs[i].lengthSq() < 1e-12) d.tailDirs[i].copy(behind)
    else d.tailDirs[i].normalize()
  }
}

// Full tail update = physical control + cosmetic pose. Kept as the single
// entry point for tests/back-compat; `advance` calls the two halves directly so
// the pose can be skipped when tails are hidden.
export function updateTailState(sim, d, dt) {
  updateTailControl(sim, d, dt)
  updateTailPose(sim, d, dt)
}

// Physical control, O(1) per cell. `tailBend` is the only tail state the body
// reads, so this always runs in `advance` even while tails are hidden —
// toggling the tail display can never change motion.
export function updateTailControl(sim, d, dt) {
  const n0 = sim._v1.copy(d.pos).normalize()
  const behind = sim._v3.copy(d.heading).negate()
  behind.addScaledVector(n0, -behind.dot(n0))
  if (behind.lengthSq() < 1e-8) return
  behind.normalize()

  // Tail length is TAIL_BODY × body length (pitch scales with radius).
  const pitch = ((TAIL_BODY * 2 * d.radius) / TAIL_SEGMENTS) * d.tailGrow
  if (pitch < 1e-6 || dt <= 0) return

  // --- (B) drag axis with orientation memory -------------------------------
  // The tail streams along `carrier`, which slowly re-aims toward `behind`.
  // An abrupt rotation (e.g. collision) therefore leaves the tail pointing
  // where it was and lets it whip back instead of pivoting like a rigid rod.
  const carrier = d.tailCarrier
  const kCar = 1 - Math.exp(-TAIL_CARRIER_RATE * dt)
  carrier.multiplyScalar(1 - kCar).addScaledVector(behind, kCar)
  carrier.addScaledVector(n0, -carrier.dot(n0))
  if (carrier.lengthSq() < 1e-8) carrier.copy(behind)
  else carrier.normalize()

  const turning = Math.abs(d.headingRate) > 0.05
  if (d.drive > 0.02 || turning) d.tailPhase += dt * TAIL_OSC_FREQ

  const kTrail = 1 - Math.exp(-TAIL_TRAIL_RATE * dt)
  // tail lag: the tail arcs toward the steering command (chemotaxis) and any
  // body rotation (collisions), relaxing slowly. This trailing arc drives the
  // body's heading rate, so rotation is visibly produced by the tail.
  const lagMax = TAIL_ARC_MAX / TAIL_RUDDER_GAIN
  d.tailLag = THREE.MathUtils.clamp(
    d.tailLag + ((d.steer || 0) + d.headingRate) * dt - kTrail * d.tailLag,
    -lagMax,
    lagMax,
  )
  d.tailBend = THREE.MathUtils.clamp(
    TAIL_RUDDER_GAIN * d.tailLag,
    -TAIL_ARC_MAX,
    TAIL_ARC_MAX,
  )
}

// Cosmetic pose, O(S²·TAIL_DYN_SUB) per cell: builds the analytic guide spine
// and integrates the spring chain that `placeTail` renders. Skipped while tails
// are hidden; call `warmTail` on the hidden→visible edge to avoid a snap.
export function updateTailPose(sim, d, dt) {
  const S = TAIL_SEGMENTS
  const dirs = d.tailDirs
  const pts = d.tailPts
  const vels = d.tailVel
  const acc = d.tailVT
  const q = d.tailQ

  const n0 = sim._v1.copy(d.pos).normalize()
  const behind = sim._v3.copy(d.heading).negate()
  behind.addScaledVector(n0, -behind.dot(n0))
  if (behind.lengthSq() < 1e-8) return
  behind.normalize()

  // Tail length is TAIL_BODY × body length (pitch scales with radius).
  const pitch = ((TAIL_BODY * 2 * d.radius) / TAIL_SEGMENTS) * d.tailGrow
  if (pitch < 1e-6 || dt <= 0) return

  const carrier = d.tailCarrier
  const ramp = S > 1 ? 1 / (S - 1) : 0
  const bend = d.tailBend

  const side = sim._v5.crossVectors(n0, carrier)
  const root = sim._v2
    .copy(d.pos)
    .addScaledVector(d.heading, -(d.radius - d.width * TAIL_HINGE))
  root.setLength(SURFACE)
  pts[0].copy(root)

  // --- guide targets q[j] ---------------------------------------------------
  // A gently curved spine (trailing arc) from the root, swept about the drag
  // axis by the head motor. Joints chase it: stiff at the motor paddle, weak
  // (drag) elsewhere.
  // Whip amplitude is driven by drive (forward swimming) OR by the steering
  // bend during a turn, so the tail visibly sweeps a couple of times while
  // turning even if the cell is coasting (drive ~ 0).
  const whip =
    Math.max(
      THREE.MathUtils.clamp(d.drive, 0, 1),
      THREE.MathUtils.clamp(Math.abs(bend) * 1.5, 0, 1),
    )
  const cur = sim._v7.copy(root)
  for (let j = 0; j <= S; j++) {
    q[j].copy(cur)
    if (j < S) {
      // Phase-shifted wave: the crest travels from the root to the tip (base ->
      // tip). The trailing bend arc is optional (TAIL_ARC toggle) and adds the
      // slow drag curve.
      const ang =
        TAIL_MOTOR_AMP * whip * Math.sin(d.tailPhase - TAIL_WAVE * j) -
        TAIL_ARC * bend * j * ramp
      const cq = Math.cos(ang)
      const sq = Math.sin(ang)
      sim._v8.copy(carrier).multiplyScalar(cq).addScaledVector(side, sq)
      cur.addScaledVector(sim._v8, pitch).setLength(SURFACE)
    }
  }

  // --- damped spring-chain integration on the sphere -----------------------
  // Forces are gathered into per-joint accelerations first, then integrated, so
  // pair forces (beam, contact) act symmetrically:
  //   - guide springs: stiff at the motor paddle, weak drag elsewhere
  //   - length springs to neighbours (keep spacing = pitch)
  //   - (A) local beam: straighten curvature -> rigidity for motion, and the
  //     mechanism that stops the chain folding/collapsing
  //   - (C) self-avoidance: non-adjacent joints push apart only on contact
  const h = dt / TAIL_DYN_SUB
  const damp = Math.exp(-TAIL_DAMP * h)
  const VMAX = 40
  for (let s = 0; s < TAIL_DYN_SUB; s++) {
    // 1. accumulate accelerations: guide + length springs + local beam
    for (let j = 1; j <= S; j++) {
      const pj = pts[j]
      const nj = sim._v1.copy(pj).normalize()
      const stiff = j <= TAIL_MOTOR_JOINTS ? TAIL_MOTOR_K : TAIL_DRAG_K
      let ax = stiff * (q[j].x - pj.x)
      let ay = stiff * (q[j].y - pj.y)
      let az = stiff * (q[j].z - pj.z)
      for (let off = -1; off <= 1; off += 2) {
        const k = j + off
        if (k < 0 || k > S) continue
        const pk = pts[k]
        let dx = pk.x - pj.x
        let dy = pk.y - pj.y
        let dz = pk.z - pj.z
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9
        const proj = dx * nj.x + dy * nj.y + dz * nj.z
        let ux = dx - proj * nj.x
        let uy = dy - proj * nj.y
        let uz = dz - proj * nj.z
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz)
        if (ul < 1e-9) continue
        ux /= ul
        uy /= ul
        uz /= ul
        const stretch = TAIL_LEN_K * (dist - pitch)
        ax += stretch * ux
        ay += stretch * uy
        az += stretch * uz
        const vk = vels[k]
        const rel =
          (vk.x - vels[j].x) * ux +
          (vk.y - vels[j].y) * uy +
          (vk.z - vels[j].z) * uz
        const fv = TAIL_LEN_DAMP * rel
        ax += fv * ux
        ay += fv * uy
        az += fv * uz
      }
      // (A) local beam: restoring acceleration along the discrete second
      // difference straightens any curvature in the chain
      if (j < S) {
        const pl = pts[j - 1]
        const pr = pts[j + 1]
        ax += TAIL_BEND_K * (pl.x + pr.x - 2 * pj.x)
        ay += TAIL_BEND_K * (pl.y + pr.y - 2 * pj.y)
        az += TAIL_BEND_K * (pl.z + pr.z - 2 * pj.z)
      }
      const rad = ax * nj.x + ay * nj.y + az * nj.z
      const ac = acc[j]
      ac.x = ax - rad * nj.x
      ac.y = ay - rad * nj.y
      ac.z = az - rad * nj.z
    }
    // 2. (C) self-avoidance: push non-adjacent joints apart only on contact
    for (let i = 0; i < S; i++) {
      const pi = pts[i]
      const ni = sim._v1.copy(pi).normalize()
      for (let k = i + 2; k <= S; k++) {
        const pk = pts[k]
        const dx = pk.x - pi.x
        const dy = pk.y - pi.y
        const dz = pk.z - pi.z
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const need = TAIL_CONTACT_D - dist
        if (need <= 0) continue
        const f = TAIL_CONTACT_K * need
        const projI = dx * ni.x + dy * ni.y + dz * ni.z
        const ux = dx - projI * ni.x
        const uy = dy - projI * ni.y
        const uz = dz - projI * ni.z
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz)
        if (ul > 1e-9) {
          const sc = f / ul
          if (i > 0) {
            acc[i].x -= ux * sc
            acc[i].y -= uy * sc
            acc[i].z -= uz * sc
          }
        }
        const nk = sim._v1.copy(pk).normalize()
        const projK = -(dx * nk.x + dy * nk.y + dz * nk.z)
        const wx = -dx - projK * nk.x
        const wy = -dy - projK * nk.y
        const wz = -dz - projK * nk.z
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz)
        if (wl > 1e-9) {
          const sc = f / wl
          acc[k].x += wx * sc
          acc[k].y += wy * sc
          acc[k].z += wz * sc
        }
      }
    }
    // 3. integrate accelerations into velocities/positions (tangent, clamped)
    for (let j = 1; j <= S; j++) {
      const nj = sim._v1.copy(pts[j]).normalize()
      const ac = acc[j]
      let vx = (vels[j].x + ac.x * h) * damp
      let vy = (vels[j].y + ac.y * h) * damp
      let vz = (vels[j].z + ac.z * h) * damp
      const rad = vx * nj.x + vy * nj.y + vz * nj.z
      vx -= rad * nj.x
      vy -= rad * nj.y
      vz -= rad * nj.z
      const vl = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (vl > VMAX) {
        const sc = VMAX / vl
        vx *= sc
        vy *= sc
        vz *= sc
      }
      vels[j].x = vx
      vels[j].y = vy
      vels[j].z = vz
      pts[j].x += vx * h
      pts[j].y += vy * h
      pts[j].z += vz * h
      pts[j].setLength(SURFACE)
    }
  }

  // store segment tangents for the instanced rendering
  for (let i = 0; i < S; i++) {
    dirs[i].copy(pts[i + 1]).sub(pts[i])
    if (dirs[i].lengthSq() < 1e-12) dirs[i].copy(behind)
    else dirs[i].normalize()
  }
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
  placeMitoChild(m, m.back, -dist)
  placeMitoChild(m, m.front, dist)

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

  if (m.t >= m.dur) {
    finalizeMito(d, m)
    // One parent becomes two daughters = one net birth for the rate estimate.
    if (d.breed === BREED_BLUE) sim.events.preyBirths++
    else sim.events.predBirths++
  }
}

function finalizeMito(d, m) {
  d.mito = null
  m.back.splitting = false
  m.front.splitting = false
  m.back.rest = MITO_REST
  m.front.rest = MITO_REST
  m.parent.dead = true
}

function placeMitoChild(m, cell, dist) {
  const d = cell
  d.pos.copy(m.startPos).addScaledVector(m.headBack, dist)
  d.pos.setLength(SURFACE)
  const n = d.pos.clone().normalize()
  const fwd = d.heading.clone().addScaledVector(n, -d.heading.dot(n)).normalize()
  const right = new THREE.Vector3().crossVectors(fwd, n)
  if (right.lengthSq() < 1e-6) {
    right.set(0, 1, 0).addScaledVector(n, -n.y).normalize()
  } else {
    right.normalize()
  }
  const mtx = new THREE.Matrix4().makeBasis(fwd, n, right)
  d.quat.setFromRotationMatrix(mtx)
}
