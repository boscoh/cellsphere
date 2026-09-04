import * as THREE from 'three'
import {
  SURFACE,
  MAX_CELLS,
  MIN_RADIUS,
  MAX_RADIUS,
  START_RADIUS,
  ENERGY_MAX,
  METABOLISM,
  MITO_TIME,
  MITO_HOLD,
  MITO_FADE,
  MITO_NEAR,
  MITO_SEP,
  MITO_REST,
  MITO_SLOW_FRAC,
  WIDTH,
  TAIL_SEGMENTS,
  TAIL_LINK,
  TAIL_LINK_FILL,
  TAIL_TRAIL_RATE,
  TAIL_ARC_MAX,
  TAIL_CARRIER_RATE,
  TAIL_DRAG_K,
  TAIL_BEND_K,
  TAIL_CONTACT_D,
  TAIL_CONTACT_K,
  TAIL_MOTOR_AMP,
  TAIL_MOTOR_K,
  TAIL_MOTOR_JOINTS,
  TAIL_OSC_FREQ,
  TAIL_RUDDER_GAIN,
  TAIL_DYN_SUB,
  TAIL_LEN_K,
  TAIL_LEN_DAMP,
  TAIL_DAMP,
} from './constants'
import { randomSurfacePoint, randomTangent, smoothstep } from './math'
import { bodyMat } from './materials'

const GEO_STEP = 0.01
const POOL_CAP = MAX_CELLS
const BREED_BLUE = 0
const BREED_RED = 1
const STARVE_FADE = 1.5
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

function computeCellColor(breed) {
  // Color is constant per breed — size already conveys growth, and the
  // mitosis aura signals readiness. `length` is no longer a color driver.
  if (breed === BREED_RED) return new THREE.Color().setHSL(0.015, 0.78, 0.5)
  return new THREE.Color().setHSL(0.59, 0.62, 0.52)
}

function setCellColor(d) {
  d.color.copy(computeCellColor(d.breed))
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
    // Instances span the whole shell and change size every frame, so the cached
    // bounding sphere is never accurate; culling would drop visible bodies on
    // close zoom. Bodies are never culled (see render.js 'cull' comment).
    entry.mesh.frustumCulled = false
    entry.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    entry.mesh.instanceMatrix.needsUpdate = true
    const opacity = new THREE.InstancedBufferAttribute(
      new Float32Array(POOL_CAP).fill(1),
      1,
    )
    opacity.setUsage(THREE.DynamicDrawUsage)
    entry.mesh.geometry.setAttribute('instanceOpacity', opacity)
    entry.opacity = opacity
    const mito = new THREE.InstancedBufferAttribute(
      new Float32Array(POOL_CAP).fill(0),
      1,
    )
    mito.setUsage(THREE.DynamicDrawUsage)
    entry.mesh.geometry.setAttribute('instanceMito', mito)
    entry.mito = mito
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
  if (entry.mito) entry.mito.setX(slot, 0)
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
    const sc = d.fade >= 1 ? sim._one : sim._v9.set(d.fade, d.fade, d.fade)
    sim._m.compose(d.pos, d.quat, sc)
    mesh.setMatrixAt(d.bodySlot, sim._m)
    mesh.instanceMatrix.needsUpdate = true
    // Aura: ramp 0->1 as the cell climbs toward mitosis (energy beyond
    // MITO_SLOW_FRAC), so a full cell glows before it divides.
    if (entry.mito) {
      const frac = THREE.MathUtils.clamp(d.energy / ENERGY_MAX, 0, 1)
      const ready = smoothstep(
        THREE.MathUtils.clamp(
          (frac - MITO_SLOW_FRAC) / (1 - MITO_SLOW_FRAC),
          0,
          1,
        ),
      )
      entry.mito.setX(d.bodySlot, ready)
      entry.mito.needsUpdate = true
    }
  }
}

export function disposeBodyPools(sim) {
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

export function radiusFromEnergy(energy) {
  const f = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX) / ENERGY_MAX
  return MIN_RADIUS + f * (MAX_RADIUS - MIN_RADIUS)
}

export function energyFromRadius(radius) {
  const f = (radius - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS)
  return THREE.MathUtils.clamp(f, 0, 1) * ENERGY_MAX
}

export function createCell(sim, index, pos, heading, length, breed = Math.random() < 0.5 ? BREED_BLUE : BREED_RED) {
  const chain = makeTailChain(pos, heading, length)
  const d = {
    radius: length,
    energy: energyFromRadius(length),
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
    tailPhase: 0,
    slow: 1,
    foodDir: new THREE.Vector3(),
    foodAmt: 0,
    foodPeak: 0,
    headingRate: 0,
    drive: 0,
    split: false,
    splitPending: false,
    mito: null,
    splitting: false,
    dead: false,
    dying: false,
    starveT: 0,
    sideHidden: false,
    tailGrow: 1,
    fade: 1,
    rest: 0,
    index,
    absorbAcc: 0,
    tailStart: index * TAIL_SEGMENTS,
    bodyBucket: null,
    bodySlot: null,
    quat: new THREE.Quaternion(),
  }
  setCellColor(d)
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

function setSize(sim, d, energy, checkSplit) {
  const next = THREE.MathUtils.clamp(energy, 0, ENERGY_MAX)
  const r = radiusFromEnergy(next)
  d.energy = next
  d.mass = Math.max(r * r * 0.25, 0.05)
  if (r !== d.radius) {
    d.radius = r
    const nb = bodyBucket(r)
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
  if (d.dying) {
    d.dying = false
    d.starveT = 0
    d.tailGrow = 1
    setBodyOpacity(sim, d, 1)
  }
}

export function drainEnergy(sim, d, amount) {
  setSize(sim, d, d.energy - amount, false)
}

export function updateEnergy(sim, d, dt) {
  if (METABOLISM <= 0) return
  if (d.mito || d.splitting || d.split) return
  if (d.energy > 0) drainEnergy(sim, d, METABOLISM * dt)
  if (d.energy <= 0 && !d.dying) {
    d.dying = true
    d.starveT = 0
  }
}

export function updateStarvation(sim, d, dt) {
  if (d.dying) {
    d.starveT += dt
    const k = Math.min(d.starveT / STARVE_FADE, 1)
    d.tailGrow = 1 - k
    if (k >= 1) {
      d.dead = true
      return
    }
    setBodyOpacity(sim, d, 1 - k)
    return
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
    childLen,
    parentR: d.radius,
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

  const pitch = TAIL_LINK * d.tailGrow
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

  const ramp = S > 1 ? 1 / (S - 1) : 0

  const turning = Math.abs(d.headingRate) > 0.05
  if (d.drive > 0.02 || turning) d.tailPhase += dt * TAIL_OSC_FREQ

  const kTrail = 1 - Math.exp(-TAIL_TRAIL_RATE * dt)
  // tail lag: accumulated body rotation while turning, relaxing slowly. It
  // arcs the spine behind the turn so rotation shows a trailing curvature
  // that gradually straightens. bend is hard-capped so the arc can't coil.
  const lagMax = TAIL_ARC_MAX / TAIL_RUDDER_GAIN
  d.tailLag = THREE.MathUtils.clamp(
    d.tailLag + d.headingRate * dt - kTrail * d.tailLag,
    -lagMax,
    lagMax,
  )
  const bend = THREE.MathUtils.clamp(
    TAIL_RUDDER_GAIN * d.tailLag,
    -TAIL_ARC_MAX,
    TAIL_ARC_MAX,
  )

  const side = sim._v5.crossVectors(n0, carrier)
  const root = sim._v2.copy(d.pos).addScaledVector(d.heading, -d.radius)
  root.setLength(SURFACE)
  pts[0].copy(root)

  // --- guide targets q[j] ---------------------------------------------------
  // A gently curved spine (trailing arc) from the root, swept about the drag
  // axis by the head motor. Joints chase it: stiff at the motor paddle, weak
  // (drag) elsewhere.
  const motorA =
    TAIL_MOTOR_AMP * THREE.MathUtils.clamp(d.drive, 0, 1) * Math.sin(d.tailPhase)
  const cur = sim._v7.copy(root)
  for (let j = 0; j <= S; j++) {
    q[j].copy(cur)
    if (j < S) {
      const ang = motorA - bend * j * ramp
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
      clearTail(sim, pd)
    }
  }

  if (m.t >= m.dur) {
    finalizeMito(d, m)
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
