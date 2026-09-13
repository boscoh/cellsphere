import * as THREE from 'three'
import {
  P,
  SURFACE,
  MAX_CELLS,
  MIN_RADIUS,
  MAX_RADIUS,
  START_RADIUS,
  ENERGY_MAX,
  WIDTH,
  TAIL_SEGMENTS,
  TAIL_LINK,
} from './constants'
import { randomSurfacePoint, randomTangent, smoothstep } from './math'
import { addBody, removeBody, rehomeBody, setInstanceColor } from './bodyPool'
import { claimTailSlot, inheritTailSlot, setTailColor } from './tailPool'

// Cell domain: creation, growth/energy and mitosis. The body and tail instance
// pools live in bodyPool.js and tailPool.js, tail physics in tail.js.

const BREED_BLUE = 0
const BREED_RED = 1

export function computeCellColor(breed) {
  // Color is constant per breed — size already conveys growth.
  if (breed === BREED_RED) return new THREE.Color().setHSL(0.015, 0.78, 0.5)
  return new THREE.Color().setHSL(0.37, 0.5, 0.5)
}

function setCellColor(d) {
  d.color.copy(computeCellColor(d.breed))
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

const sizeF = (breed) => (breed === BREED_RED ? P.RED_SIZE : 1)

export function radiusFromEnergy(energy, breed = BREED_BLUE) {
  const f = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX) / ENERGY_MAX
  return (MIN_RADIUS + f * (MAX_RADIUS - MIN_RADIUS)) * sizeF(breed)
}

function energyFromRadius(radius, breed = BREED_BLUE) {
  const base = radius / sizeF(breed)
  const f = (base - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS)
  return THREE.MathUtils.clamp(f, 0, 1) * ENERGY_MAX
}

export function createCell(sim, pos, heading, length, breed = Math.random() < 0.5 ? BREED_BLUE : BREED_RED) {
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
    tailChunk: null,
    tailSlot: -1,
    absorbAcc: 0,
    bodyBucket: null,
    bodyChunk: null,
    bodySlot: null,
    quat: new THREE.Quaternion(),
  }
  setCellColor(d)
  addBody(sim, d, length)
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
  const d = createCell(sim, pos, heading, length, breed)
  claimTailSlot(sim, d)
  return d
}

function setSize(sim, d, energy, checkSplit) {
  const next = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX)
  const r = radiusFromEnergy(next, d.breed)
  d.energy = next
  d.mass = Math.max(r * r * 0.25, 0.05)
  if (r !== d.radius) {
    d.radius = r
    if (rehomeBody(sim, d, r)) {
      setCellColor(d)
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
  if (P.METABOLISM <= 0 && P.MOVE_COST <= 0 && P.TURN_COST <= 0 && P.PRED_METABOLISM <= 0) return
  if (d.mito || d.splitting || d.split) return
  if (d.energy > 0) {
    // Locomotion costs: swimming scales with drive (thrust), turning with the
    // heading rate normalised by P.MAX_SPIN, so effort drains energy on top of
    // the passive metabolism.
    const spin = P.MAX_SPIN > 0 ? Math.min(Math.abs(d.headingRate) / P.MAX_SPIN, 1) : 0
    // A predator with no prey latched burns P.PRED_METABOLISM on top, so reds
    // starve quickly when there is nothing to hunt.
    const pred = d.breed === BREED_RED && !d.target ? P.PRED_METABOLISM : 0
    const cost =
      P.METABOLISM + pred + P.MOVE_COST * Math.max(d.drive || 0, 0) + P.TURN_COST * spin
    drainEnergy(sim, d, cost * dt)
  }
  if (d.energy <= 0) d.dead = true
}

// A predator that is about to divide while still feeding first lets go of its
// prey and swims clear for P.MITO_DETACH seconds, so the daughters don't split
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
  if (d.detachT >= P.MITO_DETACH) {
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
  const backPos = snap(startPos.clone().addScaledVector(headBack, -half * P.MITO_NEAR))
  const frontPos = snap(startPos.clone().addScaledVector(headBack, half * P.MITO_NEAR))

  const back = createCell(sim, backPos, headBack, childLen, d.breed)
  const front = createCell(sim, frontPos, headFront, childLen, d.breed)
  claimTailSlot(sim, back)
  // The front daughter inherits the parent's slot so the tail does not jump; the
  // fading parent is left slotless.
  inheritTailSlot(sim, d, front)
  back.splitting = true
  front.splitting = true
  back.tailGrow = 0
  front.mito = {
    t: 0,
    dur: P.MITO_TIME,
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

export function updateMito(sim, d, simDt) {
  const m = d.mito
  if (!m) return
  m.t += simDt
  const frac = THREE.MathUtils.clamp(m.t / m.dur, 0, 1)
  const fadeEnd = P.MITO_HOLD + P.MITO_FADE
  const fadeK = smoothstep(
    THREE.MathUtils.clamp((frac - P.MITO_HOLD) / P.MITO_FADE, 0, 1),
  )
  const sep = smoothstep(
    THREE.MathUtils.clamp((frac - fadeEnd) / (1 - fadeEnd), 0, 1),
  )
  const spread = P.MITO_NEAR + (P.MITO_SEP - P.MITO_NEAR) * sep
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
  if (opac <= 0 && !m.fadeDone) {
    m.fadeDone = true
    removeBody(sim, pd)
    // The parent's tail slot was handed to the front daughter in mitose, so the
    // parent is already slotless and there is nothing to clear here.
  }

  if (m.t >= m.dur) finalizeMito(d, m)
}

function finalizeMito(d, m) {
  d.mito = null
  m.back.splitting = false
  m.front.splitting = false
  m.back.rest = P.MITO_REST
  m.front.rest = P.MITO_REST
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
