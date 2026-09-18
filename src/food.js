import * as THREE from 'three'
import {
  P,
  SURFACE,
  GRID,
  ENERGY_MAX,
  FOOD_RADIUS_MIN,
  FOOD_RADIUS_MAX,
} from './constants'
import { randomUnitVector, randomSurfacePoint, randomTangent } from './math'
import { gridKey, forEachNearby, scanRadius } from './grid'
import { gainEnergy } from './cells'

// Scratch pseudo-food used by clump-attractor sensing (Tier-2 prototype).
const _clumpFood = { pos: new THREE.Vector3(), r: 0 }

export function placeFood(sim, food) {
  const s = food.visible ? food.scale : 0.0001
  sim._dummy.position.copy(food.pos)
  sim._dummy.scale.set(s, s, s)
  sim._dummy.rotation.set(0, 0, 0)
  sim._dummy.updateMatrix()
  sim.foodMesh.setMatrixAt(food.index, sim._dummy.matrix)
}

export function generateClumps(sim) {
  const n =
    P.FOOD_CLUMPS > 0 ? P.FOOD_CLUMPS + Math.floor(Math.random() * 8) : 0
  for (let i = 0; i < n; i++) {
    sim.clumps.push({
      center: randomUnitVector(),
      radius: 0.3 + Math.random() * 0.9,
      theta: ((0.2 + Math.random() * 0.6) * P.FOOD_CLUMP_WIDE) / SURFACE,
    })
  }
}

function foodInClump(clump) {
  const t = randomTangent(clump.center)
  const ang = Math.sqrt(Math.random()) * clump.theta
  const q = new THREE.Quaternion().setFromAxisAngle(t, ang)
  return clump.center
    .clone()
    .applyQuaternion(q)
    .normalize()
    .multiplyScalar(SURFACE)
}

function pointForClump(sim, clumpIndex) {
  if (clumpIndex < 0 || sim.clumps.length === 0) return randomSurfacePoint()
  return foodInClump(sim.clumps[clumpIndex])
}

export function makeFood(sim) {
  const r =
    FOOD_RADIUS_MIN + Math.random() * (FOOD_RADIUS_MAX - FOOD_RADIUS_MIN)
  const clump =
    sim.clumps.length > 0 && Math.random() >= P.FOOD_SCATTER
      ? Math.floor(Math.random() * sim.clumps.length)
      : -1
  const food = {
    pos: foodSpot(sim, clump, r),
    clump,
    r,
    scale: r / 0.05,
    respawn: 0,
    visible: true,
    index: sim.foods.length,
    gridKey: null,
  }
  sim.foods.push(food)
  placeFood(sim, food)
  return food
}

export function addFoodToGrid(sim, i) {
  const food = sim.foods[i]
  const key = gridKey(
    Math.floor(food.pos.x / GRID),
    Math.floor(food.pos.y / GRID),
    Math.floor(food.pos.z / GRID),
  )
  food.gridKey = key
  const bucket = sim.foodGrid.get(key)
  if (bucket) bucket.push(i)
  else sim.foodGrid.set(key, [i])
}

export function removeFoodFromGrid(sim, i) {
  const food = sim.foods[i]
  if (food.gridKey == null) return
  const bucket = sim.foodGrid.get(food.gridKey)
  if (bucket) {
    const pos = bucket.indexOf(i)
    if (pos === -1) {
      if (import.meta.env?.DEV) {
        console.warn(`removeFoodFromGrid: stale gridKey for food ${i}`)
      }
    } else {
      // Bucket order is irrelevant, so backfill with the last entry instead of
      // splicing (cell-qjo.3).
      const last = bucket.pop()
      if (pos < bucket.length) bucket[pos] = last
    }
  }
  food.gridKey = null
}

export function buildFoodGrid(sim) {
  sim.foodGrid.clear()
  for (let i = 0; i < sim.foods.length; i++) {
    if (sim.foods[i].visible) addFoodToGrid(sim, i)
  }
}

// Point-to-capsule distance. `maxDist` is an optional cutoff: a candidate whose
// centre is farther than maxDist + halfLen cannot be within maxDist of the
// capsule, so it is rejected before the projection/sqrt (cell-qjo.2). The raw
// offset is always written to _fd because concentration accumulates it.
export function foodDist(sim, d, food, halfLen, maxDist) {
  const ax = d.heading
  const rx = food.pos.x - d.pos.x
  const ry = food.pos.y - d.pos.y
  const rz = food.pos.z - d.pos.z
  sim._fd.rx = rx
  sim._fd.ry = ry
  sim._fd.rz = rz
  if (maxDist !== undefined) {
    const bound = maxDist + halfLen
    if (rx * rx + ry * ry + rz * rz > bound * bound) return maxDist
  }
  let t = rx * ax.x + ry * ax.y + rz * ax.z
  if (t > halfLen) t = halfLen
  else if (t < -halfLen) t = -halfLen
  const ex = rx - ax.x * t
  const ey = ry - ax.y * t
  const ez = rz - ax.z * t
  return Math.sqrt(ex * ex + ey * ey + ez * ez)
}

function overlapsAnyCell(sim, pos, r) {
  for (const cell of sim.cells) {
    const d = cell
    if (d.dead) continue
    const halfLen = Math.max(d.radius - d.width, 0)
    if (foodDist(sim, d, { pos, r }, halfLen, d.width + r) < d.width + r) {
      return true
    }
  }
  return false
}

function foodSpot(sim, clump, r) {
  for (let t = 0; t < 16; t++) {
    const p = pointForClump(sim, clump)
    if (!overlapsAnyCell(sim, p, r)) return p
  }
  for (let t = 0; t < 16; t++) {
    const p = randomSurfacePoint()
    if (!overlapsAnyCell(sim, p, r)) return p
  }
  return randomSurfacePoint()
}

function respawnSpot(sim, food) {
  return foodSpot(sim, food.clump, food.r)
}

export function eatAndRespawn(sim, simDt) {
  let dirty = false
  for (let i = sim.respawning.length - 1; i >= 0; i--) {
    const foodIndex = sim.respawning[i]
    const food = sim.foods[foodIndex]
    food.respawn -= simDt
    if (food.respawn <= 0) {
      sim.respawning.splice(i, 1)
      removeFoodFromGrid(sim, foodIndex)
      food.pos = respawnSpot(sim, food)
      food.visible = true
      addFoodToGrid(sim, foodIndex)
      placeFood(sim, food)
      dirty = true
    }
  }

  for (const cell of sim.cells) {
    const d = cell
    if (d.mito || d.splitting || d.split) continue
    if (d.breed === 1) continue // predators don't graze food
    // Food is consumed on contact, but only P.ENERGY_PER_FOOD banks get absorbed:
    // a cell stores a budget at P.ABSORB_RATE/s and converts a particle only once
    // a full particle's worth is banked. Food it touches beyond that is eaten
    // but not converted — effectively wasted.
    d.absorbAcc = Math.min(d.absorbAcc + P.ABSORB_RATE * simDt, P.ENERGY_PER_FOOD)
    const halfLen = Math.max(d.radius - d.width, 0)
    const cx = Math.floor(d.pos.x / GRID)
    const cy = Math.floor(d.pos.y / GRID)
    const cz = Math.floor(d.pos.z / GRID)
    // Gather contacted food first so consuming doesn't mutate a bucket under
    // the shared scanner's feet (it splices as it goes).
    sim._eatContact.length = 0
    const contact = sim._eatContact
    forEachNearby(sim.foodGrid, cx, cy, cz, 1, (foodIndex) => {
      const food = sim.foods[foodIndex]
      if (!food.visible) return
      if (foodDist(sim, d, food, halfLen, d.width + food.r) < d.width + food.r) {
        contact.push(foodIndex)
      }
    })
    for (let c = 0; c < contact.length; c++) {
      const foodIndex = contact[c]
      const food = sim.foods[foodIndex]
      if (!food.visible) continue
      food.respawn = P.FOOD_RESPAWN + Math.random() * 8
      food.visible = false
      removeFoodFromGrid(sim, foodIndex)
      sim.respawning.push(foodIndex)
      placeFood(sim, food)
      dirty = true
      if (d.absorbAcc >= P.ENERGY_PER_FOOD) {
        d.absorbAcc -= P.ENERGY_PER_FOOD
        // gainEnergy clamps to ENERGY_MAX and flips split, so a full cell can
        // reach the mitosis threshold immediately instead of idling under max.
        gainEnergy(sim, d, P.ENERGY_PER_FOOD)
      }
    }
  }

  if (dirty) sim.foodMesh.instanceMatrix.needsUpdate = true
}

export function concentration(sim) {
  for (const cell of sim.cells) {
    const d = cell
    if (d.mito || d.splitting || d.split) continue
    if (d.breed === 1) continue // predators don't sense/graze food
    let sum = 0
    let fx = 0
    let fy = 0
    let fz = 0
    const halfLen = Math.max(d.radius - d.width, 0)
    const sense = d.width + P.SENSE_BOOST
    const cx = Math.floor(d.pos.x / GRID)
    const cy = Math.floor(d.pos.y / GRID)
    const cz = Math.floor(d.pos.z / GRID)
    if (P.SENSE_MODE === 1 && sim.clumps.length > 0) {
      // Tier-2 prototype (cell-qjo.5): sense the clump attractors instead of
      // every food spec, O(clumps) per cell. Each clump contributes up to its
      // angular radius theta; scattered food (FOOD_SCATTER) is ignored.
      for (const clump of sim.clumps) {
        _clumpFood.pos.copy(clump.center).multiplyScalar(SURFACE)
        const reach = sense + clump.theta * SURFACE
        const dd = foodDist(sim, d, _clumpFood, halfLen, reach)
        if (dd < reach) {
          const w = 1 - dd / reach
          sum += w
          fx += sim._fd.rx * w
          fy += sim._fd.ry * w
          fz += sim._fd.rz * w
        }
      }
    } else {
      // Derive the scan radius from the current sense so a high SENSE_BOOST is
      // not silently clipped (cell-qjo.1).
      const r = scanRadius(sense + halfLen + FOOD_RADIUS_MAX, GRID)
      forEachNearby(sim.foodGrid, cx, cy, cz, r, (foodIndex) => {
        const food = sim.foods[foodIndex]
        if (!food.visible) return
        const dd = foodDist(sim, d, food, halfLen, sense)
        if (dd < sense) {
          const w = 1 - dd / sense
          sum += w
          fx += sim._fd.rx * w
          fy += sim._fd.ry * w
          fz += sim._fd.rz * w
        }
      })
    }
    d.slow = 1 + (P.GRAZE_RATE - 1) * (1 - Math.exp(-sum * P.GRAZE_GAIN))
    d.foodAmt = Math.min(sum, 1)
    const fb = Math.sqrt(fx * fx + fy * fy + fz * fz)
    d.foodPeak = sum > 0 ? fb / sum / sense : 0
    d.foodDir.set(fx, fy, fz)
  }
}
