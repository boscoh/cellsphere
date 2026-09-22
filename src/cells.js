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
} from './constants.js'
import { randomSurfacePoint, randomTangent, smoothstep } from './math.js'

// Cell domain: creation, growth/energy and mitosis. The body and tail instance
// pools live in bodyPool.js and tailPool.js, tail physics in tail.js.

const BREED_GREEN = 0
const BREED_RED = 1

// The mitosis daughters' drift-apart completes in 1/MITO_DRIFT_FOLD of its
// previous share of the mitosis window, and travels 1/MITO_DRIFT_FOLD as far.
const MITO_DRIFT_FOLD = 4

// The assembly aura: ramps in over AURA_RAMP seconds while a bite is applied,
// holds for AURA_HOLD after the last bite, then ramps out. Driven by sim time
// (`sim.simTime`), so the value is independent of frame rate and substep order.
const AURA_RAMP = 0.5
const AURA_HOLD = 0.3

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

export function radiusFromEnergy(energy, breed = BREED_GREEN) {
  const f = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX) / ENERGY_MAX
  return (MIN_RADIUS + f * (MAX_RADIUS - MIN_RADIUS)) * sizeF(breed)
}

function energyFromRadius(radius, breed = BREED_GREEN) {
  const base = radius / sizeF(breed)
  const f = (base - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS)
  return THREE.MathUtils.clamp(f, 0, 1) * ENERGY_MAX
}

export function createCell(sim, pos, heading, length, breed = Math.random() < 0.5 ? BREED_GREEN : BREED_RED) {
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
    // Alternating-gait state (cell-d4z), written by gait.js. Inert while
    // P.GAIT_MODE is 0.
    gait: 0,
    gaitT: 0,
    gaitMode: 0,
    gaitForced: false,
    gaitTurnDir: 1,
    foodDir: new THREE.Vector3(),
    foodAmt: 0,
    foodPeak: 0,
    preyDir: new THREE.Vector3(),
    preyNearestDir: new THREE.Vector3(),
    preyAmt: 0,
    preyNear: Infinity,
    reorientT: 0,
    headingRate: 0,
    drive: 0,
    paralysed: false,
    target: null,
    detach: false,
    detachT: 0,
    detachFrom: null,
    split: false,
    splitPending: false,
    asm: null,
    mitoExposed: false,
    aura: 0,
    dead: false,
    sideHidden: false,
    tailGrow: 1,
    fade: 1,
    rest: 0,
    forageT: 0,
    tailChunk: null,
    tailSlot: -1,
    // Render-written slot state. `noTail` marks a fading mitosis parent that must
    // not be given a new tail, and `tailHeir` asks the next render sync to hand
    // this cell's tail slot to a daughter. Physics never reads either.
    noTail: false,
    tailHeir: null,
    absorbAcc: 0,
    bodyBucket: null,
    bodyChunk: null,
    bodySlot: null,
    quat: new THREE.Quaternion(),
  }
  setCellColor(d)
  return d
}

export function makeCell(sim, breed) {
  if (breed === undefined) {
    breed = Math.random() < 0.5 ? BREED_GREEN : BREED_RED
  }
  const length = (START_RADIUS + Math.random() * 0.04) * sizeF(breed)
  const pos = randomSurfacePoint()
  const normal = pos.clone().normalize()
  const heading = randomTangent(normal)
  const d = createCell(sim, pos, heading, length, breed)
  return d
}

function setSize(sim, d, energy, checkSplit) {
  const next = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX)
  const r = radiusFromEnergy(next, d.breed)
  d.energy = next
  d.mass = Math.max(r * r * 0.25, 0.05)
  if (r !== d.radius) d.radius = r
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
  if (d.asm !== null || d.split) return
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

// The division ledger (NOTES 1.9 D). `L0 = parent.radius * 2` is the length
// handed over, captured at mitose. Shipped placement creates both daughters at
// `L0/4` and freezes the mother at `L0/2`, so
//     parent.radius + back.radius + front.radius === L0
// at every substep: the three lengths sum to a constant. The one creation term
// is the daughters' shared floor — two daughters at 0.25 energy sum to 0.5
// where the mother held 1.0, so the fill destroyed equals the floor created,
// `MIN_RADIUS/(MAX_RADIUS-MIN_RADIUS)` = 0.5 of `ENERGY_MAX`, the same charge a
// world-build cell pays appearing at `START_RADIUS`. `m.h` records how far the
// handover has run; when the daughters grow continuously (§D's separate change)
// the same identity holds with the mother at `L0/2*(1-h)` and each daughter at
// `L0/4*h`.
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
  // The front daughter inherits the parent's tail slot at the next render sync
  // so the tail does not jump; the fading parent is left slotless.
  front.tailHeir = d
  d.noTail = true
  const asm = {
    parent: d,
    back,
    front,
    t: 0,
    dur: P.MITO_TIME,
    L0: d.radius * 2,
    h: 0,
    startPos,
    headBack,
    half,
    aura: 0,
    state: 'dividing',
    aura: 0,
    bittenT: -Infinity,
    taken: 0,
  }
  back.asm = asm
  front.asm = asm
  d.asm = asm
  back.tailGrow = 0
  sim.assemblies.push(asm)
  sim.cells.push(back)
  sim.cells.push(front)
}

// True only for the mother of an in-flight (or just-released) assembly. The dead
// sweep reads it to suppress the ordinary death burst: a division replaces the
// mother with her daughters, it does not kill her.
export function isAssemblyParent(d) {
  return d.asm !== null && d.asm.parent === d
}

export function updateAssemblies(sim, simDt) {
  const list = sim.assemblies
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    m.t += simDt
    const frac = THREE.MathUtils.clamp(m.t / m.dur, 0, 1)
    const fadeEnd = P.MITO_HOLD + P.MITO_FADE
    const fadeK = smoothstep(
      THREE.MathUtils.clamp((frac - P.MITO_HOLD) / P.MITO_FADE, 0, 1),
    )
    // The drift-apart is MITO_DRIFT_FOLD x quicker than the fade-relative window
    // it used to take; the matching shorter travel is in MITO_SEP (MITO_NEAR kept).
    const sepSpan = (1 - fadeEnd) / MITO_DRIFT_FOLD
    const sep = smoothstep(
      THREE.MathUtils.clamp((frac - (1 - sepSpan)) / sepSpan, 0, 1),
    )
    const spread = P.MITO_NEAR + (P.MITO_SEP - P.MITO_NEAR) * sep
    const dist = m.half * spread

    const pd = m.parent
    pd.pos.copy(m.startPos)
    placeMitoChild(sim, m, m.back, -dist)
    placeMitoChild(sim, m, m.front, dist)

    m.h = fadeK
    m.parent.mitoExposed = m.t / m.dur >= P.MITO_VULN_FRAC
    // The aura ramps in while a predator is biting the unit and out once the
    // bites stop; every member carries the unit's value, because the read is
    // "the whole assembly is being eaten". Cleared at release.
    const sinceBite = m.t - m.bittenT
    const auraTarget = sinceBite < AURA_HOLD ? 1 : 0
    const auraStep = simDt / AURA_RAMP
    m.aura =
      auraTarget > m.aura
        ? Math.min(auraTarget, m.aura + auraStep)
        : Math.max(auraTarget, m.aura - auraStep)
    const aura = P.MITO_AURA > 0 ? m.aura : 0
    m.parent.aura = aura
    m.back.aura = aura
    m.front.aura = aura
    m.back.tailGrow = fadeK
    m.back.drive = 0
    m.front.drive = 0

    // The ledger handover: the mother's scheduled energy leaves her for the
    // daughters as `h` runs 0..1, and a predator's drain (`m.taken`) comes off
    // her share first. Length, radius, mass and tail pitch all follow, so `fade`
    // is retired — nothing writes a display scale. The daughters are born at
    // their floor (energy 0 -> MIN_RADIUS) and grow to their inheritance.
    const scheduled = ENERGY_MAX * (1 - m.h)
    const motherEnergy = Math.max(0, scheduled - m.taken)
    const emptied = m.taken > 0 && motherEnergy <= 0
    setSize(sim, m.parent, motherEnergy, false)
    const perDaughter = Math.max(0, ENERGY_MAX * 0.25 - 0.5 * m.taken) * (emptied ? 1 : m.h)
    setSize(sim, m.back, perDaughter, false)
    setSize(sim, m.front, perDaughter, false)
    // The unit's collision envelope: the union of the three capsules, centred on
    // the frozen mother and reaching the far cap of each daughter. It keeps the
    // unit deflecting as one body after the mother's own length hits the floor.
    m.parent.proxyR = m.parent.width + dist + m.back.radius
    if (m.t >= m.dur || emptied) {
      assemblyRelease(m, emptied)
      list.splice(i, 1)
    }
  }
}

function assemblyRelease(m, emptied) {
  m.state = 'released'
  m.parent.mealBurst = emptied
  m.parent.proxyR = undefined
  m.parent.aura = 0
  m.back.aura = 0
  m.front.aura = 0
  // The daughters drop the pointer at release so it cannot keep them in the
  // mitosis window (food-blind, metabolism-exempt) for life. The mother keeps
  // hers: she is dead and spliced out in the same substep, and the dead sweep
  // reads `isAssemblyParent` to suppress the ordinary death burst.
  m.back.asm = null
  m.front.asm = null
  m.back.rest = P.MITO_REST
  m.front.rest = P.MITO_REST
  m.back.forageT = P.MITO_FORAGE
  m.front.forageT = P.MITO_FORAGE
  // The sisters are born facing each other (each tail streams outward, so the
  // heading must point inward), so while they coast through MITO_REST they turn
  // away from each other rather than driving head-on the moment drive resumes
  // (cell-jyg). Cleared when they part, and read only while `rest > 0`.
  m.back.sibling = m.front
  m.front.sibling = m.back
  m.parent.dead = true
}

// Remove up to `amount` from the assembly's scheduled energy and return what was
// actually removed. The mother's budget is `ENERGY_MAX * (1 - m.h)` (the handover
// schedule); a drain accrues in `m.taken` and the handover subtracts it, so the
// mother's energy is always a pure read and two reds cannot drain past her pool.
export function assemblyDrain(asm, amount) {
  if (amount <= 0) return 0
  const available = Math.max(0, ENERGY_MAX * (1 - asm.h) - asm.taken)
  const taken = Math.min(amount, available)
  if (taken > 0) asm.taken += taken
  return taken
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
