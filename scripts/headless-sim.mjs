// Plain-Node headless simulation test. No Vite server, no WebGL, no DOM.
//
// It proves two things the epic (cell-su5) is about:
//   1. The simulation core runs standalone: build a world, step it for real sim
//      time, and the cells stay finite and on the sphere.
//   2. The physics modules never import a render module, so importing them
//      cannot construct THREE materials/geometries/InstancedMeshes.
//
// Run: node scripts/headless-sim.mjs  (npm run test:headless)

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Simulation } from '../src/sim.js'
import { MAX_CELLS, SURFACE, P } from '../src/constants.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../src')

const failures = []
const report = (label, problems, ok) => {
  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.slice(0, 5).join('; ')}`)
    failures.push(label)
  } else {
    console.log(`PASS ${label}: ${ok}`)
  }
}

// --- 1. Import-graph guard --------------------------------------------------
// Walk the relative-import graph from the physics entry points and assert no
// render module is reachable. (A runtime constructor spy is impossible: ESM
// namespaces are immutable and imports evaluate before test code.)
const PHYSICS = [
  'constants.js',
  'math.js',
  'grid.js',
  'collision.js',
  'cells.js',
  'food.js',
  'predator.js',
  'tail.js',
  'gait.js',
]
const RENDER = new Set([
  'materials.js',
  'bodyPool.js',
  'tailPool.js',
  'sceneSetup.js',
  'render.js',
  'pops.js',
  'glow.js',
  'foodRender.js',
  'view.js',
  'renderSync.js',
])

const importProblems = []
{
  const seen = new Set()
  const stack = PHYSICS.map((f) => resolve(SRC, f))
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const base = file.slice(SRC.length + 1)
    if (RENDER.has(base)) {
      importProblems.push(`${base} is reachable from the physics graph`)
      continue
    }
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/from '(\.[^']+)'/g)) {
      stack.push(resolve(dirname(file), m[1]))
    }
  }
}
report('physics import graph', importProblems, 'no render module reachable')

// --- 2. Headless build + step ----------------------------------------------
const stepProblems = []
{
  const sim = new Simulation()
  if (sim.view !== null) stepProblems.push('constructor created a view')
  for (const field of ['scene', 'bodyPools', 'tailChunks', 'foodMesh', 'popGlow']) {
    if (field in sim) stepProblems.push(`constructor created ${field}`)
  }

  sim.buildWorld()
  const prey0 = sim.cells.filter((c) => c.breed === 0).length
  const pred0 = sim.cells.filter((c) => c.breed === 1).length
  if (prey0 + pred0 !== sim.cells.length) stepProblems.push('breed counts mismatch')
  if (sim.foods.length === 0) stepProblems.push('no food built')

  const DT = 1 / 60
  for (let i = 0; i < 600; i++) sim.advance(DT)

  if (sim.cells.length > MAX_CELLS) stepProblems.push(`cells ${sim.cells.length} > MAX_CELLS`)
  for (const d of sim.cells) {
    if (!Number.isFinite(d.pos.x + d.pos.y + d.pos.z)) {
      stepProblems.push('non-finite cell position')
      break
    }
    if (Math.abs(d.pos.length() - SURFACE) > 1e-6) {
      stepProblems.push('cell left the sphere surface')
      break
    }
    if (!Number.isFinite(d.energy) || d.energy < 0) {
      stepProblems.push('cell energy out of range')
      break
    }
  }
  if (!Number.isFinite(sim.simTime) || sim.simTime <= 0) {
    stepProblems.push('simTime did not advance')
  }
  // Food physics must have run without a mesh.
  if (sim.foodMesh !== undefined) stepProblems.push('food mesh appeared headless')
}
report('headless build + step', stepProblems, '600 steps, cells finite and on-surface')

// --- 2b. Gait stays physical -------------------------------------------------
// The gait must not put a cell off the surface or into NaN, and the controller
// must actually engage (a turn phase and a non-general forward mode observed).
const gaitProblems = []
{
  const savedGait = P.GAIT_MODE
  const savedTumble = P.GAIT_TUMBLE
  const savedRandom = Math.random
  P.GAIT_MODE = 1
  P.GAIT_TUMBLE = 2
  try {
    const sim = new Simulation()
    sim.poseEnabled = false
    sim.buildWorld()
    let sawTurn = false
    let sawEat = false
    let sawTumble = false
    for (let i = 0; i < 600; i++) {
      sim.advance(1 / 60)
      for (const d of sim.cells) {
        if (d.gait === 1) sawTurn = true
        if (d.gaitMode === 2) sawEat = true
        if (d.gaitForced) sawTumble = true
        if (!Number.isFinite(d.pos.x + d.pos.y + d.pos.z)) {
          gaitProblems.push('non-finite cell position')
          break
        }
        if (Math.abs(d.pos.length() - SURFACE) > 1e-6) {
          gaitProblems.push('cell left the sphere surface')
          break
        }
      }
    }
    if (!sawTurn) gaitProblems.push('no cell ever entered a turn phase')
    if (!sawEat) gaitProblems.push('no cell ever entered slow-eat mode')
    if (!sawTumble) gaitProblems.push('no cell ever entered a forced tumble')
  } finally {
    P.GAIT_MODE = savedGait
    P.GAIT_TUMBLE = savedTumble
    Math.random = savedRandom
  }
}
report('gait prototype', gaitProblems, 'gait-on 600 steps physical; turn + eat + tumble engaged')

// --- 3. Headless view is optional -------------------------------------------
const viewProblems = []
{
  const sim = new Simulation()
  sim.attach() // headless View: scene + pooled meshes, no renderer/camera
  sim.buildWorld()
  if (!sim.view) viewProblems.push('attach() did not create a view')
  else {
    if (sim.view.renderer) viewProblems.push('headless view created a renderer')
    if (sim.view.camera) viewProblems.push('headless view created a camera')
    for (let i = 0; i < 120; i++) sim.step(1 / 60)
    try {
      sim.render(1, 1 / 60)
    } catch (err) {
      viewProblems.push(`render threw: ${err.message}`)
    }
  }
}
report('headless view render', viewProblems, 'pooled render path runs without WebGL')

console.log(
  failures.length ? `\n${failures.length} check(s) failed` : '\nAll headless checks passed',
)
process.exit(failures.length ? 1 : 0)
