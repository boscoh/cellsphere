import {
  P,
  SURFACE,
  CELL_GRID,
  MAX_RADIUS,
  WIDTH,
  ENERGY_MAX,
} from './constants.js'
import { forEachNearby, scanRadius } from './grid.js'
import { drainEnergy, gainEnergy, isAssemblyParent, assemblyDrain } from './cells.js'
import { capsuleDist } from './collision.js'

// How fast a feeding predator closes the last gap to sink into its prey.
const LATCH_CLOSE_RATE = 0.5

// Longest core-segment half-length a prey capsule can have (a full-energy
// green). The scan threshold is a capsule *gap*, while the scan walks buckets
// around the sensor's centre, so the radius has to cover this plus the sensor's
// own half-length or prey inside the threshold fall outside the scanned cube.
const MAX_PREY_HALF = MAX_RADIUS - WIDTH

function preyScanRadius(threshold, sensor) {
  const halfLen = Math.max(sensor.radius - sensor.width, 0)
  return scanRadius(threshold + halfLen + MAX_PREY_HALF, CELL_GRID)
}

function validPrey(d) {
  if (d.breed !== 0 || d.dead) return false
  if (d.asm === null) return true
  // A dividing mother is the assembly's only sensable body (the daughters are
  // not in the cell grid), and only once MITO_VULNERABLE is on and her phase has
  // passed MITO_VULN_FRAC, and still has budget to give.
  return P.MITO_VULNERABLE > 0 && d.mitoExposed === true && isAssemblyParent(d) && d.energy > 0
}

function validPredator(d) {
  return d.breed === 1 && d.asm === null && !d.detach && !d.dead
}

// Holling Type III (sigmoid, exponent 2) in local prey density: the bite is near
// zero for an isolated green and near full inside a shoal. `half` is the prey
// count at half rate; 0 disables (pure Type II, density-independent bite).
function type3Factor(preyCount, half) {
  const c = Math.max(1, preyCount)
  return (c * c) / (c * c + half * half)
}

// Smell the shoal: sum proximity-weighted unit vectors to every valid prey
// within P.PRED_SENSE into a gradient direction (d.preyDir), mirroring how
// food.concentration() gives green a food gradient. A red then steers up this
// gradient instead of chasing only the single nearest green inside a hard cutoff.
export function predatorSense(sim) {
  for (const cell of sim.cells) {
    cell.preyAmt = 0
    cell.preyNear = Infinity
    cell.preyCount = 0
  }

  const sense = P.PRED_SENSE
  if (sense <= 0) return

  for (const cell of sim.cells) {
    const red = cell
    if (!validPredator(red)) continue

    // Derive the scan radius from the threshold and both capsule half-lengths,
    // so prey inside PRED_SENSE are not clipped by the bucket scan (cell-kkl).
    const r = preyScanRadius(sense, red)
    const cx = Math.floor(red.pos.x / CELL_GRID)
    const cy = Math.floor(red.pos.y / CELL_GRID)
    const cz = Math.floor(red.pos.z / CELL_GRID)

    let sum = 0
    let fx = 0
    let fy = 0
    let fz = 0
    let near = Infinity
    let nfx = 0
    let nfy = 0
    let nfz = 0
    forEachNearby(sim.cellGrid, cx, cy, cz, r, (index) => {
      const d = sim.cells[index]
      if (!validPrey(d)) return
      capsuleDist(sim, red, d)
      const dist = sim._col.dist
      if (dist < sense) {
        const base = 1 - dist / sense
        if (base <= 0) return
        if (dist < near) {
          near = dist
          nfx = sim._col.x
          nfy = sim._col.y
          nfz = sim._col.z
        }
        const w = P.PRED_FOCUS === 1 ? base : Math.pow(base, P.PRED_FOCUS)
        sum += w
        red.preyCount++
        fx += sim._col.x * w
        fy += sim._col.y * w
        fz += sim._col.z * w
      }
    })

    red.preyNear = near
    // Open a short hunt window the moment a red newly smells prey, so it can
    // turn onto the shoal instead of arcing in slowly (cell-zby).
    const nowSees = near < Infinity
    if (nowSees && !red.preySeen) red.huntT = P.PRED_HUNT
    red.preySeen = nowSees
    if (near < Infinity) red.preyNearestDir.set(nfx, nfy, nfz)
    if (sum > 0) {
      red.preyDir.set(fx, fy, fz)
      red.preyAmt = Math.min(sum, 1)
    }
  }
}

export function predation(sim, simDt) {
  for (const cell of sim.cells) cell.paralysed = false

  // Ratio-dependent predation (Arditi-Ginzburg): the per-capita attack falls
  // as predators come to outnumber prey, so a shrinking prey population gets a
  // refuge and the two populations can cycle instead of collapsing. Counts are
  // computed once per frame.
  let ratioAttack = 1
  if (P.PRED_RATIO > 0) {
    let preyCount = 0
    let predCount = 0
    for (const cell of sim.cells) {
      if (validPrey(cell)) preyCount++
      else if (validPredator(cell)) predCount++
    }
    if (predCount > 0) {
      const ratio = preyCount / predCount
      ratioAttack = ratio / (ratio + P.PRED_RATIO)
    }
  }

  for (const cell of sim.cells) {
    const red = cell
    if (!validPredator(red)) {
      red.target = null
      continue
    }

    // Ratio-dependent refuge: too few prey per predator -> do not hunt.
    if (P.PRED_RATIO > 0 && ratioAttack < 0.5) {
      red.target = null
      continue
    }

    const cx = Math.floor(red.pos.x / CELL_GRID)
    const cy = Math.floor(red.pos.y / CELL_GRID)
    const cz = Math.floor(red.pos.z / CELL_GRID)

    // Same derivation as predatorSense: the latch threshold is a capsule gap
    // and PRED_RANGE tunes up to a full bucket, so a literal radius clips the
    // top of the slider (cell-kkl).
    const r = preyScanRadius(P.PRED_RANGE, red)
    let prey = null
    let best = P.PRED_RANGE
    forEachNearby(sim.cellGrid, cx, cy, cz, r, (index) => {
      const d = sim.cells[index]
      if (!validPrey(d)) return
      capsuleDist(sim, red, d)
      if (sim._col.dist < best) {
        best = sim._col.dist
        prey = d
      }
    })

    if (prey) red.target = prey

    const t = red.target
    // Retention must re-check validity, not just death: a red latched before the
    // division turned splitting is the dominant path, so an unexposed (or
    // MITO_VULNERABLE = 0) assembly drops the latch here.
    if (t == null || !validPrey(t)) {
      red.target = null
    } else {
      capsuleDist(sim, red, t)
      if (sim._col.dist > P.PRED_RANGE * 1.6) red.target = null
    }

    const latch = red.target
    if (!latch) continue
    capsuleDist(sim, red, latch)
    const dist = sim._col.dist
    if (dist <= P.PRED_RANGE) {
      latch.paralysed = true
      // Sink the predator slightly into the prey so feeding reads as contact,
      // not a gap. Collisions skip this pair while latched (see solveCollisions).
      const desired = red.width + latch.width - P.PRED_OVERLAP
      if (dist > desired) {
        const step = Math.min(dist - desired, LATCH_CLOSE_RATE * simDt)
        red.pos.x += sim._col.x * step
        red.pos.y += sim._col.y * step
        red.pos.z += sim._col.z * step
        red.pos.setLength(SURFACE)
      }
      if (dist <= P.PRED_BITE) {
        // Clump feast (cell-3bz): optionally scale the bite with how many prey
        // are packed nearby, so a red in a shoal eats faster than on a lone
        // green while isolated prey survive as refuge. PRED_CROWD = 0 disables.
        const nearby = red.preyCount || 1
        const crowd = 1 + P.PRED_CROWD * Math.max(0, nearby - 1)
        // Type III: smooth sigmoid in local prey density (rare-prey refuge).
        const t3 = P.PRED_T3_HALF > 0 ? type3Factor(red.preyCount, P.PRED_T3_HALF) : 1
        const unit = latch.asm
        if (unit) unit.bittenT = unit.t
        const rate = P.PRED_DRAIN * simDt * ratioAttack * crowd * t3 * (unit ? P.MITO_DRAIN_SCALE : 1)
        if (unit) {
          // A bite on a dividing unit removes from the mother's budget and is
          // capped by the eater's room; the gain follows what was removed, so a
          // second red (or an emptied husk) cannot create energy from an empty
          // pool. The tank cap is what already ends a latch episode: gainEnergy
          // flips split and processSplits calls beginDetach in the same substep.
          const taken = assemblyDrain(unit, Math.min(rate, ENERGY_MAX - red.energy))
          if (taken <= 0) red.target = null
          else gainEnergy(sim, red, taken * P.PRED_EFF)
        } else {
          drainEnergy(sim, latch, rate)
          if (latch.energy <= 0) {
            latch.dead = true
            // Meal over: a red may briefly reorient onto the nearest prey
            // instead of following the shoal gradient (cell-erd).
            red.reorientT = P.PRED_REORIENT
          }
          gainEnergy(sim, red, rate * P.PRED_EFF)
        }
      }
    }
  }
}
