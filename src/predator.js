import {
  PRED_RANGE,
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
        if (latch.energy <= 0 && !latch.dying) {
          latch.dying = true
          latch.starveT = 0
        }
        gainEnergy(sim, red, PRED_DRAIN * simDt * PRED_EFF)
      }
    }
  }
}
