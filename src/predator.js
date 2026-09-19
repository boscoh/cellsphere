import {
  P,
  SURFACE,
  CELL_GRID,
} from './constants.js'
import { forEachNearby } from './grid.js'
import { drainEnergy, gainEnergy } from './cells.js'
import { capsuleDist } from './collision.js'

// How fast a feeding predator closes the last gap to sink into its prey.
const LATCH_CLOSE_RATE = 0.5

function validPrey(d) {
  return d.breed === 0 && !d.mito && !d.splitting && !d.dead
}

function validPredator(d) {
  return d.breed === 1 && !d.mito && !d.splitting && !d.detach && !d.dead
}

// Smell the shoal: sum proximity-weighted unit vectors to every valid prey
// within P.PRED_SENSE into a gradient direction (d.preyDir), mirroring how
// food.concentration() gives blue a food gradient. A red then steers up this
// gradient instead of chasing only the single nearest blue inside a hard cutoff.
export function predatorSense(sim) {
  for (const cell of sim.cells) {
    cell.preyAmt = 0
    cell.preyNear = Infinity
    cell.preyCount = 0
  }

  const sense = P.PRED_SENSE
  if (sense <= 0) return
  const r = Math.ceil(sense / CELL_GRID)

  for (const cell of sim.cells) {
    const red = cell
    if (!validPredator(red)) continue

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

    let prey = null
    let best = P.PRED_RANGE
    forEachNearby(sim.cellGrid, cx, cy, cz, 1, (index) => {
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
    if (t == null || t.dead || t.splitting) {
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
        // blue while isolated prey survive as refuge. PRED_CROWD = 0 disables.
        const nearby = red.preyCount || 1
        const crowd = 1 + P.PRED_CROWD * Math.max(0, nearby - 1)
        const rate = P.PRED_DRAIN * simDt * ratioAttack * crowd
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
