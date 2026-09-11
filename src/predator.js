import {
  PRED_RANGE,
  PRED_SENSE,
  PRED_BITE,
  PRED_DRAIN,
  PRED_EFF,
  CELL_GRID,
} from './constants'
import { cellIndex } from './math'
import { drainEnergy, gainEnergy } from './cells'

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
  return d.breed === 0 && !d.mito && !d.splitting && !d.dying && !d.dead
}

function validPredator(d) {
  return d.breed === 1 && !d.mito && !d.splitting && !d.dying && !d.dead
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
      sim.capsuleDist(red, d)
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

  for (const cell of sim.cells) {
    const red = cell
    if (!validPredator(red)) {
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
      sim.capsuleDist(red, d)
      if (sim._col.dist < best) {
        best = sim._col.dist
        prey = d
      }
    })

    if (prey) red.target = prey

    const t = red.target
    if (t == null || t.dead || t.dying || t.splitting) {
      red.target = null
    } else {
      sim.capsuleDist(red, t)
      if (sim._col.dist > PRED_RANGE * 1.6) red.target = null
    }

    const latch = red.target
    if (!latch) continue
    sim.capsuleDist(red, latch)
    const dist = sim._col.dist
    if (dist <= PRED_RANGE) {
      latch.paralysed = true
      if (dist <= PRED_BITE) {
        drainEnergy(sim, latch, PRED_DRAIN * simDt)
        if (latch.energy <= 0) {
          latch.killedByPred = true
          if (!latch.dying) {
            latch.dying = true
            latch.starveT = 0
          }
        }
        gainEnergy(sim, red, PRED_DRAIN * simDt * PRED_EFF)
      }
    }
  }
}
