import {
  PRED_RANGE,
  PRED_SENSE,
  PRED_BITE,
  PRED_OVERLAP,
  PRED_DRAIN,
  PRED_EFF,
  PRED_RATIO,
  SURFACE,
  CELL_GRID,
} from './constants'
import { cellIndex } from './math'
import { drainEnergy, gainEnergy } from './cells'
import { capsuleDist } from './collision'

// How fast a feeding predator closes the last gap to sink into its prey.
const LATCH_CLOSE_RATE = 0.5

export function forEachNearbyCell(sim, cx, cy, cz, r, cb) {
  for (let ox = -r; ox <= r; ox++) {
    for (let oy = -r; oy <= r; oy++) {
      for (let oz = -r; oz <= r; oz++) {
        const bucket = sim.cellGrid.get(cellIndex(cx + ox, cy + oy, cz + oz))
        if (!bucket) continue
        for (let k = 0; k < bucket.length; k++) {
          if (cb(bucket[k]) === false) return
        }
      }
    }
  }
}

function validPrey(d) {
  return d.breed === 0 && !d.mito && !d.splitting && !d.dead
}

function validPredator(d) {
  return d.breed === 1 && !d.mito && !d.splitting && !d.detach && !d.dead
}

// Smell the shoal: sum proximity-weighted unit vectors to every valid prey
// within PRED_SENSE into a gradient direction (d.preyDir), mirroring how
// food.concentration() gives blue a food gradient. A red then steers up this
// gradient instead of chasing only the single nearest blue inside a hard cutoff.
export function predatorSense(sim) {
  for (const cell of sim.cells) cell.preyAmt = 0

  const sense = PRED_SENSE
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
    forEachNearbyCell(sim, cx, cy, cz, r, (index) => {
      const d = sim.cells[index]
      if (!validPrey(d)) return
      capsuleDist(sim, red, d)
      const dist = sim._col.dist
      if (dist < sense) {
        const w = 1 - dist / sense
        sum += w
        fx += sim._col.x * w
        fy += sim._col.y * w
        fz += sim._col.z * w
      }
    })

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
  if (PRED_RATIO > 0) {
    let preyCount = 0
    let predCount = 0
    for (const cell of sim.cells) {
      if (validPrey(cell)) preyCount++
      else if (validPredator(cell)) predCount++
    }
    if (predCount > 0) {
      const ratio = preyCount / predCount
      ratioAttack = ratio / (ratio + PRED_RATIO)
    }
  }

  for (const cell of sim.cells) {
    const red = cell
    if (!validPredator(red)) {
      red.target = null
      continue
    }

    // Ratio-dependent refuge: too few prey per predator -> do not hunt.
    if (PRED_RATIO > 0 && ratioAttack < 0.5) {
      red.target = null
      continue
    }

    const cx = Math.floor(red.pos.x / CELL_GRID)
    const cy = Math.floor(red.pos.y / CELL_GRID)
    const cz = Math.floor(red.pos.z / CELL_GRID)

    let prey = null
    let best = PRED_RANGE
    forEachNearbyCell(sim, cx, cy, cz, 1, (index) => {
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
      if (sim._col.dist > PRED_RANGE * 1.6) red.target = null
    }

    const latch = red.target
    if (!latch) continue
    capsuleDist(sim, red, latch)
    const dist = sim._col.dist
    if (dist <= PRED_RANGE) {
      latch.paralysed = true
      // Sink the predator slightly into the prey so feeding reads as contact,
      // not a gap. Collisions skip this pair while latched (see solveCollisions).
      const desired = red.width + latch.width - PRED_OVERLAP
      if (dist > desired) {
        const step = Math.min(dist - desired, LATCH_CLOSE_RATE * simDt)
        red.pos.x += sim._col.x * step
        red.pos.y += sim._col.y * step
        red.pos.z += sim._col.z * step
        red.pos.setLength(SURFACE)
      }
      if (dist <= PRED_BITE) {
        const rate = PRED_DRAIN * simDt * ratioAttack
        drainEnergy(sim, latch, rate)
        if (latch.energy <= 0) {
          latch.killedByPred = true
          latch.dead = true
        }
        gainEnergy(sim, red, rate * PRED_EFF)
      }
    }
  }
}
