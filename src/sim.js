import * as THREE from 'three'
import {
  SURFACE,
  CELL_COUNT,
  MAX_CELLS,
  FOOD_COUNT,
  GRID,
  SPRING,
  FIXED_DT,
  MAX_STEPS,
  MIN_RADIUS,
  MAX_RADIUS,
  START_RADIUS,
  GROWTH_PER_FOOD,
  ABSORB_CAP,
  MITO_TIME,
  MITO_HOLD,
  MITO_FADE,
  MITO_NEAR,
  MITO_SEP,
  MITO_SLOW_FRAC,
  WIDTH,
  TAIL_SEGMENTS,
  TAIL_LEN,
  TAIL_AMP,
  TAIL_FREQ,
  TAIL_WAVE,
  TAIL_LAG_RATE,
  TAIL_HELIX,
  AGITATE_UP,
  AGITATE_DOWN,
  GO_THRESH,
  WHIP_GAIN,
  WHIP_TAU,
  THRUST,
  DRAG,
  GRAZE_RATE,
  GRAZE_GAIN,
  ANG_DRAG,
  CHEMO_ACCEL,
  MAX_ACCEL,
  COLLISION_KICK,
  MAX_SPIN,
  PEAK_MIN,
  SENSE_BOOST,
  SENSE_PERIOD,
  CULL_COS,
  CELL_GRID,
} from './constants'
import {
  randomUnitVector,
  randomSurfacePoint,
  randomTangent,
  smoothstep,
  cellIndex,
} from './math'
import {
  unitOuterGeo,
  foodGeo,
  tailGeo,
  foodMat,
  tailMat,
  disposeSharedMaterials,
} from './materials'
import { createScene } from './sceneSetup'

function makeBodyGeo(length) {
  const cylLen = Math.max(2 * (length - WIDTH), 0.001)
  const geo = new THREE.CapsuleGeometry(WIDTH, cylLen, 8, 20)
  geo.rotateZ(Math.PI / 2)
  return geo
}

function computeCellColor(length) {
  const t = THREE.MathUtils.clamp(
    (length - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS),
    0,
    1,
  )
  const color = new THREE.Color().setHSL(0.55 - t * 0.32, 0.55 + t * 0.4, 0.62)
  const emissive = color.clone().multiplyScalar(0.25 + t * 0.4)
  return { color, emissive }
}

function applyCellColor(cell, color) {
  const u = cell.userData
  u.color.copy(color)
  u.outer.material.color.copy(color)
  u.nucleus.material.color.copy(color.clone().offsetHSL(0, 0, 0.1))
}

function setCellAppearance(cell, length) {
  const u = cell.userData
  u.radius = length
  u.mass = Math.max(length * length * 0.25, 0.05)
  u.outer.geometry.dispose()
  u.outer.geometry = makeBodyGeo(length)
  u.nucleus.scale.set(length * 0.62, WIDTH * 0.5, WIDTH * 0.5)
  const { color, emissive } = computeCellColor(length)
  applyCellColor(cell, color)
  u.nucleus.material.emissive.copy(emissive)
}

function placeMitoChild(m, cell, dist) {
  const d = cell.userData
  d.pos.copy(m.startPos).addScaledVector(m.headBack, dist)
  d.pos.setLength(SURFACE)
  cell.position.copy(d.pos)
  const n = d.pos.clone().normalize()
  const fwd = d.heading.clone().addScaledVector(n, -d.heading.dot(n)).normalize()
  const right = new THREE.Vector3().crossVectors(fwd, n)
  if (right.lengthSq() < 1e-6) {
    right.set(0, 1, 0).addScaledVector(n, -n.y).normalize()
  } else {
    right.normalize()
  }
  const mtx = new THREE.Matrix4().makeBasis(fwd, n, right)
  cell.quaternion.setFromRotationMatrix(mtx)
}

function disposeObject3D(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose()
    if (o.material) {
      Array.isArray(o.material)
        ? o.material.forEach((m) => m.dispose())
        : o.material.dispose()
    }
  })
}

export class Simulation {
  constructor() {
    this.scene = new THREE.Scene()
    this.cells = []
    this.foods = []
    this.foodGrid = new Map()
    this.cellGrid = new Map()
    this.clumps = []
    this.foodMesh = null
    this.tailMesh = null
    this.simTime = 0
    this.tailScale = 1
    this.nextTailIndex = 0
    this.freeTailIndices = []
    this.respawning = []
    this.senseAccum = 0

    this._v1 = new THREE.Vector3()
    this._v2 = new THREE.Vector3()
    this._v3 = new THREE.Vector3()
    this._v4 = new THREE.Vector3()
    this._v5 = new THREE.Vector3()
    this._v6 = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._m = new THREE.Matrix4()
    this._dummy = new THREE.Object3D()
    this._col = { dist: 0, x: 0, y: 0, z: 0 }
    this._fd = { rx: 0, ry: 0, rz: 0 }
  }

  attach(container) {
    const { scene, camera, renderer, controls, sphereShell } =
      createScene(container)
    this.scene = scene
    this.camera = camera
    this.renderer = renderer
    this.controls = controls
    this.sphereShell = sphereShell
  }

  buildWorld() {    for (let i = 0; i < CELL_COUNT; i++) {
      const cell = this.makeCell()
      this.cells.push(cell)
      this.scene.add(cell)
    }

    this.foodMesh = new THREE.InstancedMesh(foodGeo, foodMat, FOOD_COUNT)
    this.foodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.scene.add(this.foodMesh)
    this.generateClumps()
    for (let i = 0; i < FOOD_COUNT; i++) this.makeFood()
    this.buildFoodGrid()
    this.foodMesh.instanceMatrix.needsUpdate = true

    this.tailMesh = new THREE.InstancedMesh(
      tailGeo,
      tailMat,
      MAX_CELLS * TAIL_SEGMENTS,
    )
    this.tailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this._dummy.position.set(0, 0, 0)
    this._dummy.rotation.set(0, 0, 0)
    this._dummy.scale.set(0, 0, 0)
    this._dummy.updateMatrix()
    for (let i = 0; i < MAX_CELLS * TAIL_SEGMENTS; i++) {
      this.tailMesh.setMatrixAt(i, this._dummy.matrix)
    }
    this.scene.add(this.tailMesh)
    for (const c of this.cells) this.setTailColor(c)
    this.tailMesh.instanceColor.needsUpdate = true
  }

  reset() {
    for (const cell of this.cells) {
      this.scene.remove(cell)
      disposeObject3D(cell)
    }
    for (const mesh of [this.foodMesh, this.tailMesh]) {
      if (mesh) {
        this.scene.remove(mesh)
        mesh.dispose()
      }
    }
    this.cells = []
    this.foods = []
    this.foodGrid = new Map()
    this.cellGrid = new Map()
    this.clumps = []
    this.respawning = []
    this.simTime = 0
    this.tailScale = 1
    this.nextTailIndex = 0
    this.freeTailIndices = []
    this.senseAccum = 0
    this.foodMesh = null
    this.tailMesh = null
    this.buildWorld()
  }

  setTailColor(cell) {
    const d = cell.userData
    if (!this.tailMesh || !d.color) return
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      this.tailMesh.setColorAt(d.tailStart + i, d.color)
    }
    if (this.tailMesh.instanceColor) {
      this.tailMesh.instanceColor.needsUpdate = true
    }
  }

  allocTailIndex() {
    if (this.freeTailIndices.length) return this.freeTailIndices.pop()
    const idx = this.nextTailIndex
    this.nextTailIndex = Math.min(this.nextTailIndex + 1, MAX_CELLS)
    return idx
  }

  createCell(index, pos, heading, length) {
    const outer = new THREE.Mesh(
      makeBodyGeo(length),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.25,
        metalness: 0,
        transparent: true,
        opacity: 0.9,
      }),
    )

    const nucleus = new THREE.Mesh(
      unitOuterGeo,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.3,
      }),
    )

    const group = new THREE.Group()
    group.add(outer)
    group.add(nucleus)

    group.userData = {
      radius: length,
      maxLength: length * 2,
      mass: length * length * 0.25,
      color: new THREE.Color(),
      pos,
      vel: heading.clone().multiplyScalar(0.3),
      heading,
      tailDir: heading.clone().negate().normalize(),
      phase: Math.random() * Math.PI * 2,
      slow: 1,
      agitate: 0,
      whipT: 99,
      goPrev: 1,
      foodDir: new THREE.Vector3(),
      foodAmt: 0,
      foodPeak: 0,
      headingRate: 0,
      drive: 0,
      split: false,
      mito: null,
      splitting: false,
      dead: false,
      sideHidden: false,
      tailGrow: 1,
      index,
      tailStart: index * TAIL_SEGMENTS,
    }
    group.userData.outer = outer
    group.userData.nucleus = nucleus
    setCellAppearance(group, length)
    return group
  }

  makeCell() {
    const length = START_RADIUS + Math.random() * 0.04
    const pos = randomSurfacePoint()
    const normal = pos.clone().normalize()
    const heading = randomTangent(normal)
    return this.createCell(this.allocTailIndex(), pos, heading, length)
  }

  growCell(cell, amount) {
    const d = cell.userData
    const next = Math.min(d.radius + amount, d.maxLength)
    setCellAppearance(cell, next)
    if (next >= d.maxLength - 1e-6) d.split = true
  }

  mitose(parent) {
    if (this.cells.length + 2 > MAX_CELLS) return
    const d = parent.userData
    d.split = false
    const fullLen = d.radius
    const childLen = fullLen * 0.45
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

    const back = this.createCell(this.allocTailIndex(), backPos, headBack, childLen)
    const front = this.createCell(d.index, frontPos, headFront, childLen)
    back.userData.splitting = true
    front.userData.splitting = true
    back.userData.tailGrow = 0
    d.tailTransfer = true
    front.userData.mito = {
      t: 0,
      dur: MITO_TIME,
      parent,
      back,
      front,
      startPos,
      headBack,
      half,
    }
    d.splitting = true
    this.setTailColor(back)
    this.setTailColor(front)
    this.cells.push(back)
    this.cells.push(front)
    this.scene.add(back)
    this.scene.add(front)
  }

  placeTail(cell) {
    const d = cell.userData
    if (d.sideHidden) {
      this._dummy.position.set(0, 0, 0)
      this._dummy.rotation.set(0, 0, 0)
      this._dummy.scale.set(0, 0, 0)
      this._dummy.updateMatrix()
      for (let i = 0; i < TAIL_SEGMENTS; i++) {
        this.tailMesh.setMatrixAt(d.tailStart + i, this._dummy.matrix)
      }
      return
    }
    const grow = d.tailGrow
    const step = TAIL_LEN / TAIL_SEGMENTS
    const n = this._v1.copy(d.pos).normalize()
    const base = this._v2.copy(d.pos).addScaledVector(d.heading, -d.radius)
    const tailDir = d.tailDir
    const side = this._v3.crossVectors(n, tailDir)
    if (side.lengthSq() < 1e-8) {
      side.set(0, 0, 1).addScaledVector(n, -n.z).normalize()
    } else {
      side.normalize()
    }
    const up = this._v4.crossVectors(tailDir, side).normalize()
    const whip = Math.exp(-d.whipT / WHIP_TAU)
    const amp =
      TAIL_AMP * Math.max(d.agitate, 0.1) * (1 + WHIP_GAIN * whip) * grow
    const freq = TAIL_FREQ * (0.3 + 0.7 * d.agitate)
    const helix = TAIL_HELIX * smoothstep(d.agitate)
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const dist = i * step * grow
      const t = i / TAIL_SEGMENTS
      const taper = t * t
      const ph = this.simTime * freq + dist * TAIL_WAVE + d.phase
      const a = Math.sin(ph) * amp * taper
      const b = Math.cos(ph) * amp * taper * helix
      this._dummy.position
        .copy(base)
        .addScaledVector(tailDir, dist)
        .addScaledVector(side, a)
        .addScaledVector(up, b)
      const ts = this.tailScale
      this._dummy.scale.set(ts, ts, ts)
      this._dummy.rotation.set(0, 0, 0)
      this._dummy.updateMatrix()
      this.tailMesh.setMatrixAt(d.tailStart + i, this._dummy.matrix)
    }
  }

  updateTailState(d, dt) {
    const n = this._v1.copy(d.pos).normalize()
    const behind = this._v3.copy(d.heading).negate()
    behind.addScaledVector(n, -behind.dot(n))
    if (behind.lengthSq() > 1e-8) {
      behind.normalize()
      d.tailDir.addScaledVector(
        this._v2.copy(behind).sub(d.tailDir),
        TAIL_LAG_RATE * dt,
      )
      d.tailDir.addScaledVector(n, -d.tailDir.dot(n))
      d.tailDir.normalize()
    }
    const target = d.drive
    const up = target > d.agitate
    const rate = up ? AGITATE_UP : AGITATE_DOWN
    d.agitate += (target - d.agitate) * (1 - Math.exp(-rate * dt))
    d.agitate = THREE.MathUtils.clamp(d.agitate, 0, 1)
    if (!up && d.agitate < 0.02) d.agitate = 0
    if (target > GO_THRESH && d.goPrev <= GO_THRESH) d.whipT = 0
    d.whipT += dt
    d.goPrev = target
  }

  updateMito(cell, simDt) {
    const m = cell.userData.mito
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

    placeMitoChild(m, m.back, -dist)
    placeMitoChild(m, m.front, dist)

    const tailGrow = smoothstep(
      THREE.MathUtils.clamp((frac - MITO_HOLD) / MITO_FADE, 0, 1),
    )
    m.back.userData.tailGrow = tailGrow
    m.back.userData.drive = 0
    m.front.userData.drive = 0

    const pd = m.parent.userData
    pd.outer.material.depthWrite = false
    pd.outer.material.opacity = 0.75 * (1 - fadeK)
    pd.nucleus.material.transparent = true
    pd.nucleus.material.depthWrite = false
    pd.nucleus.material.needsUpdate = true
    pd.nucleus.material.opacity = 1 - fadeK

    if (m.t >= m.dur) this.finalizeMito(cell, m)
  }

  finalizeMito(cell, m) {
    cell.userData.mito = null
    m.back.userData.splitting = false
    m.front.userData.splitting = false
    m.parent.userData.dead = true
  }

  processSplits() {
    const snapshot = this.cells.slice()
    for (const cell of snapshot) {
      if (cell.userData.split) this.mitose(cell)
    }
  }

  removeCell(cell) {
    this.scene.remove(cell)
    disposeObject3D(cell)
    const d = cell.userData
    this._dummy.position.set(0, 0, 0)
    this._dummy.scale.set(0, 0, 0)
    this._dummy.rotation.set(0, 0, 0)
    this._dummy.updateMatrix()
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      this.tailMesh.setMatrixAt(d.tailStart + i, this._dummy.matrix)
    }
    this.tailMesh.instanceMatrix.needsUpdate = true
    if (!d.tailTransfer) this.freeTailIndices.push(d.index)
  }

  placeFood(food) {
    const s = food.visible ? food.scale : 0.0001
    this._dummy.position.copy(food.pos)
    this._dummy.scale.set(s, s, s)
    this._dummy.rotation.set(0, 0, 0)
    this._dummy.updateMatrix()
    this.foodMesh.setMatrixAt(food.index, this._dummy.matrix)
  }

  generateClumps() {
    const n = 18 + Math.floor(Math.random() * 14)
    for (let i = 0; i < n; i++) {
      this.clumps.push({
        center: randomUnitVector(),
        radius: 0.3 + Math.random() * 0.9,
        theta: (0.14 + Math.random() * 0.5) / SURFACE,
      })
    }
  }

  foodInClump(clump) {
    const t = randomTangent(clump.center)
    const ang = Math.sqrt(Math.random()) * clump.theta
    const q = new THREE.Quaternion().setFromAxisAngle(t, ang)
    return clump.center
      .clone()
      .applyQuaternion(q)
      .normalize()
      .multiplyScalar(SURFACE)
  }

  clumpPos() {
    if (Math.random() < 0.15) return randomSurfacePoint()
    return this.foodInClump(this.clumps[Math.floor(Math.random() * this.clumps.length)])
  }

  makeFood() {
    const r = 0.004 + Math.random() * 0.006
    const food = {
      pos: this.clumpPos(),
      r,
      scale: r / 0.05,
      respawn: 0,
      visible: true,
      index: this.foods.length,
      gridKey: null,
    }
    this.foods.push(food)
    this.placeFood(food)
    return food
  }

  addFoodToGrid(i) {
    const food = this.foods[i]
    const key = cellIndex(
      Math.floor(food.pos.x / GRID),
      Math.floor(food.pos.y / GRID),
      Math.floor(food.pos.z / GRID),
    )
    food.gridKey = key
    const bucket = this.foodGrid.get(key)
    if (bucket) bucket.push(i)
    else this.foodGrid.set(key, [i])
  }

  removeFoodFromGrid(i) {
    const food = this.foods[i]
    if (food.gridKey == null) return
    const bucket = this.foodGrid.get(food.gridKey)
    if (bucket) {
      const pos = bucket.indexOf(i)
      if (pos !== -1) bucket.splice(pos, 1)
    }
    food.gridKey = null
  }

  buildFoodGrid() {
    this.foodGrid.clear()
    for (let i = 0; i < this.foods.length; i++) {
      if (this.foods[i].visible) this.addFoodToGrid(i)
    }
  }

  foodDist(d, food, halfLen) {
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
    this._fd.rx = rx
    this._fd.ry = ry
    this._fd.rz = rz
    return Math.sqrt(ex * ex + ey * ey + ez * ez)
  }

  eatAndRespawn(simDt) {
    let dirty = false
    for (let i = this.respawning.length - 1; i >= 0; i--) {
      const foodIndex = this.respawning[i]
      const food = this.foods[foodIndex]
      food.respawn -= simDt
      if (food.respawn <= 0) {
        this.respawning.splice(i, 1)
        this.removeFoodFromGrid(foodIndex)
        food.pos = this.clumpPos()
        food.visible = true
        this.addFoodToGrid(foodIndex)
        this.placeFood(food)
        dirty = true
      }
    }

    for (const cell of this.cells) {
      const d = cell.userData
      if (d.mito || d.splitting || d.split) continue
      const halfLen = Math.max(d.radius - WIDTH, 0)
      let ate = 0
      const cx = Math.floor(d.pos.x / GRID)
      const cy = Math.floor(d.pos.y / GRID)
      const cz = Math.floor(d.pos.z / GRID)
      scan: for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let oz = -1; oz <= 1; oz++) {
            const bucket = this.foodGrid.get(cellIndex(cx + ox, cy + oy, cz + oz))
            if (!bucket) continue
            for (let k = 0; k < bucket.length; k++) {
              const foodIndex = bucket[k]
              const food = this.foods[foodIndex]
              if (!food.visible) continue
              if (this.foodDist(d, food, halfLen) < WIDTH + food.r) {
                this.growCell(cell, GROWTH_PER_FOOD)
                food.respawn = 2.5 + Math.random() * 8
                food.visible = false
                this.removeFoodFromGrid(foodIndex)
                this.respawning.push(foodIndex)
                this.placeFood(food)
                dirty = true
                if (++ate >= ABSORB_CAP) break scan
              }
            }
          }
        }
      }
    }

    if (dirty) this.foodMesh.instanceMatrix.needsUpdate = true
  }

  concentration() {
    for (const cell of this.cells) {
      const d = cell.userData
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
      for (let ox = -2; ox <= 2; ox++) {
        for (let oy = -2; oy <= 2; oy++) {
          for (let oz = -2; oz <= 2; oz++) {
            const bucket = this.foodGrid.get(cellIndex(cx + ox, cy + oy, cz + oz))
            if (!bucket) continue
            for (let k = 0; k < bucket.length; k++) {
              const food = this.foods[bucket[k]]
              if (!food.visible) continue
              const dd = this.foodDist(d, food, halfLen)
              if (dd < sense) {
                const w = 1 - dd / sense
                sum += w
                fx += this._fd.rx * w
                fy += this._fd.ry * w
                fz += this._fd.rz * w
              }
            }
          }
        }
      }
      d.slow = 1 + (GRAZE_RATE - 1) * (1 - Math.exp(-sum * GRAZE_GAIN))
      d.foodAmt = Math.min(sum, 1)
      const fb = Math.sqrt(fx * fx + fy * fy + fz * fz)
      d.foodPeak = sum > 0 ? fb / sum / sense : 0
      d.foodDir.set(fx, fy, fz)
    }
  }

  signedAngleTo(d, target) {
    const n = this._v3.copy(d.pos).normalize()
    const t = target.clone().addScaledVector(n, -target.dot(n))
    if (t.lengthSq() < 1e-6) return null
    t.normalize()
    const head = d.heading.clone().addScaledVector(n, -d.heading.dot(n))
    if (head.lengthSq() < 1e-6) return null
    head.normalize()
    const cross = this._v4.crossVectors(head, t)
    return Math.atan2(cross.dot(n), head.dot(t))
  }

  deflectHeading(d, awayWorld, intensity) {
    const ang = this.signedAngleTo(d, awayWorld)
    if (ang == null) return
    d.headingRate += THREE.MathUtils.clamp(ang * COLLISION_KICK, -0.4, 0.4) * intensity
  }

  capsuleDist(a, b) {
    const ha = Math.max(a.radius - WIDTH, 0)
    const hb = Math.max(b.radius - WIDTH, 0)
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
      this._col.dist = dist
      this._col.x = dx / dist
      this._col.y = dy / dist
      this._col.z = dz / dist
    } else {
      this._col.dist = 0
      const ddx = b.pos.x - a.pos.x
      const ddy = b.pos.y - a.pos.y
      const ddz = b.pos.z - a.pos.z
      const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1
      this._col.x = ddx / dd
      this._col.y = ddy / dd
      this._col.z = ddz / dd
    }
  }

  solveCollisions(simDt) {
    const n = this.cells.length
    this.cellGrid.clear()
    for (let i = 0; i < n; i++) {
      const d = this.cells[i].userData
      if (d.mito || d.splitting) continue
      const key = cellIndex(
        Math.floor(d.pos.x / CELL_GRID),
        Math.floor(d.pos.y / CELL_GRID),
        Math.floor(d.pos.z / CELL_GRID),
      )
      const bucket = this.cellGrid.get(key)
      if (bucket) bucket.push(i)
      else this.cellGrid.set(key, [i])
    }

    for (let i = 0; i < n; i++) {
      const a = this.cells[i].userData
      if (a.mito || a.splitting) continue
      const cx = Math.floor(a.pos.x / CELL_GRID)
      const cy = Math.floor(a.pos.y / CELL_GRID)
      const cz = Math.floor(a.pos.z / CELL_GRID)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let oz = -1; oz <= 1; oz++) {
            const bucket = this.cellGrid.get(
              cellIndex(cx + ox, cy + oy, cz + oz),
            )
            if (!bucket) continue
            for (let k = 0; k < bucket.length; k++) {
              const j = bucket[k]
              if (j <= i) continue
              const b = this.cells[j].userData
              if (b.mito || b.splitting) continue
              const cdx = b.pos.x - a.pos.x
              const cdy = b.pos.y - a.pos.y
              const cdz = b.pos.z - a.pos.z
              const bound = a.radius + b.radius + 2 * WIDTH
              if (cdx * cdx + cdy * cdy + cdz * cdz >= bound * bound) continue

              this.capsuleDist(a, b)
              const contact = 2 * WIDTH
              if (this._col.dist >= contact) continue
              const overlap = contact - this._col.dist
              const nx = this._col.x
              const ny = this._col.y
              const nz = this._col.z
              const invA = 1 / a.mass
              const invB = 1 / b.mass
              const invSum = invA + invB

              const impulse = (overlap * SPRING) / invSum
              a.vel.x -= nx * impulse * invA * simDt
              a.vel.y -= ny * impulse * invA * simDt
              a.vel.z -= nz * impulse * invA * simDt
              b.vel.x += nx * impulse * invB * simDt
              b.vel.y += ny * impulse * invB * simDt
              b.vel.z += nz * impulse * invB * simDt

              this.deflectHeading(
                a,
                this._v6.set(-nx, -ny, -nz),
                Math.min(overlap * 8, 1),
              )
              this.deflectHeading(
                b,
                this._v5.set(nx, ny, nz),
                Math.min(overlap * 8, 1),
              )

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

  advance(dt) {
    this.simTime += dt

    for (const cell of this.cells) {
      const d = cell.userData
      if (d.mito || d.splitting) {
        d.drive = 0
        continue
      }
      const normal = this._v1.copy(d.pos).normalize()

      d.heading.addScaledVector(normal, -d.heading.dot(normal)).normalize()
      const slowFrac = smoothstep(
        THREE.MathUtils.clamp(
          (d.radius - d.maxLength * MITO_SLOW_FRAC) /
            (d.maxLength * (1 - MITO_SLOW_FRAC)),
          0,
          1,
        ),
      )
      d.drive = d.slow * (1 - slowFrac)

      if (d.foodAmt > 0.01 && d.foodPeak > PEAK_MIN) {
        const ang = this.signedAngleTo(d, d.foodDir)
        if (ang != null) {
          d.headingRate +=
            THREE.MathUtils.clamp(ang * CHEMO_ACCEL, -MAX_ACCEL, MAX_ACCEL) *
            dt
        }
      }
      d.headingRate *= Math.exp(-ANG_DRAG * dt)
      d.headingRate = THREE.MathUtils.clamp(d.headingRate, -MAX_SPIN, MAX_SPIN)
      this._q.setFromAxisAngle(normal, d.headingRate * dt)
      d.heading
        .applyQuaternion(this._q)
        .addScaledVector(normal, -d.heading.dot(normal))
        .normalize()

      d.vel.addScaledVector(d.heading, THRUST * d.drive * dt)
      d.vel.multiplyScalar(Math.exp(-DRAG * dt))
      d.vel.addScaledVector(normal, -d.vel.dot(normal))

      d.pos.addScaledVector(d.vel, dt)
      d.pos.setLength(SURFACE)
      cell.position.copy(d.pos)

      const normal2 = this._v5.copy(d.pos).normalize()
      const fwd = d.heading
        .clone()
        .addScaledVector(normal2, -d.heading.dot(normal2))
        .normalize()
      const right = this._v2.crossVectors(fwd, normal2)
      if (right.lengthSq() < 1e-6) {
        right.set(0, 1, 0).addScaledVector(normal2, -normal2.y).normalize()
      } else {
        right.normalize()
      }
      this._m.makeBasis(fwd, normal2, right)
      cell.quaternion.setFromRotationMatrix(this._m)
    }

    this.solveCollisions(dt)
    this.eatAndRespawn(dt)
    this.senseAccum += dt
    if (this.senseAccum >= SENSE_PERIOD) {
      this.concentration()
      this.senseAccum = 0
    }
    this.processSplits()
    for (const cell of this.cells) this.updateMito(cell, dt)
    for (const cell of this.cells) this.updateTailState(cell.userData, dt)
    for (let i = this.cells.length - 1; i >= 0; i--) {
      if (this.cells[i].userData.dead) {
        this.removeCell(this.cells[i])
        this.cells.splice(i, 1)
      }
    }
  }

  renderTails() {
    for (const cell of this.cells) this.placeTail(cell)
    this.tailMesh.instanceMatrix.needsUpdate = true
  }

  updateVisibility() {
    if (!this.camera) return
    const cam = this.camera.position
    const len = cam.length() || 1
    const cx = cam.x / len
    const cy = cam.y / len
    const cz = cam.z / len
    for (const cell of this.cells) {
      const d = cell.userData
      const cos = (d.pos.x * cx + d.pos.y * cy + d.pos.z * cz) / SURFACE
      const visible = cos > CULL_COS
      cell.visible = visible
      d.sideHidden = !visible
    }
  }

  step(simDt) {
    if (simDt > 0) {
      const steps = Math.min(Math.max(Math.ceil(simDt / FIXED_DT), 1), MAX_STEPS)
      const dt = simDt / steps
      for (let i = 0; i < steps; i++) this.advance(dt)
    }
  }

  render(tailScale) {
    this.tailScale = tailScale
    this.updateVisibility()
    this.renderTails()
    if (this.controls) this.controls.update()
    if (this.renderer) this.renderer.render(this.scene, this.camera)
  }

  frame(simDt, tailScale) {
    this.step(simDt)
    this.render(tailScale)
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  dispose() {
    if (this.controls) this.controls.dispose()
    if (this.renderer) this.renderer.dispose()
    disposeSharedMaterials()
    if (this.sphereShell) {
      this.sphereShell.geometry.dispose()
      this.sphereShell.material.dispose()
    }
    this.foodMesh.dispose()
    this.tailMesh.dispose()
    this.cells.forEach((c) => disposeObject3D(c))
    if (this.renderer) this.renderer.domElement.remove()
  }
}
