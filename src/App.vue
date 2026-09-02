<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const SPHERE_RADIUS = 5
const SURFACE = SPHERE_RADIUS + 0.06
const CELL_COUNT = 225
const MAX_CELLS = 500
const FOOD_COUNT = 26000
const GRID = 0.35
const SPRING = 22

const MIN_RADIUS = 0.07
const MAX_RADIUS = 0.26
const START_RADIUS = 0.09
const GROWTH_PER_FOOD = 0.0005
const ABSORB_CAP = 3
const MITO_TIME = 90
const MITO_HOLD = 0.15
const MITO_SEP = 0.25

const WIDTH = 0.06
const TAIL_SEGMENTS = 24
const TAIL_LEN = 0.15
const TAIL_AMP = 0.1
const TAIL_FREQ = 24.0
const TAIL_WAVE = 24.0
const THRUST = 12
const DRAG = 22
const GRAZE_RATE = 0.02
const GRAZE_GAIN = 1.8
const ANG_DRAG = 12
const CHEMO_ACCEL = 3.5
const MAX_ACCEL = 1.2
const COLLISION_KICK = 0.5
const MAX_SPIN = 2.0
const PEAK_MIN = 0.18
const SENSE_BOOST = 0.25

const canvasHolder = ref(null)
let renderer, scene, camera, controls, animationId
let cells = []
let foods = []
const foodGrid = new Map()
let clumps = []
let sphereShell, foodMesh, tailMesh
let lastTime = performance.now()
let simTime = 0

const tailsActive = ref(true)
const simSpeed = ref(50)

const unitOuterGeo = new THREE.SphereGeometry(1, 40, 40)
const foodGeo = new THREE.SphereGeometry(0.05, 8, 8)
const tailGeo = new THREE.SphereGeometry(0.008, 6, 6)
const foodMat = new THREE.MeshStandardMaterial({
  color: 0x9a917e,
  emissive: 0x504b3e,
  emissiveIntensity: 0.3,
  roughness: 0.7,
})
const tailMat = new THREE.MeshStandardMaterial({
  color: 0x8ae8c0,
  emissive: 0x1f8a5f,
  emissiveIntensity: 0.7,
  roughness: 0.5,
})

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _v4 = new THREE.Vector3()
const _v5 = new THREE.Vector3()
const _v6 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _dummy = new THREE.Object3D()
const _col = { dist: 0, x: 0, y: 0, z: 0 }

function randomUnitVector() {
  let v = new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
  )
  while (v.lengthSq() < 1e-6) {
    v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
  }
  return v.normalize()
}

function randomSurfacePoint() {
  return randomUnitVector().multiplyScalar(SURFACE)
}

function randomTangent(normal) {
  const v = randomUnitVector()
  const t = new THREE.Vector3().crossVectors(normal, v)
  if (t.lengthSq() < 1e-6) t.set(0, 1, 0)
  return t.normalize()
}

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

function setTailColor(cell) {
  const d = cell.userData
  if (!tailMesh || !d.color) return
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    tailMesh.setColorAt(d.tailStart + i, d.color)
  }
  if (tailMesh.instanceColor) tailMesh.instanceColor.needsUpdate = true
}

function createCell(index, pos, heading, length) {
  const outer = new THREE.Mesh(
    makeBodyGeo(length),
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.2,
      transmission: 0.5,
      thickness: 0.4,
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
    phase: Math.random() * Math.PI * 2,
    slow: 1,
    foodDir: new THREE.Vector3(),
    foodAmt: 0,
    foodPeak: 0,
    headingRate: 0,
    drive: 0,
    split: false,
    mito: null,
    splitting: false,
    dead: false,
    tailStart: index * TAIL_SEGMENTS,
  }
  group.userData.outer = outer
  group.userData.nucleus = nucleus
  setCellAppearance(group, length)
  return group
}

function makeCell(index) {
  const length = START_RADIUS + Math.random() * 0.04
  const pos = randomSurfacePoint()
  const normal = pos.clone().normalize()
  const heading = randomTangent(normal)
  return createCell(index, pos, heading, length)
}

function growCell(cell, amount) {
  const d = cell.userData
  const next = Math.min(d.radius + amount, d.maxLength)
  setCellAppearance(cell, next)
  if (next >= d.maxLength - 1e-6) d.split = true
}

function mitose(parent) {
  if (cells.length + 2 > MAX_CELLS) return
  const d = parent.userData
  d.split = false
  const fullLen = d.radius
  const childLen = fullLen * 0.5
  const phead = d.heading.clone()
  const n0 = d.pos.clone().normalize()
  const startPos = d.pos.clone()
  const offLen = childLen
  const backEnd = startPos.clone().addScaledVector(phead, -offLen)
  const frontEnd = startPos.clone().addScaledVector(phead, offLen)
  const headBack = phead.clone().negate().addScaledVector(n0, phead.dot(n0)).normalize()
  const headFront = phead.clone().addScaledVector(n0, -phead.dot(n0)).normalize()

  const back = createCell(cells.length, startPos, headBack, fullLen)
  const front = createCell(cells.length + 1, startPos, headFront, fullLen)
  back.userData.splitting = true
  front.userData.splitting = true
  front.userData.mito = {
    t: 0,
    dur: MITO_TIME,
    parent,
    back,
    front,
    childLen,
    startPos,
    backEnd,
    frontEnd,
    shrunk: false,
    full: computeCellColor(fullLen),
    short: computeCellColor(childLen),
  }
  d.splitting = true
  setTailColor(back)
  setTailColor(front)
  cells.push(back)
  cells.push(front)
  scene.add(back)
  scene.add(front)
}

function smoothstep(x) {
  x = THREE.MathUtils.clamp(x, 0, 1)
  return x * x * (3 - 2 * x)
}

function placeMitoCell(c, endPos, heading, off) {
  c.pos.set(
    this.startPos.x + (endPos.x - this.startPos.x) * off,
    this.startPos.y + (endPos.y - this.startPos.y) * off,
    this.startPos.z + (endPos.z - this.startPos.z) * off,
  )
  c.pos.multiplyScalar(SURFACE / (c.pos.length() || 1))
  c.heading.copy(heading)
  const n = c.pos.clone().normalize()
  c.heading.addScaledVector(n, -c.heading.dot(n)).normalize()
}

function updateMito(cell, simDt) {
  const m = cell.userData.mito
  if (!m) return
  m.t += simDt
  const frac = THREE.MathUtils.clamp(m.t / m.dur, 0, 1)
  const fadeK = smoothstep(frac)
  const sp = smoothstep(
    THREE.MathUtils.clamp((frac - MITO_HOLD) / MITO_SEP, 0, 1),
  )
  const off = 0.5 + 0.5 * sp
  const sepEnd = MITO_HOLD + MITO_SEP

  placeMitoCell.call(m, m.back.userData, m.backEnd, m.back.userData.heading, off)
  placeMitoCell.call(m, m.front.userData, m.frontEnd, m.front.userData.heading, off)

  if (frac >= sepEnd && !m.shrunk) {
    m.shrunk = true
    setCellAppearance(m.back, m.childLen)
    setCellAppearance(m.front, m.childLen)
    m.back.userData.maxLength = m.childLen * 2
    m.front.userData.maxLength = m.childLen * 2
  }

  const col = m.full.color.clone().lerp(m.short.color, fadeK)
  applyCellColor(m.back, col)
  applyCellColor(m.front, col)
  const emi = m.full.emissive.clone().lerp(m.short.emissive, fadeK)
  m.back.userData.nucleus.material.emissive.copy(emi)
  m.front.userData.nucleus.material.emissive.copy(emi)

  const pd = m.parent.userData
  const op = 1 - smoothstep(frac)
  pd.outer.material.opacity = 0.9 * op
  pd.nucleus.material.transparent = true
  pd.nucleus.material.opacity = op

  if (m.t >= m.dur) finalizeMito(cell, m)
}

function finalizeMito(cell, m) {
  cell.userData.mito = null
  m.back.userData.splitting = false
  m.front.userData.splitting = false
  m.parent.userData.dead = true
}

function processSplits() {
  const snapshot = cells.slice()
  for (const cell of snapshot) {
    if (cell.userData.split) mitose(cell)
  }
}

function removeCell(cell) {
  scene.remove(cell)
  cell.traverse((obj) => {
    obj.geometry?.dispose()
    if (obj.material) {
      Array.isArray(obj.material)
        ? obj.material.forEach((mt) => mt.dispose())
        : obj.material.dispose()
    }
  })
  const d = cell.userData
  _dummy.position.set(0, 0, 0)
  _dummy.scale.set(0, 0, 0)
  _dummy.rotation.set(0, 0, 0)
  _dummy.updateMatrix()
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    tailMesh.setMatrixAt(d.tailStart + i, _dummy.matrix)
  }
  tailMesh.instanceMatrix.needsUpdate = true
}

function placeFood(food) {
  const s = food.visible ? food.scale : 0.0001
  _dummy.position.copy(food.pos)
  _dummy.scale.set(s, s, s)
  _dummy.rotation.set(0, 0, 0)
  _dummy.updateMatrix()
  foodMesh.setMatrixAt(food.index, _dummy.matrix)
}

function generateClumps() {
  const n = 9 + Math.floor(Math.random() * 8)
  for (let i = 0; i < n; i++) {
    clumps.push({
      center: randomUnitVector(),
      radius: 0.3 + Math.random() * 1.1,
      theta: (0.3 + Math.random() * 1.1) / SURFACE,
    })
  }
}

function foodInClump(clump) {
  const t = randomTangent(clump.center)
  const ang = Math.sqrt(Math.random()) * clump.theta
  const q = new THREE.Quaternion().setFromAxisAngle(t, ang)
  return clump.center.clone().applyQuaternion(q).normalize().multiplyScalar(
    SURFACE,
  )
}

function clumpPos() {
  if (Math.random() < 0.15) return randomSurfacePoint()
  return foodInClump(clumps[Math.floor(Math.random() * clumps.length)])
}

function makeFood() {
  const r = 0.004 + Math.random() * 0.006
  const food = {
    pos: clumpPos(),
    r,
    scale: r / 0.05,
    respawn: 0,
    visible: true,
    index: foods.length,
  }
  foods.push(food)
  placeFood(food)
  return food
}

function cellIndex(cx, cy, cz) {
  return ((cx + 2048) * 4096 + (cy + 2048)) * 4096 + (cz + 2048)
}

function addFoodToGrid(i) {
  const food = foods[i]
  const key = cellIndex(
    Math.floor(food.pos.x / GRID),
    Math.floor(food.pos.y / GRID),
    Math.floor(food.pos.z / GRID),
  )
  const bucket = foodGrid.get(key)
  if (bucket) bucket.push(i)
  else foodGrid.set(key, [i])
}

function updateFood(simDt) {
  foodGrid.clear()
  for (let i = 0; i < foods.length; i++) {
    const food = foods[i]
    if (food.respawn > 0) {
      food.respawn -= simDt
      if (food.respawn <= 0) {
        food.pos = clumpPos()
        food.visible = true
      }
    }
    if (food.visible) addFoodToGrid(i)
    placeFood(food)
  }

  for (const cell of cells) {
    const d = cell.userData
    if (d.mito || d.splitting || d.split) continue
    let sum = 0, fx = 0, fy = 0, fz = 0
    const ax = d.heading
    const halfLen = Math.max(d.radius - WIDTH, 0)
    const sense = WIDTH + SENSE_BOOST
    let ate = 0
    const cx = Math.floor(d.pos.x / GRID)
    const cy = Math.floor(d.pos.y / GRID)
    const cz = Math.floor(d.pos.z / GRID)
    scan: for (let ox = -2; ox <= 2; ox++) {
      for (let oy = -2; oy <= 2; oy++) {
        for (let oz = -2; oz <= 2; oz++) {
          const bucket = foodGrid.get(cellIndex(cx + ox, cy + oy, cz + oz))
          if (!bucket) continue
          for (let k = 0; k < bucket.length; k++) {
            const food = foods[bucket[k]]
            if (!food.visible) continue
            const rx = food.pos.x - d.pos.x
            const ry = food.pos.y - d.pos.y
            const rz = food.pos.z - d.pos.z
            let t = rx * ax.x + ry * ax.y + rz * ax.z
            if (t > halfLen) t = halfLen
            else if (t < -halfLen) t = -halfLen
            const px = d.pos.x + ax.x * t
            const py = d.pos.y + ax.y * t
            const pz = d.pos.z + ax.z * t
            const ex = food.pos.x - px
            const ey = food.pos.y - py
            const ez = food.pos.z - pz
            const dd = Math.sqrt(ex * ex + ey * ey + ez * ez)
            if (dd < sense) {
              const w = 1 - dd / sense
              sum += w
              fx += rx * w
              fy += ry * w
              fz += rz * w
            }
            if (dd < WIDTH + food.r) {
              growCell(cell, GROWTH_PER_FOOD)
              food.respawn = 2.5 + Math.random() * 8
              food.visible = false
              placeFood(food)
              if (++ate >= ABSORB_CAP) break scan
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

  foodMesh.instanceMatrix.needsUpdate = true
}

function init() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a0d14)
  scene.fog = new THREE.Fog(0x0a0d14, 18, 34)

  camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  )
  camera.position.set(0, 5.5, 9)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  canvasHolder.value.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06

  scene.add(new THREE.AmbientLight(0xffffff, 0.45))
  const point = new THREE.PointLight(0x8ab6ff, 30, 40)
  point.position.set(0, 4, 6)
  scene.add(point)
  const rim = new THREE.PointLight(0xff8ab6, 14, 40)
  rim.position.set(-6, -3, -4)
  scene.add(rim)

  sphereShell = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32),
    new THREE.MeshBasicMaterial({
      color: 0x131a2a,
      side: THREE.FrontSide,
    }),
  )
  scene.add(sphereShell)

  for (let i = 0; i < CELL_COUNT; i++) {
    const cell = makeCell(i)
    cells.push(cell)
    scene.add(cell)
  }

  foodMesh = new THREE.InstancedMesh(foodGeo, foodMat, FOOD_COUNT)
  foodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(foodMesh)
  generateClumps()
  for (let i = 0; i < FOOD_COUNT; i++) makeFood()
  foodMesh.instanceMatrix.needsUpdate = true

  tailMesh = new THREE.InstancedMesh(tailGeo, tailMat, MAX_CELLS * TAIL_SEGMENTS)
  tailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _dummy.position.set(0, 0, 0)
  _dummy.rotation.set(0, 0, 0)
  _dummy.scale.set(0, 0, 0)
  _dummy.updateMatrix()
  for (let i = 0; i < MAX_CELLS * TAIL_SEGMENTS; i++) {
    tailMesh.setMatrixAt(i, _dummy.matrix)
  }
  scene.add(tailMesh)
  for (const c of cells) setTailColor(c)
  tailMesh.instanceColor.needsUpdate = true
}

function signedAngleTo(d, target) {
  const n = d.pos.clone().normalize()
  const t = _v3.copy(target).addScaledVector(n, -target.dot(n))
  if (t.lengthSq() < 1e-6) return null
  t.normalize()
  const head = _v4.copy(d.heading).addScaledVector(n, -d.heading.dot(n))
  if (head.lengthSq() < 1e-6) return null
  head.normalize()
  const cross = _v5.crossVectors(head, t)
  return Math.atan2(cross.dot(n), head.dot(t))
}

function deflectHeading(d, awayWorld, intensity) {
  const ang = signedAngleTo(d, awayWorld)
  if (ang == null) return
  d.headingRate +=
    THREE.MathUtils.clamp(ang * COLLISION_KICK, -0.4, 0.4) * intensity
}

function capsuleDist(a, b) {
  const ha = Math.max(a.radius - WIDTH, 0)
  const hb = Math.max(b.radius - WIDTH, 0)
  const dhx = a.heading.x * ha, dhy = a.heading.y * ha, dhz = a.heading.z * ha
  const ehx = b.heading.x * hb, ehy = b.heading.y * hb, ehz = b.heading.z * hb
  const p1x = a.pos.x - dhx, p1y = a.pos.y - dhy, p1z = a.pos.z - dhz
  const d1x = 2 * dhx, d1y = 2 * dhy, d1z = 2 * dhz
  const p2x = b.pos.x - ehx, p2y = b.pos.y - ehy, p2z = b.pos.z - ehz
  const d2x = 2 * ehx, d2y = 2 * ehy, d2z = 2 * ehz
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z
  const a1 = d1x * d1x + d1y * d1y + d1z * d1z
  const e = d2x * d2x + d2y * d2y + d2z * d2z
  const f = d2x * rx + d2y * ry + d2z * rz
  const EPS = 1e-9
  let s = 0, t = 0
  if (a1 <= EPS && e <= EPS) {
    s = 0; t = 0
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
  const c1x = p1x + d1x * s, c1y = p1y + d1y * s, c1z = p1z + d1z * s
  const c2x = p2x + d2x * t, c2y = p2y + d2y * t, c2z = p2z + d2z * t
  const dx = c2x - c1x, dy = c2y - c1y, dz = c2z - c1z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist > 1e-9) {
    _col.dist = dist
    _col.x = dx / dist
    _col.y = dy / dist
    _col.z = dz / dist
  } else {
    _col.dist = 0
    const ddx = b.pos.x - a.pos.x, ddy = b.pos.y - a.pos.y, ddz = b.pos.z - a.pos.z
    const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1
    _col.x = ddx / dd
    _col.y = ddy / dd
    _col.z = ddz / dd
  }
}

function solveCollisions(simDt) {
  const n = cells.length
  for (let i = 0; i < n; i++) {
    const a = cells[i].userData
    for (let j = i + 1; j < n; j++) {
      const b = cells[j].userData
      if (a.mito || a.splitting || b.mito || b.splitting) continue
      const cdx = b.pos.x - a.pos.x
      const cdy = b.pos.y - a.pos.y
      const cdz = b.pos.z - a.pos.z
      const bound = a.radius + b.radius + 2 * WIDTH
      if (cdx * cdx + cdy * cdy + cdz * cdz >= bound * bound) continue

      capsuleDist(a, b)
      const contact = 2 * WIDTH
      if (_col.dist >= contact) continue
      const overlap = contact - _col.dist
      const nx = _col.x, ny = _col.y, nz = _col.z
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

      deflectHeading(a, _v6.set(-nx, -ny, -nz), Math.min(overlap * 8, 1))
      deflectHeading(b, _v6.set(nx, ny, nz), Math.min(overlap * 8, 1))

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

function animate() {
  animationId = requestAnimationFrame(animate)
  const now = performance.now()
  const rawDt = Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now

  const timeScale = simSpeed.value / 100
  simTime += rawDt * timeScale
  const simDt = rawDt * timeScale
  const power = tailsActive.value ? 1 : 0

  for (const cell of cells) {
    const d = cell.userData
    if (d.mito || d.splitting) {
      d.drive = power
      continue
    }
    const normal = _v1.copy(d.pos).normalize()

    d.heading.addScaledVector(normal, -d.heading.dot(normal)).normalize()

    d.drive = power * d.slow

    if (d.foodAmt > 0.01 && d.foodPeak > PEAK_MIN) {
      const ang = signedAngleTo(d, d.foodDir)
      if (ang != null) {
        d.headingRate +=
          THREE.MathUtils.clamp(ang * CHEMO_ACCEL, -MAX_ACCEL, MAX_ACCEL) *
          simDt
      }
    }
    d.headingRate *= Math.exp(-ANG_DRAG * simDt)
    d.headingRate = THREE.MathUtils.clamp(d.headingRate, -MAX_SPIN, MAX_SPIN)
    _q.setFromAxisAngle(normal, d.headingRate * simDt)
    d.heading.applyQuaternion(_q).addScaledVector(normal, -d.heading.dot(normal)).normalize()

    d.vel.addScaledVector(d.heading, THRUST * d.drive * simDt)
    d.vel.multiplyScalar(Math.exp(-DRAG * simDt))
    d.vel.addScaledVector(normal, -d.vel.dot(normal))

    d.pos.addScaledVector(d.vel, simDt)
    d.pos.setLength(SURFACE)

    cell.position.copy(d.pos)

    const normal2 = _v1.copy(d.pos).normalize()
    const fwd = d.heading
      .clone()
      .addScaledVector(normal2, -d.heading.dot(normal2))
      .normalize()
    const right = _v2.crossVectors(fwd, normal2)
    if (right.lengthSq() < 1e-6) {
      right.set(0, 1, 0).addScaledVector(normal2, -normal2.y).normalize()
    } else {
      right.normalize()
    }
    _m.makeBasis(fwd, normal2, right)
    cell.quaternion.setFromRotationMatrix(_m)

    const step = TAIL_LEN / TAIL_SEGMENTS
    const base = -d.radius
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const x = base - i * step
      const t = i / TAIL_SEGMENTS
      const z =
        Math.sin(simTime * TAIL_FREQ * d.drive - x * TAIL_WAVE + d.phase) *
        TAIL_AMP *
        (t * t) *
        d.drive
      _v2.set(x, 0, z).applyQuaternion(cell.quaternion).add(cell.position)
      _dummy.position.copy(_v2)
      const ts = power ? 1 : 0.0001
      _dummy.scale.set(ts, ts, ts)
      _dummy.rotation.set(0, 0, 0)
      _dummy.updateMatrix()
      tailMesh.setMatrixAt(d.tailStart + i, _dummy.matrix)
    }
  }
  tailMesh.instanceMatrix.needsUpdate = true

  solveCollisions(simDt)
  updateFood(simDt)
  processSplits()
  for (const cell of cells) updateMito(cell, simDt)
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i].userData.dead) {
      removeCell(cells[i])
      cells.splice(i, 1)
    }
  }

  controls.update()
  renderer.render(scene, camera)
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

onMounted(() => {
  init()
  animate()
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', onResize)
  controls.dispose()
  renderer.dispose()
  foodGeo.dispose()
  foodMat.dispose()
  tailGeo.dispose()
  tailMat.dispose()
  unitOuterGeo.dispose()
  sphereShell.geometry.dispose()
  sphereShell.material.dispose()
  foodMesh.dispose()
  tailMesh.dispose()
  cells.forEach((c) =>
    c.traverse((obj) => {
      obj.geometry?.dispose()
      if (obj.material) {
        Array.isArray(obj.material)
          ? obj.material.forEach((m) => m.dispose())
          : obj.material.dispose()
      }
    }),
  )
  renderer.domElement.remove()
})
</script>

<template>
  <div ref="canvasHolder" class="canvas-holder"></div>
  <div class="overlay">
    <h1>Cell</h1>
    <p>bacteria graze the sphere · drag to orbit · scroll to zoom</p>
    <div class="control">
      <label for="speed">sim speed</label>
      <input
        id="speed"
        type="range"
        min="0"
        max="1000"
        step="20"
        v-model.number="simSpeed"
      />
      <span class="readout">{{ simSpeed }}%</span>
    </div>
    <div class="control">
      <label for="tails">tails</label>
      <input id="tails" type="checkbox" v-model="tailsActive" />
      <span class="readout">{{ tailsActive ? 'on' : 'off' }}</span>
    </div>
  </div>
</template>

<style scoped>
.canvas-holder {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.overlay {
  position: fixed;
  top: 28px;
  left: 32px;
  color: #e8ecf3;
  pointer-events: none;
  user-select: none;
  font-family: system-ui, sans-serif;
  z-index: 1;
}

.overlay h1 {
  margin: 0 0 6px;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.5px;
}

.overlay p {
  margin: 0;
  font-size: 13px;
  color: #8a93a6;
}

.control {
  margin-top: 22px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #8a93a6;
  pointer-events: auto;
}

.control label {
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-size: 11px;
}

.control input[type='range'] {
  width: 140px;
  accent-color: #6fa8ff;
  cursor: pointer;
}

.control .readout {
  min-width: 36px;
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
}
</style>
