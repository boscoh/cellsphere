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
  TAIL_LINK,
  TAIL_LINK_FILL,
  TAIL_BASE_RATE,
  TAIL_JOINT_RATE,
  TAIL_OSC_FREQ,
  TAIL_OSC_AMP,
  TAIL_OSC_WAVE,
} from './constants'
import { randomSurfacePoint, randomTangent, smoothstep } from './math'
import { bodyMat } from './materials'

const GEO_STEP = 0.01
const POOL_CAP = MAX_CELLS
const BREED_BLUE = 0
const BREED_RED = 1
const bodyGeoCache = new Map()
let activeFades = 0

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
  d.mitoParent = true
  sim.cells.push(back)
  sim.cells.push(front)
}

export function setTailColor(sim, d) {
  if (!sim.tailMesh || !d.color) return
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    sim.tailMesh.setColorAt(d.tailStart + i, d.color)
  }
  if (sim.tailMesh.instanceColor) {
    sim.tailMesh.instanceColor.needsUpdate = true
  }
}

export function clearTail(sim, d) {
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    zeroMatrix(sim, sim.tailMesh, d.tailStart + i)
  }
}

export function placeTail(sim, d) {
  if (d.sideHidden) {
    clearTail(sim, d)
    return
  }
  const dirs = d.tailDirs
  const pitch = TAIL_LINK * d.tailGrow
  const draw = pitch * TAIL_LINK_FILL
  const ts = sim.tailScale
  const a = sim._v1.copy(d.pos).addScaledVector(d.heading, -d.radius)
  a.setLength(SURFACE)
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const b = sim._v2.copy(a).addScaledVector(dirs[i], pitch)
    b.setLength(SURFACE)
    const x = sim._v3.subVectors(b, a).normalize()
    const ref = Math.abs(x.x) < 0.9 ? sim._v5.set(1, 0, 0) : sim._v5.set(0, 1, 0)
    const y = sim._v4.crossVectors(x, ref).normalize()
    const z = sim._v6.crossVectors(x, y)
    sim._m.makeBasis(x, y, z)
    sim._q.setFromRotationMatrix(sim._m)
    sim._dummy.quaternion.copy(sim._q)
    sim._dummy.position.copy(a).add(b).multiplyScalar(0.5)
    sim._dummy.scale.set(draw, ts, ts)
    sim._dummy.updateMatrix()
    sim.tailMesh.setMatrixAt(d.tailStart + i, sim._dummy.matrix)
    a.copy(b)
  }
}

export function updateTailState(sim, d, dt) {
  const dirs = d.tailDirs
  const n0 = sim._v1.copy(d.pos).normalize()
  const behind = sim._v3.copy(d.heading).negate()
  behind.addScaledVector(n0, -behind.dot(n0))
  if (behind.lengthSq() < 1e-8) return
  behind.normalize()
  const k0 = 1 - Math.exp(-TAIL_BASE_RATE * dt)
  dirs[0].addScaledVector(sim._v2.copy(behind).sub(dirs[0]), k0)
  dirs[0].addScaledVector(n0, -dirs[0].dot(n0))
  if (dirs[0].lengthSq() < 1e-8) dirs[0].copy(behind)
  else dirs[0].normalize()
  const pitch = TAIL_LINK * d.tailGrow
  if (pitch < 1e-6) return
  const moving = d.drive > 0.02
  if (moving) d.tailPhase += dt * TAIL_OSC_FREQ
  const amp = TAIL_OSC_AMP * THREE.MathUtils.clamp(d.drive, 0, 1)
  const k = 1 - Math.exp(-TAIL_JOINT_RATE * dt)
  const a = sim._v2.copy(d.pos).addScaledVector(d.heading, -d.radius)
  a.setLength(SURFACE)
  for (let i = 1; i < TAIL_SEGMENTS; i++) {
    a.addScaledVector(dirs[i - 1], pitch)
    a.setLength(SURFACE)
    const na = sim._v4.copy(a).normalize()
    const t = sim._v5.copy(dirs[i - 1])
    t.addScaledVector(na, -t.dot(na))
    if (t.lengthSq() < 1e-8) {
      dirs[i].copy(dirs[i - 1])
      continue
    }
    t.normalize()
    dirs[i].addScaledVector(sim._v6.copy(t).sub(dirs[i]), k)
    dirs[i].addScaledVector(na, -dirs[i].dot(na))
    if (dirs[i].lengthSq() < 1e-8) {
      dirs[i].copy(t)
      continue
    }
    dirs[i].normalize()
    if (amp > 1e-3) {
      const th = amp * Math.sin(d.tailPhase - TAIL_OSC_WAVE * i)
      if (Math.abs(th) > 1e-4) {
        const c = Math.cos(th)
        const s = Math.sin(th)
        const cr = sim._v6.crossVectors(na, dirs[i])
        dirs[i].multiplyScalar(c).addScaledVector(cr, s)
      }
    }
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

  const tailGrow = smoothstep(
    THREE.MathUtils.clamp((frac - MITO_HOLD) / MITO_FADE, 0, 1),
  )
  m.back.tailGrow = tailGrow
  m.back.drive = 0
  m.front.drive = 0

  const opac = 1 - fadeK
  if (!m.fadeOn && opac < 1) {
    m.fadeOn = true
    activeFades++
    bodyMat.depthWrite = false
  }
  if (opac <= 0) {
    if (!m.fadeDone) {
      m.fadeDone = true
      if (m.fadeOn) {
        m.fadeOn = false
        activeFades--
        if (activeFades === 0) bodyMat.depthWrite = true
      }
      removeBody(sim, pd)
      clearTail(sim, pd)
    }
  } else {
    setBodyOpacity(sim, pd, opac)
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
