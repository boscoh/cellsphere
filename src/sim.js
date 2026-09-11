import * as THREE from 'three'
import {
  SURFACE,
  PREY_COUNT,
  PRED_COUNT,
  MAX_CELLS,
  FOOD_COUNT,
  SPRING,
  FIXED_DT,
  MAX_STEPS,
  ENERGY_MAX,
  MITO_SLOW_FRAC,
  STARVE_SLOW,
  THRUST,
  DRAG,
  ANG_DRAG,
  STEER_GAIN,
  TAIL_TURN,
  COLLISION_KICK,
  MAX_SPIN,
  PEAK_MIN,
  SENSE_PERIOD,
  CELL_GRID,
  PRED_RANGE,
  PRED_DRIVE,
} from './constants'
import { smoothstep, cellIndex } from './math'
import {
  foodGeo,
  foodMat,
  disposeSharedMaterials,
} from './materials'
import {
  makeCell,
  mitose,
  clearTail,
  placeTail,
  warmTail,
  updateTailState,
  updateTailBend,
  updateMito,
  updateEnergy,
  updateStarvation,
  initBodyPools,
  removeBody,
  disposeBodyPools,
  disposeBodyGeos,
  disposeTailPool,
} from './cells'
import {
  generateClumps,
  makeFood,
  buildFoodGrid,
  eatAndRespawn,
  concentration,
} from './food'
import { predation, predatorSense, forEachNearbyCell } from './predator'
import { createScene } from './sceneSetup'
import { renderView } from './render'
import { createPerf } from './perf'

export class Simulation {
  constructor() {
    this.scene = new THREE.Scene()
    this.cells = []
    this.foods = []
    this.foodGrid = new Map()
    this.cellGrid = new Map()
    this.clumps = []
    this.foodMesh = null
    this.tailChunks = []
    this.simTime = 0
    this.tailScale = 1
    this.tailsHidden = false
    this.nextTailIndex = 0
    this.freeTailIndices = []
    this.respawning = []
    this.senseAccum = 0
    this.tailSimTime = 0
    this.events = {
      preyBirths: 0,
      predBirths: 0,
      preyStarved: 0,
      predStarved: 0,
      predKills: 0,
    }

    this._v1 = new THREE.Vector3()
    this._v2 = new THREE.Vector3()
    this._v3 = new THREE.Vector3()
    this._v4 = new THREE.Vector3()
    this._v5 = new THREE.Vector3()
    this._v6 = new THREE.Vector3()
    this._v7 = new THREE.Vector3()
    this._v8 = new THREE.Vector3()
    this._v9 = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._m = new THREE.Matrix4()
    this._dummy = new THREE.Object3D()
    this._col = { dist: 0, x: 0, y: 0, z: 0 }
    this._fd = { rx: 0, ry: 0, rz: 0 }
    this._eatContact = []
    this._one = new THREE.Vector3(1, 1, 1)
    this._camDir = new THREE.Vector3()
    this.perf = createPerf()
    initBodyPools(this)
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

  buildWorld() {
    for (let i = 0; i < Math.min(PREY_COUNT, MAX_CELLS); i++) {
      this.cells.push(makeCell(this, 0))
    }
    for (let i = 0; i < Math.min(PRED_COUNT, MAX_CELLS - this.cells.length); i++) {
      this.cells.push(makeCell(this, 1))
    }

    this.foodMesh = new THREE.InstancedMesh(foodGeo, foodMat, FOOD_COUNT)
    this.foodMesh.frustumCulled = false
    this.foodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.scene.add(this.foodMesh)
    generateClumps(this)
    for (let i = 0; i < FOOD_COUNT; i++) makeFood(this)
    buildFoodGrid(this)
    this.foodMesh.instanceMatrix.needsUpdate = true
  }

  reset() {
    disposeBodyPools(this)
    disposeTailPool(this)
    if (this.foodMesh) {
      this.scene.remove(this.foodMesh)
      this.foodMesh.dispose()
    }
    this.cells = []
    this.foods = []
    this.foodGrid = new Map()
    this.cellGrid = new Map()
    this.clumps = []
    this.respawning = []
    this.simTime = 0
    this.tailScale = 1
    this.tailsHidden = false
    this.nextTailIndex = 0
    this.freeTailIndices = []
    this.senseAccum = 0
    this.tailSimTime = 0
    this.events = {
      preyBirths: 0,
      predBirths: 0,
      preyStarved: 0,
      predStarved: 0,
      predKills: 0,
    }
    this.foodMesh = null
    initBodyPools(this)
    this.buildWorld()
  }

  processSplits() {
    const snapshot = this.cells.slice()
    for (const cell of snapshot) {
      if (cell.splitPending) {
        if (this.cells.length + 2 > MAX_CELLS) continue
        cell.splitPending = false
        cell.split = true
      }
      if (cell.split) mitose(this, cell)
    }
  }

  removeCell(cell) {
    const d = cell
    removeBody(this, d)
    clearTail(this, d)
    if (!d.tailTransfer) this.freeTailIndices.push(d.index)
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
    if (d.paralysed) return
    const ang = this.signedAngleTo(d, awayWorld)
    if (ang == null) return
    d.headingRate += THREE.MathUtils.clamp(ang * COLLISION_KICK, -0.4, 0.4) * intensity
  }

  capsuleDist(a, b) {
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

  buildCellGrid() {
    this.cellGrid.clear()
    const n = this.cells.length
    for (let i = 0; i < n; i++) {
      const d = this.cells[i]
      if ((d.mito || d.splitting) && !d.mitoParent) continue
      const key = cellIndex(
        Math.floor(d.pos.x / CELL_GRID),
        Math.floor(d.pos.y / CELL_GRID),
        Math.floor(d.pos.z / CELL_GRID),
      )
      const bucket = this.cellGrid.get(key)
      if (bucket) bucket.push(i)
      else this.cellGrid.set(key, [i])
    }
  }

  solveCollisions(simDt) {
    const n = this.cells.length
    for (let i = 0; i < n; i++) {
      const a = this.cells[i]
      if ((a.mito || a.splitting) && !a.mitoParent) continue
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
              const b = this.cells[j]
              if ((b.mito || b.splitting) && !b.mitoParent) continue
              const cdx = b.pos.x - a.pos.x
              const cdy = b.pos.y - a.pos.y
              const cdz = b.pos.z - a.pos.z
              const bound = a.radius + b.radius + a.width + b.width
              if (cdx * cdx + cdy * cdy + cdz * cdz >= bound * bound) continue

              this.capsuleDist(a, b)
              const contact = a.width + b.width
              if (this._col.dist >= contact) continue
              const overlap = contact - this._col.dist
              const nx = this._col.x
              const ny = this._col.y
              const nz = this._col.z
              const invA = a.mitoParent ? 0 : 1 / a.mass
              const invB = b.mitoParent ? 0 : 1 / b.mass
              const invSum = invA + invB
              if (invSum <= 0) continue

              const impulse = (overlap * SPRING) / invSum
              a.vel.x -= nx * impulse * invA * simDt
              a.vel.y -= ny * impulse * invA * simDt
              a.vel.z -= nz * impulse * invA * simDt
              b.vel.x += nx * impulse * invB * simDt
              b.vel.y += ny * impulse * invB * simDt
              b.vel.z += nz * impulse * invB * simDt

              if (!a.mitoParent) {
                this.deflectHeading(
                  a,
                  this._v6.set(-nx, -ny, -nz),
                  Math.min(overlap * 8, 1),
                )
              }
              if (!b.mitoParent) {
                this.deflectHeading(
                  b,
                  this._v5.set(nx, ny, nz),
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

  advance(dt) {
    this.simTime += dt
    // Fresh spatial grid for this frame so camera-relevant queries (blue flee,
    // red hunt) and predation never see stale/removed cell indices.
    this.perf.begin('grid')
    this.buildCellGrid()
    this.perf.end('grid')

    this.perf.begin('cells')
    for (const cell of this.cells) {
      const d = cell
      if (d.mito || d.splitting) {
        d.drive = 0
        continue
      }
      const normal = this._v1.copy(d.pos).normalize()

      d.heading.addScaledVector(normal, -d.heading.dot(normal)).normalize()
      if (d.paralysed) {
        d.drive = 0
        d.steer = 0
        d.headingRate = 0
        d.vel.multiplyScalar(Math.exp(-50 * dt))
      } else {
        if (d.dying) {
          d.drive = 0
        } else if (d.rest > 0) {
          d.rest -= dt
          d.drive = 0
        } else {
          const frac = THREE.MathUtils.clamp(d.energy / ENERGY_MAX, 0, 1)
          // Bands are mostly exclusive by energy: coast to a stop as the cell
          // nears max (mitosis), and slow as it starves toward zero.
          const coastFrac = smoothstep(
            THREE.MathUtils.clamp(
              (frac - MITO_SLOW_FRAC) / (1 - MITO_SLOW_FRAC),
              0,
              1,
            ),
          )
          const fatigue = smoothstep(
            THREE.MathUtils.clamp(frac / STARVE_SLOW, 0, 1),
          )
          d.drive = d.slow * (1 - coastFrac) * fatigue
          if (d.breed === 1) {
            d.drive *= PRED_DRIVE
            // While feeding on a latched prey, stop entirely so it holds the
            // latch and drains the blue instead of swimming past/through.
            if (d.target && d.target.paralysed) d.drive = 0
          }
        }

        // Chemotaxis turns into a tail steering command; the tail arc then drives
        // the body's heading (see updateTailState + TAIL_TURN below) and ANG_DRAG
        // damps it, so rotation is generated by tail motion rather than directly.
        d.steer = 0
        if (d.foodAmt > 0.01 && d.foodPeak > PEAK_MIN) {
          const ang = this.signedAngleTo(d, d.foodDir)
          if (ang != null) {
            d.steer = THREE.MathUtils.clamp(ang * STEER_GAIN, -1, 1)
          }
        }
        if (d.breed === 0) {
          const cx = Math.floor(d.pos.x / CELL_GRID)
          const cy = Math.floor(d.pos.y / CELL_GRID)
          const cz = Math.floor(d.pos.z / CELL_GRID)
          let red = null
          let best = PRED_RANGE
          forEachNearbyCell(this, cx, cy, cz, 1, (index) => {
            const other = this.cells[index]
            if (other.breed !== 1) return
            this.capsuleDist(d, other)
            if (this._col.dist < best) {
              best = this._col.dist
              red = other
            }
          })
          if (red) {
            const away = this._v7.subVectors(d.pos, red.pos).normalize()
            const ang = this.signedAngleTo(d, away)
            if (ang != null) {
              d.steer = THREE.MathUtils.clamp(d.steer + ang * STEER_GAIN, -1, 1)
            }
          }
        }
        // Red hunts by following the prey gradient built in predatorSense()
        // (a weighted direction to nearby blues), so it tracks the shoal rather
        // than only the single nearest blue inside a hard cutoff. Once it has a
        // latched prey it stops steering and holds the latch.
        if (d.breed === 1 && !(d.target && d.target.paralysed)) {
          if (d.preyAmt > 0) {
            const ang = this.signedAngleTo(d, d.preyDir)
            if (ang != null) {
              d.steer = THREE.MathUtils.clamp(d.steer + ang * STEER_GAIN * 1.5, -1, 1)
            }
          }
        }
        // The tail's steering bend imparts a heading rate (0 when the tail is
        // straight), then angular drag quickly damps it.
        d.headingRate += TAIL_TURN * (d.tailBend || 0) * dt
        d.headingRate *= Math.exp(-ANG_DRAG * dt)
        d.headingRate = THREE.MathUtils.clamp(d.headingRate, -MAX_SPIN, MAX_SPIN)
        this._q.setFromAxisAngle(normal, d.headingRate * dt)
        d.heading
          .applyQuaternion(this._q)
          .addScaledVector(normal, -d.heading.dot(normal))
          .normalize()

        d.vel.addScaledVector(d.heading, THRUST * d.drive * dt)
        d.vel.multiplyScalar(Math.exp(-DRAG * dt))
      }
      d.vel.addScaledVector(normal, -d.vel.dot(normal))

      d.pos.addScaledVector(d.vel, dt)
      d.pos.setLength(SURFACE)

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
      d.quat.setFromRotationMatrix(this._m)
    }
    this.perf.end('cells')

    this.perf.begin('collide')
    this.solveCollisions(dt)
    this.perf.end('collide')

    this.perf.begin('eat')
    eatAndRespawn(this, dt)
    this.perf.end('eat')

    this.perf.begin('pred')
    predation(this, dt)
    this.perf.end('pred')

    this.perf.begin('sense')
    this.senseAccum += dt
    if (this.senseAccum >= SENSE_PERIOD) {
      concentration(this)
      predatorSense(this)
      this.senseAccum = 0
    }
    this.perf.end('sense')

    this.perf.begin('split')
    this.processSplits()
    for (const cell of this.cells) updateMito(this, cell, dt)
    for (const cell of this.cells) updateEnergy(this, cell, dt)
    for (const cell of this.cells) updateStarvation(this, cell, dt)
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const d = this.cells[i]
      if (d.dead) {
        // Mito parents are replaced by their daughters, not a real death.
        if (!d.mitoParent) {
          if (d.killedByPred) this.events.predKills++
          else if (d.breed === 0) this.events.preyStarved++
          else this.events.predStarved++
        }
        this.removeCell(d)
        this.cells.splice(i, 1)
      }
    }
    this.perf.end('split')

    // The tail's bend is a physical control (it steers the body via TAIL_TURN),
    // so it always advances with the sim. The pose itself is derived for the
    // render path only, and only for cells that are actually drawn.
    this.perf.begin('tail')
    for (const cell of this.cells) updateTailBend(this, cell, dt)
    this.perf.end('tail')
  }

  renderTails(dt = 1 / 60) {
    // Sim time since the previous render: the wave phase is advanced by this,
    // so its frequency scales with sim speed (clamped inside updateTailState).
    const waveDt = Math.max(0, this.simTime - this.tailSimTime)
    this.tailSimTime = this.simTime
    if (this.tailsHidden) return
    for (const cell of this.cells) {
      if (cell.sideHidden) {
        placeTail(this, cell)
      } else {
        if (cell.sideHiddenPrev) warmTail(this, cell)
        updateTailState(this, cell, dt, waveDt)
        placeTail(this, cell)
      }
      cell.sideHiddenPrev = cell.sideHidden
    }
  }

  step(simDt) {
    if (simDt > 0) {
      const steps = Math.min(Math.max(Math.ceil(simDt / FIXED_DT), 1), MAX_STEPS)
      const dt = simDt / steps
      for (let i = 0; i < steps; i++) this.advance(dt)
    }
  }

  render(tailScale, dt) {
    renderView(this, tailScale, dt)
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
    disposeBodyPools(this)
    disposeBodyGeos()
    if (this.sphereShell) {
      this.sphereShell.geometry.dispose()
      this.sphereShell.material.dispose()
    }
    if (this.foodMesh) this.foodMesh.dispose()
    disposeTailPool(this)
    if (this.renderer) this.renderer.domElement.remove()
  }
}
