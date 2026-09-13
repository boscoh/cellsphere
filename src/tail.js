import * as THREE from 'three'
import {
  SURFACE,
  TAIL_SEGMENTS,
  TAIL_BODY,
  TAIL_HINGE,
  TAIL_TRAIL_RATE,
  TAIL_ARC_MAX,
  TAIL_CARRIER_RATE,
  TAIL_MOTOR_AMP,
  TAIL_DYN_SUB,
  TAIL_OSC_FREQ,
  TAIL_WAVE,
  TAIL_RUDDER_GAIN,
  TAIL_ARC,
  TAIL_DRAG_K,
  TAIL_MOTOR_K,
  TAIL_MOTOR_JOINTS,
  TAIL_BEND_K,
  TAIL_LEN_K,
  TAIL_LEN_DAMP,
  TAIL_DAMP,
  TAIL_CONTACT_D,
  TAIL_CONTACT_K,
} from './constants'

// Tail physics: the O(1) steering control plus the spring-chain pose. Purely
// visual apart from `tailBend`, the single scalar the body reads. Split out of
// cells.js so the chain integration can be read (and tested) on its own
// (cell-cv6.4).

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

// Re-aim a frozen chain on the hidden -> visible edge. Resets only the derived
// pose (points, velocities, directions, carrier), never tailLag/tailBend/
// tailPhase, so toggling tails cannot change steering.
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
