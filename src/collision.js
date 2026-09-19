import * as THREE from 'three'
import { P, SURFACE, CELL_GRID } from './constants.js'
import { gridKey } from './grid.js'

// Cell-cell collision and surface geometry. Pure helpers over the cell data
// objects plus the sim scratch vectors (_v3.._v6, _col) and the cell hash
// (cellGrid). Extracted from sim.js so the capsule math is unit-testable
// without WebGL (cell-cv6.3).

export function signedAngleTo(sim, d, target) {
  const n = sim._v3.copy(d.pos).normalize()
  const t = sim._v11.copy(target).addScaledVector(n, -target.dot(n))
  if (t.lengthSq() < 1e-6) return null
  t.normalize()
  const head = sim._v12.copy(d.heading).addScaledVector(n, -d.heading.dot(n))
  if (head.lengthSq() < 1e-6) return null
  head.normalize()
  const cross = sim._v4.crossVectors(head, t)
  return Math.atan2(cross.dot(n), head.dot(t))
}

export function deflectHeading(sim, d, awayWorld, intensity) {
  if (d.paralysed) return
  const ang = signedAngleTo(sim, d, awayWorld)
  if (ang == null) return
  d.headingRate += THREE.MathUtils.clamp(ang * P.COLLISION_KICK, -0.4, 0.4) * intensity
}

export function capsuleDist(sim, a, b) {
  const ha = Math.max(a.radius - a.width, 0)
  const hb = Math.max(b.radius - b.width, 0)
  const dhx = a.heading.x * ha
  const dhy = a.heading.y * ha
  const dhz = a.heading.z * ha
  const ehx = b.heading.x * hb
  const ehy = b.heading.y * hb
  const ehz = b.heading.z * hb
  const p1x = a.pos.x - dhx
  const p1y = a.pos.y - dhy
  const p1z = a.pos.z - dhz
  const d1x = 2 * dhx
  const d1y = 2 * dhy
  const d1z = 2 * dhz
  const p2x = b.pos.x - ehx
  const p2y = b.pos.y - ehy
  const p2z = b.pos.z - ehz
  const d2x = 2 * ehx
  const d2y = 2 * ehy
  const d2z = 2 * ehz
  const rx = p1x - p2x
  const ry = p1y - p2y
  const rz = p1z - p2z
  const a1 = d1x * d1x + d1y * d1y + d1z * d1z
  const e = d2x * d2x + d2y * d2y + d2z * d2z
  const f = d2x * rx + d2y * ry + d2z * rz
  const EPS = 1e-9
  let s = 0
  let t = 0
  if (a1 <= EPS && e <= EPS) {
    s = 0
    t = 0
  } else if (a1 <= EPS) {
    t = THREE.MathUtils.clamp(f / e, 0, 1)
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz
    if (e <= EPS) {
      s = THREE.MathUtils.clamp(-c / a1, 0, 1)
    } else {
      const bb = d1x * d2x + d1y * d2y + d1z * d2z
      const denom = a1 * e - bb * bb
      s = denom > EPS ? THREE.MathUtils.clamp((bb * f - c * e) / denom, 0, 1) : 0
      t = (bb * s + f) / e
      if (t < 0) {
        t = 0
        s = THREE.MathUtils.clamp(-c / a1, 0, 1)
      } else if (t > 1) {
        t = 1
        s = THREE.MathUtils.clamp((bb - c) / a1, 0, 1)
      }
    }
  }
  const c1x = p1x + d1x * s
  const c1y = p1y + d1y * s
  const c1z = p1z + d1z * s
  const c2x = p2x + d2x * t
  const c2y = p2y + d2y * t
  const c2z = p2z + d2z * t
  const dx = c2x - c1x
  const dy = c2y - c1y
  const dz = c2z - c1z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist > 1e-9) {
    sim._col.dist = dist
    sim._col.x = dx / dist
    sim._col.y = dy / dist
    sim._col.z = dz / dist
  } else {
    sim._col.dist = 0
    const ddx = b.pos.x - a.pos.x
    const ddy = b.pos.y - a.pos.y
    const ddz = b.pos.z - a.pos.z
    const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1
    sim._col.x = ddx / dd
    sim._col.y = ddy / dd
    sim._col.z = ddz / dd
  }
}

export function buildCellGrid(sim) {
  sim.cellGrid.clear()
  const n = sim.cells.length
  for (let i = 0; i < n; i++) {
    const d = sim.cells[i]
    if ((d.mito || d.splitting) && !d.mitoParent) continue
    const key = gridKey(
      Math.floor(d.pos.x / CELL_GRID),
      Math.floor(d.pos.y / CELL_GRID),
      Math.floor(d.pos.z / CELL_GRID),
    )
    const bucket = sim.cellGrid.get(key)
    if (bucket) bucket.push(i)
    else sim.cellGrid.set(key, [i])
  }
}

export function solveCollisions(sim, simDt) {
  const n = sim.cells.length
  for (let i = 0; i < n; i++) {
    const a = sim.cells[i]
    if ((a.mito || a.splitting) && !a.mitoParent) continue
    const cx = Math.floor(a.pos.x / CELL_GRID)
    const cy = Math.floor(a.pos.y / CELL_GRID)
    const cz = Math.floor(a.pos.z / CELL_GRID)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = sim.cellGrid.get(
            gridKey(cx + ox, cy + oy, cz + oz),
          )
          if (!bucket) continue
          for (let k = 0; k < bucket.length; k++) {
            const j = bucket[k]
            if (j <= i) continue
            const b = sim.cells[j]
            if ((b.mito || b.splitting) && !b.mitoParent) continue
            // A latched predator/prey pair is allowed to overlap while feeding;
            // the latch hold in predation owns their spacing.
            if (
              (a.breed === 1 && a.target === b && b.paralysed) ||
              (b.breed === 1 && b.target === a && a.paralysed)
            ) {
              continue
            }
            const cdx = b.pos.x - a.pos.x
            const cdy = b.pos.y - a.pos.y
            const cdz = b.pos.z - a.pos.z
            const bound = a.radius + b.radius + a.width + b.width
            if (cdx * cdx + cdy * cdy + cdz * cdz >= bound * bound) continue

            capsuleDist(sim, a, b)
            const contact = a.width + b.width
            if (sim._col.dist >= contact) continue
            const overlap = contact - sim._col.dist
            const nx = sim._col.x
            const ny = sim._col.y
            const nz = sim._col.z
            const invA = a.mitoParent ? 0 : 1 / a.mass
            const invB = b.mitoParent ? 0 : 1 / b.mass
            const invSum = invA + invB
            if (invSum <= 0) continue

            const impulse = (overlap * P.SPRING) / invSum
            a.vel.x -= nx * impulse * invA * simDt
            a.vel.y -= ny * impulse * invA * simDt
            a.vel.z -= nz * impulse * invA * simDt
            b.vel.x += nx * impulse * invB * simDt
            b.vel.y += ny * impulse * invB * simDt
            b.vel.z += nz * impulse * invB * simDt

            if (!a.mitoParent) {
              deflectHeading(
                sim,
                a,
                sim._v6.set(-nx, -ny, -nz),
                Math.min(overlap * 8, 1),
              )
            }
            if (!b.mitoParent) {
              deflectHeading(
                sim,
                b,
                sim._v5.set(nx, ny, nz),
                Math.min(overlap * 8, 1),
              )
            }

            const corr = (overlap * 0.5 * simDt) / invSum
            a.pos.x -= nx * corr * invA
            a.pos.y -= ny * corr * invA
            a.pos.z -= nz * corr * invA
            b.pos.x += nx * corr * invB
            b.pos.y += ny * corr * invB
            b.pos.z += nz * corr * invB
            a.pos.setLength(SURFACE)
            b.pos.setLength(SURFACE)
          }
        }
      }
    }
  }
}
