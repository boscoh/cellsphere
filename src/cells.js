import * as THREE from 'three'
import { bodyMat } from './materials'
import {
  SURFACE,
  MAX_CELLS,
  MIN_RADIUS,
  MAX_RADIUS,
  START_RADIUS,
  MITO_TIME,
  MITO_HOLD,
  MITO_FADE,
  MITO_NEAR,
  MITO_SEP,
  MITO_REST,
  WIDTH,
  TAIL_SEGMENTS,
  TAIL_LEN,
  TAIL_AMP,
  TAIL_FREQ,
  TAIL_WAVE,
  TAIL_LAG_RATE,
  TAIL_HELIX,
  AGITATE_UP,
  AGITATE_DOWN,
  GO_THRESH,
  WHIP_GAIN,
  WHIP_TAU,
} from './constants'
import { randomSurfacePoint, randomTangent, smoothstep } from './math'

const GEO_STEP = 0.01
const bodyGeoCache = new Map()

export function makeBodyGeo(length) {
  const cylLen = Math.max(2 * (length - WIDTH), 0.001)
  const geo = new THREE.CapsuleGeometry(WIDTH, cylLen, 6, 12)
  geo.rotateZ(Math.PI / 2)
  return geo
}

export function bodyGeoFor(length) {
  const bucket = Math.round(length / GEO_STEP)
  let geo = bodyGeoCache.get(bucket)
  if (!geo) {
    geo = makeBodyGeo(length)
    bodyGeoCache.set(bucket, geo)
  }
  return geo
}

export function bodyBucket(length) {
  return Math.round(length / GEO_STEP)
}

export function disposeBodyGeos() {
  const cache = bodyGeoCache
  for (const geo of cache.values()) geo.dispose()
  cache.clear()
}

export function initBodyPools(sim) {
  sim.bodyPools = new Map()
}

function computeCellColor(length, breed) {
  const t = THREE.MathUtils.clamp(
    (length - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS),
    0,
    1,
  )
  const s = smoothstep(t)
  if (breed === BREED_RED) {
    return new THREE.Color().setHSL(
      0.005 + t * 0.06,
      0.72 + t * 0.15,
      0.34 + 0.4 * s,
    )
  }
  return new THREE.Color().setHSL(
    0.56 + t * 0.08,
    0.55 + t * 0.4,
    0.34 + 0.46 * s,
  )
}

function setCellColor(d, length) {
  d.color.copy(computeCellColor(length, d.breed))
}

function getPool(sim, length) {
  const bucket = bodyBucket(length)
  let entry = sim.bodyPools.get(bucket)
  if (!entry) {
    entry = { bucket, mesh: null, free: [], live: 0, count: 0 }
    sim.bodyPools.set(bucket, entry)
  }
  if (!entry.mesh) {
    const geo = bodyGeoFor(length)
    entry.mesh = new THREE.InstancedMesh(geo, bodyMat, POOL_CAP)
    entry.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    entry.mesh.instanceMatrix.needsUpdate = true
    const opacity = new THREE.InstancedBufferAttribute(
      new Float32Array(POOL_CAP).fill(1),
      1,
    )
    opacity.setUsage(THREE.DynamicDrawUsage)
    entry.mesh.geometry.setAttribute('instanceOpacity', opacity)
    entry.opacity = opacity
    sim.scene.add(entry.mesh)
  }
  return entry
}

export function zeroMatrix(sim, mesh, slot) {
  const o = sim._dummy
  o.position.set(0, 0, 0)
  o.rotation.set(0, 0, 0)
  o.scale.set(0, 0, 0)
  o.updateMatrix()
  mesh.setMatrixAt(slot, o.matrix)
}

export function addBody(sim, d, length) {
  const entry = getPool(sim, length)
  const bucket = entry.bucket
  const slot = entry.free.length ? entry.free.pop() : entry.count++
  entry.live++
  entry.mesh.count = entry.count
  d.bodyBucket = bucket
  d.bodySlot = slot
  if (entry.opacity) entry.opacity.setX(slot, 1)
  setBodyColor(sim, d, d.color)
  entry.mesh.instanceMatrix.needsUpdate = true
}

export function setBodyColor(sim, d, color) {
  if (d.bodyBucket == null) return
  const entry = sim.bodyPools.get(d.bodyBucket)
  if (!entry || !entry.mesh) return
  entry.mesh.setColorAt(d.bodySlot, color)
  if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true
}

export function setInstanceColor(sim, d) {
  setBodyColor(sim, d, d.color)
}

export function setBodyOpacity(sim, d, opacity) {
  if (d.bodyBucket == null) return
  const entry = sim.bodyPools.get(d.bodyBucket)
  if (!entry || !entry.mesh || !entry.opacity) return
  entry.opacity.setX(d.bodySlot, opacity)
  entry.opacity.needsUpdate = true
}

export function removeBody(sim, d) {
  if (d.bodyBucket == null) return
  const entry = sim.bodyPools.get(d.bodyBucket)
  if (entry && entry.mesh) {
    zeroMatrix(sim, entry.mesh, d.bodySlot)
    entry.free.push(d.bodySlot)
    entry.live--
    if (entry.live === 0) {
      sim.scene.remove(entry.mesh)
      entry.mesh = null
      entry.free = []
      entry.count = 0
    } else {
      entry.mesh.instanceMatrix.needsUpdate = true
    }
  }
  d.bodyBucket = null
  d.bodySlot = null
}

export function rehomeBody(sim, d, newLength) {
  const nb = bodyBucket(newLength)
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
    const entry = sim.bodyPools.get(d.bodyBucket)
    if (!entry || !entry.mesh) continue
    const mesh = entry.mesh
    if (d.sideHidden) {
      zeroMatrix(sim, mesh, d.bodySlot)
    } else {
      sim._m.compose(d.pos, d.quat, sim._one)
      mesh.setMatrixAt(d.bodySlot, sim._m)
    }
    mesh.instanceMatrix.needsUpdate = true
  }
}

export function disposeBodyPools(sim) {
  activeFades = 0
  bodyMat.depthWrite = true
  for (const entry of sim.bodyPools.values()) {
    if (entry.mesh) {
      sim.scene.remove(entry.mesh)
      entry.mesh.dispose()
      entry.mesh = null
    }
  }
  sim.bodyPools.clear()
}

export function allocTailIndex(sim) {
  if (sim.freeTailIndices.length) return sim.freeTailIndices.pop()
  const idx = sim.nextTailIndex
  sim.nextTailIndex = Math.min(sim.nextTailIndex + 1, MAX_CELLS)
  return idx
}

function makeTailDirs(heading) {
  const back = heading.clone().negate().normalize()
  const dirs = []
  for (let i = 0; i < TAIL_SEGMENTS; i++) dirs.push(back.clone())
  return dirs
}

export function createCell(sim, index, pos, heading, length, breed = Math.random() < 0.5 ? BREED_BLUE : BREED_RED) {
  const d = {
    radius: length,
    maxLength: length * 2,
    mass: length * length * 0.25,
    color: new THREE.Color(),
    breed,
    pos,
    vel: heading.clone().multiplyScalar(0.3),
    heading,
    tailDirs: makeTailDirs(heading),
    tailPhase: 0,
    slow: 1,
    foodDir: new THREE.Vector3(),
    foodAmt: 0,
    foodPeak: 0,
    headingRate: 0,
    drive: 0,
    split: false,
    mito: null,
    splitting: false,
    dead: false,
    sideHidden: false,
    tailGrow: 1,
    rest: 0,
    index,
    tailStart: index * TAIL_SEGMENTS,
    bodyBucket: null,
    bodySlot: null,
    quat: new THREE.Quaternion(),
  }
  setCellColor(d, length)
  addBody(sim, d, length)
  setTailColor(sim, d)
  return d
}

export function makeCell(sim) {
  const length = START_RADIUS + Math.random() * 0.04
  const pos = randomSurfacePoint()
  const normal = pos.clone().normalize()
  const heading = randomTangent(normal)
  return createCell(sim, allocTailIndex(sim), pos, heading, length)
}

export function growCell(sim, cell, amount) {
  const d = cell
  const next = Math.min(d.radius + amount, d.maxLength)
  d.radius = next
  d.mass = Math.max(next * next * 0.25, 0.05)
  setCellColor(d, next)
  rehomeBody(sim, d, next)
  setInstanceColor(sim, d)
  setTailColor(sim, d)
  if (next >= d.maxLength - 1e-6) d.split = true
}

export function mitose(sim, parent) {
  if (sim.cells.length + 2 > MAX_CELLS) return
  const d = parent
  d.split = false
  const fullLen = d.radius
  const childLen = fullLen * 0.45
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

  const back = createCell(sim, allocTailIndex(sim), backPos, headBack, childLen, d.breed)
  const front = createCell(sim, d.index, frontPos, headFront, childLen, d.breed)
  back.splitting = true
  front.splitting = true
  back.tailGrow = 0
  d.tailTransfer = true
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
  setTailColor(sim, back)
  setTailColor(sim, front)
  sim.cells.push(back)
  sim.cells.push(front)
  sim.scene.add(back)
  sim.scene.add(front)
}

export function setTailColor(sim, cell) {
  const d = cell.userData
  if (!sim.tailMesh || !d.color) return
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    sim.tailMesh.setColorAt(d.tailStart + i, d.color)
  }
  if (sim.tailMesh.instanceColor) {
    sim.tailMesh.instanceColor.needsUpdate = true
  }
}

export function clearTail(sim, cell) {
  const d = cell.userData
  sim._dummy.position.set(0, 0, 0)
  sim._dummy.rotation.set(0, 0, 0)
  sim._dummy.scale.set(0, 0, 0)
  sim._dummy.updateMatrix()
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    sim.tailMesh.setMatrixAt(d.tailStart + i, sim._dummy.matrix)
  }
}

export function placeTail(sim, cell) {
  const d = cell.userData
  if (d.sideHidden) {
    clearTail(sim, cell)
    return
  }
  const grow = d.tailGrow
  const step = TAIL_LEN / TAIL_SEGMENTS
  const n = sim._v1.copy(d.pos).normalize()
  const base = sim._v2.copy(d.pos).addScaledVector(d.heading, -d.radius)
  const tailDir = d.tailDir
  const side = sim._v3.crossVectors(n, tailDir)
  if (side.lengthSq() < 1e-8) {
    side.set(0, 0, 1).addScaledVector(n, -n.z).normalize()
  } else {
    side.normalize()
  }
  const up = sim._v4.crossVectors(tailDir, side).normalize()
  const whip = Math.exp(-d.whipT / WHIP_TAU)
  const amp =
    TAIL_AMP * Math.max(d.agitate, 0.1) * (1 + WHIP_GAIN * whip) * grow
  const freq = TAIL_FREQ * (0.3 + 0.7 * d.agitate)
  const helix = TAIL_HELIX * smoothstep(d.agitate)
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const dist = i * step * grow
    const t = i / TAIL_SEGMENTS
    const taper = t * t
    const ph = sim.simTime * freq + dist * TAIL_WAVE + d.phase
    const a = Math.sin(ph) * amp * taper
    const b = Math.cos(ph) * amp * taper * helix
    sim._dummy.position
      .copy(base)
      .addScaledVector(tailDir, dist)
      .addScaledVector(side, a)
      .addScaledVector(up, b)
    const ts = sim.tailScale
    sim._dummy.scale.set(ts, ts, ts)
    sim._dummy.rotation.set(0, 0, 0)
    sim._dummy.updateMatrix()
    sim.tailMesh.setMatrixAt(d.tailStart + i, sim._dummy.matrix)
  }
}

export function updateTailState(sim, d, dt) {
  const n = sim._v1.copy(d.pos).normalize()
  const behind = sim._v3.copy(d.heading).negate()
  behind.addScaledVector(n, -behind.dot(n))
  if (behind.lengthSq() > 1e-8) {
    behind.normalize()
    d.tailDir.addScaledVector(
      sim._v2.copy(behind).sub(d.tailDir),
      TAIL_LAG_RATE * dt,
    )
    d.tailDir.addScaledVector(n, -d.tailDir.dot(n))
    d.tailDir.normalize()
  }
  const target = d.drive
  const up = target > d.agitate
  const rate = up ? AGITATE_UP : AGITATE_DOWN
  d.agitate += (target - d.agitate) * (1 - Math.exp(-rate * dt))
  d.agitate = THREE.MathUtils.clamp(d.agitate, 0, 1)
  if (!up && d.agitate < 0.02) d.agitate = 0
  if (target > GO_THRESH && d.goPrev <= GO_THRESH) d.whipT = 0
  d.whipT += dt
  d.goPrev = target
}

export function updateMito(sim, cell, simDt) {
  const m = cell.userData.mito
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

  placeMitoChild(m, m.back, -dist)
  placeMitoChild(m, m.front, dist)

  const tailGrow = smoothstep(
    THREE.MathUtils.clamp((frac - MITO_HOLD) / MITO_FADE, 0, 1),
  )
  m.back.userData.tailGrow = tailGrow
  m.back.userData.drive = 0
  m.front.userData.drive = 0

  const pd = m.parent.userData
  pd.outer.material.depthWrite = false
  pd.outer.material.opacity = 0.75 * (1 - fadeK)

  if (m.t >= m.dur) finalizeMito(cell, m)
}

function finalizeMito(cell, m) {
  cell.userData.mito = null
  m.back.userData.splitting = false
  m.front.userData.splitting = false
  m.back.userData.rest = MITO_REST
  m.front.userData.rest = MITO_REST
  m.parent.userData.dead = true
}
