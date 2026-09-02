import * as THREE from 'three'
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

function bodyGeoFor(length) {
  const bucket = Math.round(length / GEO_STEP)
  let geo = bodyGeoCache.get(bucket)
  if (!geo) {
    geo = makeBodyGeo(length)
    bodyGeoCache.set(bucket, geo)
  }
  return geo
}

export function disposeBodyGeos() {
  for (const geo of bodyGeoCache.values()) geo.dispose()
  bodyGeoCache.clear()
}

function computeCellColor(length) {
  const t = THREE.MathUtils.clamp(
    (length - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS),
    0,
    1,
  )
  const color = new THREE.Color().setHSL(0.55 - t * 0.32, 0.55 + t * 0.4, 0.62)
  const emissive = color.clone().multiplyScalar(0.25 + t * 0.4)
  return { color, emissive }
}

function applyCellColor(cell, color) {
  const u = cell.userData
  u.color.copy(color)
  u.outer.material.color.copy(color)
}

function updateGeometry(cell, length) {
  const u = cell.userData
  u.radius = length
  u.mass = Math.max(length * length * 0.25, 0.05)
  u.outer.geometry = bodyGeoFor(length)
}

function updateColor(cell, length) {
  const { color } = computeCellColor(length)
  applyCellColor(cell, color)
  cell.userData.nucleusColorDirty = true
}

function setCellAppearance(cell, length) {
  updateGeometry(cell, length)
  updateColor(cell, length)
}

function placeMitoChild(m, cell, dist) {
  const d = cell.userData
  d.pos.copy(m.startPos).addScaledVector(m.headBack, dist)
  d.pos.setLength(SURFACE)
  cell.position.copy(d.pos)
  const n = d.pos.clone().normalize()
  const fwd = d.heading.clone().addScaledVector(n, -d.heading.dot(n)).normalize()
  const right = new THREE.Vector3().crossVectors(fwd, n)
  if (right.lengthSq() < 1e-6) {
    right.set(0, 1, 0).addScaledVector(n, -n.y).normalize()
  } else {
    right.normalize()
  }
  const mtx = new THREE.Matrix4().makeBasis(fwd, n, right)
  cell.quaternion.setFromRotationMatrix(mtx)
}

export function disposeObject3D(obj) {
  obj.traverse((o) => {
    if (o.material) {
      Array.isArray(o.material)
        ? o.material.forEach((m) => m.dispose())
        : o.material.dispose()
    }
  })
}

export function allocTailIndex(sim) {
  if (sim.freeTailIndices.length) return sim.freeTailIndices.pop()
  const idx = sim.nextTailIndex
  sim.nextTailIndex = Math.min(sim.nextTailIndex + 1, MAX_CELLS)
  return idx
}

export function createCell(index, pos, heading, length) {
  const outer = new THREE.Mesh(
    bodyGeoFor(length),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.25,
      metalness: 0,
      transparent: true,
      opacity: 0.9,
    }),
  )

  const group = new THREE.Group()
  group.add(outer)

  group.userData = {
    radius: length,
    maxLength: length * 2,
    mass: length * length * 0.25,
    color: new THREE.Color(),
    nucleusColorDirty: true,
    pos,
    vel: heading.clone().multiplyScalar(0.3),
    heading,
    tailDir: heading.clone().negate().normalize(),
    phase: Math.random() * Math.PI * 2,
    slow: 1,
    agitate: 0,
    whipT: 99,
    goPrev: 1,
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
    index,
    tailStart: index * TAIL_SEGMENTS,
  }
  group.userData.outer = outer
  setCellAppearance(group, length)
  return group
}

export function makeCell(sim) {
  const length = START_RADIUS + Math.random() * 0.04
  const pos = randomSurfacePoint()
  const normal = pos.clone().normalize()
  const heading = randomTangent(normal)
  return createCell(allocTailIndex(sim), pos, heading, length)
}

export function growCell(cell, amount) {
  const d = cell.userData
  const next = Math.min(d.radius + amount, d.maxLength)
  setCellAppearance(cell, next)
  if (next >= d.maxLength - 1e-6) d.split = true
}

export function mitose(sim, parent) {
  if (sim.cells.length + 2 > MAX_CELLS) return
  const d = parent.userData
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

  const back = createCell(allocTailIndex(sim), backPos, headBack, childLen)
  const front = createCell(d.index, frontPos, headFront, childLen)
  back.userData.splitting = true
  front.userData.splitting = true
  back.userData.tailGrow = 0
  d.tailTransfer = true
  front.userData.mito = {
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

export function updateNuclei(sim) {
  const mesh = sim.nucleusMesh
  if (!mesh) return
  let colorDirty = false
  for (const cell of sim.cells) {
    const d = cell.userData
    const nscale = sim._v6.set(d.radius * 0.62, WIDTH * 0.5, WIDTH * 0.5)
    if (d.sideHidden) nscale.set(0, 0, 0)
    sim._m.compose(cell.position, cell.quaternion, nscale)
    mesh.setMatrixAt(d.index, sim._m)
    if (d.nucleusColorDirty) {
      mesh.setColorAt(d.index, d.color)
      d.nucleusColorDirty = false
      colorDirty = true
    }
  }
  mesh.instanceMatrix.needsUpdate = true
  if (colorDirty) mesh.instanceColor.needsUpdate = true
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
  pd.nucleus.material.transparent = true
  pd.nucleus.material.depthWrite = false
  pd.nucleus.material.needsUpdate = true
  pd.nucleus.material.opacity = 1 - fadeK

  if (m.t >= m.dur) finalizeMito(cell, m)
}

function finalizeMito(cell, m) {
  cell.userData.mito = null
  m.back.userData.splitting = false
  m.front.userData.splitting = false
  m.parent.userData.dead = true
}
