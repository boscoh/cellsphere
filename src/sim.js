import * as THREE from 'three'
import {
  P,
  SURFACE,
  MAX_CELLS,
  FIXED_DT,
  MAX_STEPS,
  ENERGY_MAX,
  CELL_GRID,
} from './constants.js'
import { smoothstep } from './math.js'
import {
  buildCellGrid,
  capsuleDist,
  signedAngleTo,
  solveCollisions,
} from './collision.js'
import {
  makeCell,
  mitose,
  beginDetach,
  updateDetach,
  updateAssemblies,
  isAssemblyParent,
  updateEnergy,
} from './cells.js'
import { updateTailControl, updateTailPose } from './tail.js'
import { updateGait } from './gait.js'
import {
  generateClumps,
  makeFood,
  buildFoodGrid,
  eatAndRespawn,
  concentration,
} from './food.js'
import { predation, predatorSense } from './predator.js'
import { forEachNearby } from './grid.js'
import { spawnPop } from './pops.js'
import { createPerf } from './perf.js'
import { View } from './view.js'

export class Simulation {
  constructor() {
    // Render resources (scene, camera, pools, meshes) live on `view`, created by
    // attach(). A headless Simulation never constructs them.
    this.view = null
    this.cells = []
    this.foods = []
    this.foodGrid = new Map()
    this.cellGrid = new Map()
    this.clumps = []
    this.pops = []
    this.assemblies = []
    this.simTime = 0
    this.poseEnabled = true
    this.respawning = []
    this.removed = []
    this.senseAccum = 0

    // Scratch vectors and objects, allocated once per Simulation and reused every
    // step so the physics path allocates nothing. The rule: never hold one across
    // a call into another module. Different phases of a step may reuse the same
    // vector (they never overlap), but two live references in one phase must not.
    // Render scratch lives on the View, so it can never alias these.
    //   movement/collision  _v1 normal, _v2 right, _v3/_v4 angle cross,
    //                       _v5 normal2, _v6 deflect direction, _v10 forward,
    //                       _v11/_v12 angle temporaries, _col
    //   tails               _v1 root joint, _v2 root, _v3 behind, _v5 side,
    //                       _v7 spine, _v8 wave step
    //   mitosis             _v10/_v11/_v12 basis, _m
    //   food                _fd
    this._v1 = new THREE.Vector3()
    this._v2 = new THREE.Vector3()
    this._v3 = new THREE.Vector3()
    this._v4 = new THREE.Vector3()
    this._v5 = new THREE.Vector3()
    this._v6 = new THREE.Vector3()
    this._v7 = new THREE.Vector3()
    this._v8 = new THREE.Vector3()
    this._v10 = new THREE.Vector3()
    this._v11 = new THREE.Vector3()
    this._v12 = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._m = new THREE.Matrix4()
    this._col = { dist: 0, x: 0, y: 0, z: 0 }
    this._fd = { rx: 0, ry: 0, rz: 0 }
    this._eatContact = []
    this.perf = createPerf()
  }

  attach(container) {
    this.view = new View(this)
    if (container) this.view.attach(container)
  }

  buildWorld() {
    for (let i = 0; i < Math.min(P.PREY_COUNT, MAX_CELLS); i++) {
      this.cells.push(makeCell(this, 0))
    }
    for (let i = 0; i < Math.min(P.PRED_COUNT, MAX_CELLS - this.cells.length); i++) {
      this.cells.push(makeCell(this, 1))
    }

    generateClumps(this)
    for (let i = 0; i < P.FOOD_COUNT; i++) makeFood(this)
    buildFoodGrid(this)
  }

  reset() {
    this.cells = []
    this.foods = []
    this.foodGrid = new Map()
    this.cellGrid = new Map()
    this.clumps = []
    this.respawning = []
    this.removed = []
    this.simTime = 0
    this.poseEnabled = true
    this.senseAccum = 0
    this.pops = []
    this.assemblies = []
    if (this.view) {
      this.view.resetResources()
      this.view.resizeShell()
    }
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
    // Slot teardown is deferred to the next render sync, so physics never
    // touches a pool.
    this.removed.push(cell)
  }

  advance(dt) {
    this.simTime += dt
    // Fresh spatial grid for this frame so camera-relevant queries (green flee,
    // red hunt) and predation never see stale/removed cell indices.
    this.perf.begin('grid')
    buildCellGrid(this)
    this.perf.end('grid')

    this.perf.begin('cells')
    for (const cell of this.cells) {
      const d = cell
      if (d.asm !== null) {
        d.drive = 0
        continue
      }
      if (d.reorientT > 0) d.reorientT = Math.max(0, d.reorientT - dt)
      if (d.huntT > 0) d.huntT = Math.max(0, d.huntT - dt)
      if (d.forageT > 0) d.forageT = Math.max(0, d.forageT - dt)
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
          // The sibling reference is only read while `rest > 0`; drop it once the
          // away-turn window closes so a dead sister is not kept reachable for as
          // long as this cell lives (guarded, so cells without one keep their
          // shape).
          if (d.rest <= 0 && d.sibling) d.sibling = null
        } else {
          const frac = THREE.MathUtils.clamp(d.energy / ENERGY_MAX, 0, 1)
          // Bands are mostly exclusive by energy: coast to a stop as the cell
          // nears max (mitosis), and slow as it starves toward zero.
          const coastFrac = smoothstep(
            THREE.MathUtils.clamp(
              (frac - P.MITO_SLOW_FRAC) / (1 - P.MITO_SLOW_FRAC),
              0,
              1,
            ),
          )
          const fatigue = smoothstep(
            THREE.MathUtils.clamp(frac / P.STARVE_SLOW, 0, 1),
          )
          // A daughter in its post-division forage window ignores the grazing
          // slowdown so it can actually leave the parent spot (cell-x93).
          const graze = d.forageT > 0 ? 1 : d.slow
          // A red that just finished a meal (reorientT) also ignores the
          // energy coast, so a fed red can still chase the next prey instead
          // of idling at high energy (cell-700).
          const coast = d.breed === 1 && d.reorientT > 0 ? 0 : coastFrac
          d.drive = graze * (1 - coast) * fatigue
          if (d.breed === 1) {
            d.drive *= P.PRED_DRIVE
            // Ambush: burst when prey is within PRED_LUNGE, coast outside it.
            // A post-meal reorient window suppresses the coast so the red can
            // close on a nearby green (cell-erd).
            if (d.reorientT <= 0 && d.preyNear > P.PRED_LUNGE) {
              d.drive *= P.PRED_COAST
            }
            // Slow-move turn phase: throttle back while the heading is off the
            // nearest prey, so the red pivots tightly instead of carving a wide
            // arc (cell-1eo). Aligned -> full drive, opposed -> (1 - TURN_SLOW).
            if (P.PRED_TURN_SLOW > 0 && !(d.target && d.target.paralysed) && d.preyNear < Infinity) {
              const a = signedAngleTo(this, d, d.preyNearestDir)
              if (a != null) d.drive *= 1 - P.PRED_TURN_SLOW * (1 - Math.cos(a)) * 0.5
            }
            // While feeding on a latched prey, stop entirely so it holds the
            // latch and drains the green instead of swimming past/through.
            if (d.target && d.target.paralysed) d.drive = 0
          }
        }

        // Chemotaxis turns into a tail steering command; the tail arc then drives
        // the body's heading (see updateTailState + P.TAIL_TURN below) and P.ANG_DRAG
        // damps it, so rotation is generated by tail motion rather than directly.
        d.steer = 0
        if (d.foodAmt > 0.01 && d.foodPeak > P.PEAK_MIN) {
          const ang = signedAngleTo(this, d, d.foodDir)
          if (ang != null) {
            d.steer = THREE.MathUtils.clamp(ang * P.STEER_GAIN, -1, 1)
          }
        }
        if (d.breed === 0) {
          const cx = Math.floor(d.pos.x / CELL_GRID)
          const cy = Math.floor(d.pos.y / CELL_GRID)
          const cz = Math.floor(d.pos.z / CELL_GRID)
          let red = null
          let best = P.PRED_RANGE
          forEachNearby(this.cellGrid, cx, cy, cz, 1, (index) => {
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
              d.steer = THREE.MathUtils.clamp(d.steer + ang * P.STEER_GAIN, -1, 1)
            }
          }
        }
        // Red hunts by following the prey gradient built in predatorSense()
        // (a weighted direction to nearby greens), so it tracks the shoal rather
        // than only the single nearest green inside a hard cutoff. Once it has a
        // latched prey it stops steering and holds the latch.
        if (d.breed === 1 && !d.detach && !(d.target && d.target.paralysed)) {
          if ((d.reorientT > 0 || d.huntT > 0) && d.preyNear < Infinity) {
            // Just finished a meal: steer straight at the nearest prey, not the
            // shoal gradient (cell-erd).
            const ang = signedAngleTo(this, d, d.preyNearestDir)
            if (ang != null) {
              d.steer = THREE.MathUtils.clamp(ang * P.STEER_GAIN * 2, -1, 1)
            }
          } else if (d.preyAmt > 0) {
            const ang = signedAngleTo(this, d, d.preyDir)
            if (ang != null) {
              d.steer = THREE.MathUtils.clamp(d.steer + ang * P.STEER_GAIN * 1.5, -1, 1)
            }
          }
        }
        // Detaching before division: swim away from the prey we just released.
        if (d.detach) {
          d.drive = d.slow * P.PRED_DRIVE
          const from = d.detachFrom
          if (from && !from.dead) {
            const away = this._v7.subVectors(d.pos, from.pos)
            if (away.lengthSq() > 1e-9) {
              const ang = signedAngleTo(this, d, away.normalize())
              if (ang != null) {
                d.steer = THREE.MathUtils.clamp(ang * P.STEER_GAIN, -1, 1)
              }
            }
          }
        }
        // Post-division forage: a fresh daughter turns hard toward its target so
        // it re-aims off the inward birth heading instead of drifting. Green aims
        // at food (cell-x93); red at the nearest prey, which otherwise drives off
        // and takes a long curve to come back (cell-zby).
        // The away-turn owns the rest window, so the forage re-aim waits for it
        // (cell-jyg): two assists pulling opposite ways only jitter the daughter.
        if (d.forageT > 0 && d.rest <= 0) {
          if (d.breed === 0 && d.foodAmt > 0.01) {
            const ang = signedAngleTo(this, d, d.foodDir)
            if (ang != null) d.headingRate += ang * P.FORAGE_TURN * dt
          } else if (d.breed === 1 && d.preyNear < Infinity) {
            const ang = signedAngleTo(this, d, d.preyNearestDir)
            if (ang != null) d.headingRate += ang * P.FORAGE_TURN * dt
          }
        }
        // Symmetric post-meal re-aim for a red: without it the tail turn is too
        // slow to chain kills (cell-700).
        if ((d.reorientT > 0 || d.huntT > 0) && d.breed === 1 && d.preyNear < Infinity) {
          const ang = signedAngleTo(this, d, d.preyNearestDir)
          if (ang != null) d.headingRate += ang * P.REORIENT_TURN * dt
        }
        // Sisters are born facing each other (each tail streams outward, so the
        // heading must point inward), so the no-drive rest window is spent
        // pivoting away from the sibling instead of aiming at food: the pair
        // turns apart before either can thrust head-on, and only then does the
        // forage window take over the re-aim (cell-jyg). It steers the heading
        // directly and leaves `steer` alone, so the tail (whose bend follows the
        // steering command) stays as calm as any other cell's. 0 = off.
        if (P.MITO_AWAY_TURN > 0 && d.rest > 0 && d.sibling && !d.sibling.dead) {
          const away = this._v7.subVectors(d.pos, d.sibling.pos)
          if (away.lengthSq() > 1e-9) {
            const ang = signedAngleTo(this, d, away.normalize())
            if (ang != null) d.headingRate += ang * P.MITO_AWAY_TURN * dt
          }
        }
        // Alternating gait (cell-d4z): may cut drive and boost steer for a TURN
        // phase, or scale drive by the current forward mode. No-op while
        // P.GAIT_MODE = 0.
        updateGait(this, d, dt)
        // The tail's steering bend imparts a heading rate (0 when the tail is
        // straight), then angular drag quickly damps it.
        d.headingRate += P.TAIL_TURN * (d.tailBend || 0) * dt
        d.headingRate *= Math.exp(-P.ANG_DRAG * dt)
        d.headingRate = THREE.MathUtils.clamp(d.headingRate, -P.MAX_SPIN, P.MAX_SPIN)
        // A fresh daughter pivots gently for the whole post-division exit window
        // (REST + FORAGE): at full authority the re-aim and any collision kick
        // hold her at MAX_SPIN, which is the visible thrash and whips the tail
        // (cell-jyg).
        if (d.forageT > 0) {
          d.headingRate = THREE.MathUtils.clamp(d.headingRate, -P.MITO_TURN_CAP, P.MITO_TURN_CAP)
        }
        this._q.setFromAxisAngle(normal, d.headingRate * dt)
        d.heading
          .applyQuaternion(this._q)
          .addScaledVector(normal, -d.heading.dot(normal))
          .normalize()

        d.vel.addScaledVector(d.heading, P.THRUST * d.drive * dt)
        d.vel.multiplyScalar(Math.exp(-P.DRAG * dt))
      }
      d.vel.addScaledVector(normal, -d.vel.dot(normal))

      d.pos.addScaledVector(d.vel, dt)
      d.pos.setLength(SURFACE)

      const normal2 = this._v5.copy(d.pos).normalize()
      const fwd = this._v10
        .copy(d.heading)
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
    if (this.senseAccum >= P.SENSE_PERIOD) {
      concentration(this)
      predatorSense(this)
      this.senseAccum = 0
    }
    this.perf.end('sense')

    this.perf.begin('split')
    for (const cell of this.cells) updateDetach(this, cell, dt)
    this.processSplits()
    updateAssemblies(this, dt)
    for (const cell of this.cells) updateEnergy(this, cell, dt)
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const d = this.cells[i]
      if (d.dead) {
        // Mito parents are replaced by their daughters, not a real death.
        if (!isAssemblyParent(d) || d.mealBurst) spawnPop(this, d)
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
    if (this.poseEnabled) {
      for (const cell of this.cells) updateTailPose(this, cell, dt)
    }
    this.perf.end('tail')
  }

  renderTails() {
    if (this.view) this.view.renderTails()
  }

  step(simDt) {
    if (simDt > 0) {
      const steps = Math.min(Math.max(Math.ceil(simDt / FIXED_DT), 1), MAX_STEPS)
      const dt = simDt / steps
      for (let i = 0; i < steps; i++) this.advance(dt)
    }
  }

  render(tailScale, dt) {
    if (this.view) this.view.render(tailScale, dt)
  }

  onResize() {
    if (this.view) this.view.onResize()
  }

  dispose() {
    if (this.view) this.view.dispose()
  }
}
