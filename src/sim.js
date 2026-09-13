import * as THREE from 'three'
import {
  SURFACE,
  PREY_COUNT,
  PRED_COUNT,
  MAX_CELLS,
  FOOD_COUNT,
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
  MAX_SPIN,
  PEAK_MIN,
  SENSE_PERIOD,
  CELL_GRID,
  PRED_RANGE,
  PRED_DRIVE,
} from './constants'
import { smoothstep } from './math'
import {
  buildCellGrid,
  capsuleDist,
  signedAngleTo,
  solveCollisions,
} from './collision'
import {
  foodGeo,
  foodMat,
  disposeSharedMaterials,
} from './materials'
import {
  makeCell,
  mitose,
  beginDetach,
  updateDetach,
  releaseTail,
  placeTail,
  updateTailControl,
  updateTailPose,
  updateMito,
  updateEnergy,
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
import { initPops, spawnPop, disposePops } from './pops'
import { disposeGlowMaterial } from './glow'
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
    this._tailDirty = new Set()
    this.respawning = []
    this.senseAccum = 0
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
    initPops(this)
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
    this.senseAccum = 0
    this.events = {
      preyBirths: 0,
      predBirths: 0,
      preyStarved: 0,
      predStarved: 0,
      predKills: 0,
    }
    this.foodMesh = null
    this.pops = []
    initBodyPools(this)
    this.buildWorld()
  }

  processSplits() {
    const snapshot = this.cells.slice()
    for (const cell of snapshot) {
      if (cell.detach) continue
      if (cell.splitPending) {
        if (this.cells.length + 2 > MAX_CELLS) continue
        cell.splitPending = false
        cell.split = true
      }
      if (!cell.split) continue
      // A feeding predator must let go and swim clear before it divides, so its
      // daughters don't split out on top of the prey it was draining.
      if (cell.breed === 1 && cell.target && cell.target.paralysed) {
        beginDetach(this, cell)
        continue
      }
      mitose(this, cell)
    }
  }

  removeCell(cell) {
    const d = cell
    removeBody(this, d)
    releaseTail(this, d)
  }

  advance(dt) {
    this.simTime += dt
    // Fresh spatial grid for this frame so camera-relevant queries (blue flee,
    // red hunt) and predation never see stale/removed cell indices.
    this.perf.begin('grid')
    buildCellGrid(this)
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
        if (d.rest > 0) {
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
          const ang = signedAngleTo(this, d, d.foodDir)
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
            capsuleDist(this, d, other)
            if (this._col.dist < best) {
              best = this._col.dist
              red = other
            }
          })
          if (red) {
            const away = this._v7.subVectors(d.pos, red.pos).normalize()
            const ang = signedAngleTo(this, d, away)
            if (ang != null) {
              d.steer = THREE.MathUtils.clamp(d.steer + ang * STEER_GAIN, -1, 1)
            }
          }
        }
        // Red hunts by following the prey gradient built in predatorSense()
        // (a weighted direction to nearby blues), so it tracks the shoal rather
        // than only the single nearest blue inside a hard cutoff. Once it has a
        // latched prey it stops steering and holds the latch.
        if (d.breed === 1 && !d.detach && !(d.target && d.target.paralysed)) {
          if (d.preyAmt > 0) {
            const ang = signedAngleTo(this, d, d.preyDir)
            if (ang != null) {
              d.steer = THREE.MathUtils.clamp(d.steer + ang * STEER_GAIN * 1.5, -1, 1)
            }
          }
        }
        // Detaching before division: swim away from the prey we just released.
        if (d.detach) {
          d.drive = d.slow * PRED_DRIVE
          const from = d.detachFrom
          if (from && !from.dead) {
            const away = this._v7.subVectors(d.pos, from.pos)
            if (away.lengthSq() > 1e-9) {
              const ang = signedAngleTo(this, d, away.normalize())
              if (ang != null) {
                d.steer = THREE.MathUtils.clamp(ang * STEER_GAIN, -1, 1)
              }
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
    solveCollisions(this, dt)
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
    for (const cell of this.cells) updateDetach(this, cell, dt)
    this.processSplits()
    for (const cell of this.cells) updateMito(this, cell, dt)
    for (const cell of this.cells) updateEnergy(this, cell, dt)
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const d = this.cells[i]
      if (d.dead) {
        // Mito parents are replaced by their daughters, not a real death.
        if (!d.mitoParent) {
          if (d.killedByPred) this.events.predKills++
          else if (d.breed === 0) this.events.preyStarved++
          else this.events.predStarved++
          spawnPop(this, d)
        }
        this.removeCell(d)
        this.cells.splice(i, 1)
      }
    }
    this.perf.end('split')

    // Tail control (the `tailBend` steering actuator) always advances with the
    // sim, even while hidden, so toggling visibility never changes motion. The
    // cosmetic spring-chain pose is only integrated when tails are drawn.
    this.perf.begin('tail')
    for (const cell of this.cells) updateTailControl(this, cell, dt)
    if (!this.tailsHidden) {
      for (const cell of this.cells) updateTailPose(this, cell, dt)
    }
    this.perf.end('tail')
  }

  renderTails() {
    const dirty = this._tailDirty
    dirty.clear()
    // Ranges only ever describe this frame's writes, so drop any left over from
    // advance-time clears (or from a frame where tails were hidden).
    for (const chunk of this.tailChunks) {
      for (const a of chunk.attrList) a.clearUpdateRanges()
    }
    if (this.tailsHidden) return
    for (const cell of this.cells) {
      const chunk = placeTail(this, cell)
      if (chunk) dirty.add(chunk)
    }
    // One needsUpdate per attribute per touched chunk instead of per cell.
    for (const chunk of dirty) {
      for (const a of chunk.attrList) a.needsUpdate = true
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

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  dispose() {
    if (this.controls) this.controls.dispose()
    if (this.renderer) this.renderer.dispose()
    // Meshes and pooled geometry first, then the shared templates/materials they
    // reference, so nothing is disposed out from under a live draw call.
    disposeBodyPools(this)
    disposeTailPool(this)
    disposePops(this)
    if (this.foodMesh) this.foodMesh.dispose()
    if (this.sphereShell) {
      this.sphereShell.geometry.dispose()
      this.sphereShell.material.dispose()
    }
    disposeBodyGeos()
    disposeSharedMaterials()
    disposeGlowMaterial()
    if (this.renderer) this.renderer.domElement.remove()
  }
}
