import * as THREE from 'three'
import {
  SURFACE,
  GRID,
  WIDTH,
  SENSE_BOOST,
  GROWTH_PER_FOOD,
  ABSORB_CAP,
  GRAZE_RATE,
  GRAZE_GAIN,
} from './constants'
import { randomUnitVector, randomSurfacePoint, randomTangent, cellIndex } from './math'
import { growCell } from './cells'

export function placeFood(sim, food) {
  const s = food.visible ? food.scale : 0.0001
  sim._dummy.position.copy(food.pos)
  sim._dummy.scale.set(s, s, s)
  sim._dummy.rotation.set(0, 0, 0)
  sim._dummy.updateMatrix()
  sim.foodMesh.setMatrixAt(food.index, sim._dummy.matrix)
}

export function generateClumps(sim) {
  const n = 12 + Math.floor(Math.random() * 8)
  for (let i = 0; i < n; i++) {
    sim.clumps.push({
      center: randomUnitVector(),
      radius: 0.3 + Math.random() * 0.9,
      theta: (0.2 + Math.random() * 0.6) / SURFACE,
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

function clumpPos(sim) {
  if (Math.random() < 0.15) return randomSurfacePoint()
  return foodInClump(sim.clumps[Math.floor(Math.random() * sim.clumps.length)])
}

export function makeFood(sim) {
  const r = 0.016 + Math.random() * 0.024
  const food = {
    pos: clumpPos(sim),
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
  const key = cellIndex(
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
    if (pos !== -1) bucket.splice(pos, 1)
  }
  food.gridKey = null
}

export function buildFoodGrid(sim) {
  sim.foodGrid.clear()
  for (let i = 0; i < sim.foods.length; i++) {
    if (sim.foods[i].visible) addFoodToGrid(sim, i)
  }
}

export function foodDist(sim, d, food, halfLen) {
  const ax = d.heading
  const rx = food.pos.x - d.pos.x
  const ry = food.pos.y - d.pos.y
  const rz = food.pos.z - d.pos.z
  let t = rx * ax.x + ry * ax.y + rz * ax.z
  if (t > halfLen) t = halfLen
  else if (t < -halfLen) t = -halfLen
  const ex = rx - ax.x * t
  const ey = ry - ax.y * t
  const ez = rz - ax.z * t
  sim._fd.rx = rx
  sim._fd.ry = ry
  sim._fd.rz = rz
  return Math.sqrt(ex * ex + ey * ey + ez * ez)
}

export function forEachNearbyFood(sim, cx, cy, cz, r, cb) {
  for (let ox = -r; ox <= r; ox++) {
    for (let oy = -r; oy <= r; oy++) {
      for (let oz = -r; oz <= r; oz++) {
        const bucket = sim.foodGrid.get(cellIndex(cx + ox, cy + oy, cz + oz))
        if (!bucket) continue
        for (let k = 0; k < bucket.length; k++) {
          const foodIndex = bucket[k]
          const food = sim.foods[foodIndex]
          if (!food.visible) continue
          if (cb(foodIndex, food) === false) return
        }
      }
    }
  }
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
      food.pos = clumpPos(sim)
      food.visible = true
      addFoodToGrid(sim, foodIndex)
      placeFood(sim, food)
      dirty = true
    }
  }

  for (const cell of sim.cells) {
    const d = cell
    if (d.mito || d.splitting || d.split) continue
    const halfLen = Math.max(d.radius - WIDTH, 0)
    let ate = 0
    const cx = Math.floor(d.pos.x / GRID)
    const cy = Math.floor(d.pos.y / GRID)
    const cz = Math.floor(d.pos.z / GRID)
    forEachNearbyFood(sim, cx, cy, cz, 1, (foodIndex, food) => {
      if (foodDist(sim, d, food, halfLen) < WIDTH + food.r) {
        growCell(sim, d, GROWTH_PER_FOOD)
        food.respawn = 2.5 + Math.random() * 8
        food.visible = false
        removeFoodFromGrid(sim, foodIndex)
        sim.respawning.push(foodIndex)
        placeFood(sim, food)
        dirty = true
        if (++ate >= ABSORB_CAP) return false
      }
    })
  }

  if (dirty) sim.foodMesh.instanceMatrix.needsUpdate = true
}

export function concentration(sim) {
  for (const cell of sim.cells) {
    const d = cell
    if (d.mito || d.splitting || d.split) continue
    let sum = 0
    let fx = 0
    let fy = 0
    let fz = 0
    const halfLen = Math.max(d.radius - WIDTH, 0)
    const sense = WIDTH + SENSE_BOOST
    const cx = Math.floor(d.pos.x / GRID)
    const cy = Math.floor(d.pos.y / GRID)
    const cz = Math.floor(d.pos.z / GRID)
    forEachNearbyFood(sim, cx, cy, cz, 2, (foodIndex, food) => {
      const dd = foodDist(sim, d, food, halfLen)
      if (dd < sense) {
        const w = 1 - dd / sense
        sum += w
        fx += sim._fd.rx * w
        fy += sim._fd.ry * w
        fz += sim._fd.rz * w
      }
    })
    d.slow = 1 + (GRAZE_RATE - 1) * (1 - Math.exp(-sum * GRAZE_GAIN))
    d.foodAmt = Math.min(sum, 1)
    const fb = Math.sqrt(fx * fx + fy * fy + fz * fz)
    d.foodPeak = sum > 0 ? fb / sum / sense : 0
    d.foodDir.set(fx, fy, fz)
  }
}
