import { createServer } from 'vite'

const SEED = 1
const DT = 1 / 60
const SIM_SECONDS = 120
const SAMPLE_INTERVAL = 0.5

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function checksum(sim) {
  let h = 2166136261 >>> 0
  const mix = (x) => {
    h ^= Math.round(x * 1e6) | 0
    h = Math.imul(h, 16777619)
  }
  mix(sim.cells.length)
  for (const d of sim.cells) {
    mix(d.pos.x)
    mix(d.pos.y)
    mix(d.pos.z)
    mix(d.heading.x)
    mix(d.heading.y)
    mix(d.heading.z)
    mix(d.energy)
  }
  return h >>> 0
}

function run(Simulation, tailsHidden) {
  const originalRandom = Math.random
  Math.random = mulberry32(SEED)
  try {
    const sim = new Simulation()
    sim.buildWorld()
    sim.tailsHidden = tailsHidden
    const samples = []
    const totalSteps = Math.round(SIM_SECONDS / DT)
    const sampleEvery = Math.round(SAMPLE_INTERVAL / DT)
    let minCells = sim.cells.length
    let maxCells = sim.cells.length
    for (let i = 0; i <= totalSteps; i++) {
      if (i % sampleEvery === 0) {
        samples.push({ t: sim.simTime, n: sim.cells.length, sum: checksum(sim) })
      }
      if (i < totalSteps) sim.step(DT)
      if (sim.cells.length < minCells) minCells = sim.cells.length
      if (sim.cells.length > maxCells) maxCells = sim.cells.length
    }
    return { samples, minCells, maxCells }
  } finally {
    Math.random = originalRandom
  }
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

let code = 0
try {
  const { Simulation } = await server.ssrLoadModule('/src/sim.js')
  const cells = await server.ssrLoadModule('/src/cells.js')
  const constants = await server.ssrLoadModule('/src/constants.js')
  const { SURFACE, TAIL_OSC_FREQ } = constants
  const { capsuleDist } = await server.ssrLoadModule('/src/collision.js')

  // PARAM_DEFS, the exported bindings and the setters map are three parallel
  // lists kept in sync by hand. Check them first: a missing setter leaves the
  // binding undefined and turns the physics into NaN, which would otherwise
  // surface as a confusing failure further down.
  const paramProblems = []
  const defKeys = new Set()
  for (const def of constants.PARAM_DEFS) {
    if (defKeys.has(def.key)) paramProblems.push(`duplicate PARAM_DEFS key ${def.key}`)
    defKeys.add(def.key)
    if (!(def.key in constants)) {
      paramProblems.push(`${def.key} has no exported binding`)
      continue
    }
    if (def.def < def.min || def.def > def.max) {
      paramProblems.push(`${def.key} default ${def.def} outside [${def.min}, ${def.max}]`)
    }
  }
  for (const def of constants.PARAM_DEFS) {
    if (!defKeys.has(def.key) || !(def.key in constants)) continue
    for (const bound of [def.min, def.max]) {
      try {
        constants.setParam(def.key, bound)
      } catch (err) {
        paramProblems.push(`setParam(${def.key}) threw: ${err.message}`)
        continue
      }
      if (constants[def.key] !== bound) {
        paramProblems.push(
          `setParam(${def.key}, ${bound}) left ${def.key}=${constants[def.key]}`,
        )
      }
    }
  }
  let resetError = null
  try {
    constants.resetParams()
  } catch (err) {
    resetError = err
  }
  if (resetError) {
    paramProblems.push(`resetParams threw: ${resetError.message}`)
  } else {
    for (const def of constants.PARAM_DEFS) {
      if (!(def.key in constants)) continue
      if (constants[def.key] !== def.def) {
        paramProblems.push(
          `resetParams left ${def.key}=${constants[def.key]} (want ${def.def})`,
        )
      }
    }
  }
  if (paramProblems.length) {
    console.log(`FAIL params registry: ${paramProblems.slice(0, 5).join('; ')}`)
    if (paramProblems.length > 5) {
      console.log(`  ...and ${paramProblems.length - 5} more`)
    }
    code = 1
  } else {
    console.log(
      `PASS params registry: ${constants.PARAM_DEFS.length} keys have a binding and a working setter`,
    )
  }

  // capsuleDist is the invariant AGENTS.md calls out: using a spherical radius
  // caused phantom contacts and spurious rotation. Check parallel, collinear,
  // crossing and overlapping capsules against hand-computed gaps (cell-cv6.3).
  const cap = (x, y, z, hx, hy, hz) => ({
    pos: { x, y, z },
    heading: { x: hx, y: hy, z: hz },
    radius: 0.3,
    width: 0.1,
  })
  const probe = { _col: { dist: 0, x: 0, y: 0, z: 0 } }
  // radius 0.3, width 0.1 -> each capsule segment spans +/-0.2 along its heading
  const capsuleCases = [
    ['parallel, side by side', cap(0, 0, 0, 1, 0, 0), cap(0, 0.5, 0, 1, 0, 0), 0.5],
    ['collinear, end to end', cap(0, 0, 0, 1, 0, 0), cap(0.9, 0, 0, 1, 0, 0), 0.5],
    ['collinear, almost touching', cap(0, 0, 0, 1, 0, 0), cap(0.5, 0, 0, 1, 0, 0), 0.1],
    ['crossing with an offset', cap(0, 0, 0, 1, 0, 0), cap(0, 0, 0.3, 0, 1, 0), 0.3],
  ]
  const capsuleProblems = []
  for (const [label, a, b, expected] of capsuleCases) {
    capsuleDist(probe, a, b)
    if (Math.abs(probe._col.dist - expected) > 1e-6) {
      capsuleProblems.push(`${label}: got ${probe._col.dist}, want ${expected}`)
    }
  }
  // The direction must run from a to b and be usable even when the capsules
  // overlap and the closest points coincide (dist 0 falls back to the centres).
  capsuleDist(probe, cap(0, 0, 0, 1, 0, 0), cap(0, 0.5, 0, 1, 0, 0))
  if (Math.abs(probe._col.y - 1) > 1e-6) {
    capsuleProblems.push(`direction not +y (${probe._col.y})`)
  }
  capsuleDist(probe, cap(0, 0, 0, 1, 0, 0), cap(0.05, 0, 0, 1, 0, 0))
  const overlapDir = Math.hypot(probe._col.x, probe._col.y, probe._col.z)
  if (probe._col.dist !== 0) {
    capsuleProblems.push(`overlapping capsules: got dist ${probe._col.dist}, want 0`)
  }
  if (Math.abs(overlapDir - 1) > 1e-6) {
    capsuleProblems.push(`overlap direction not unit (${overlapDir})`)
  }
  if (Math.abs(probe._col.x - 1) > 1e-6) {
    capsuleProblems.push(`overlap direction not +x (${probe._col.x})`)
  }
  if (capsuleProblems.length) {
    console.log(`FAIL capsule distance: ${capsuleProblems.join('; ')}`)
    code = 1
  } else {
    console.log(
      `PASS capsule distance: ${capsuleCases.length} gaps + overlap direction match`,
    )
  }

  // buildWorld and cell growth lazily create module-level geometry/tail pools,
  // each consuming PRNG draws. Run twice and discard so the cache has reached
  // its fixed point before the measured runs; otherwise run order alone can
  // shift the seeded stream and produce a false mismatch.
  run(Simulation, false)
  run(Simulation, false)
  const visible = run(Simulation, false)
  const hidden = run(Simulation, true)

  let mismatch = null
  for (let i = 0; i < visible.samples.length; i++) {
    const a = visible.samples[i]
    const b = hidden.samples[i]
    if (a.n !== b.n || a.sum !== b.sum) {
      mismatch = { index: i, a, b }
      break
    }
  }

  const initial = visible.samples[0].n
  const mitosis = visible.maxCells > initial
  const population = `pop ${initial} -> ${visible.minCells}..${visible.maxCells}`

  if (mismatch) {
    const { index, a, b } = mismatch
    console.log(
      `FAIL tail-equivalence: first mismatch at sample ${index} (t=${a.t.toFixed(3)}s)`,
    )
    console.log(
      `  visible: n=${a.n} sum=${a.sum}  hidden: n=${b.n} sum=${b.sum}`,
    )
    code = 1
  } else {
    console.log(
      `PASS tail-equivalence: ${visible.samples.length} samples over ${SIM_SECONDS}s identical`,
    )
  }
  console.log(
    `  ${population}; mitosis=${mitosis ? 'yes' : 'no'}; samples=${visible.samples.length}`,
  )

  // warmTail must reset only the derived pose, never the physical controls that
  // drive body motion (tailLag/tailBend) or the oscillation phase.
  const warm = (() => {
    const originalRandom = Math.random
    Math.random = mulberry32(SEED)
    try {
      const sim = new Simulation()
      sim.buildWorld()
      const cell = sim.cells[0]
      cell.pos.set(1, 0, 0)
      cell.heading.set(0, 1, 0)
      cell.tailLag = 0.5
      cell.tailBend = 0.3
      cell.tailPhase = 1.2
      cell.tailCarrier.set(1, 0, 0)
      cell.tailPts[0].set(99, 99, 99)
      for (let i = 1; i < cell.tailPts.length; i++) cell.tailPts[i].set(50, 50, 50)
      for (let i = 0; i < cell.tailDirs.length; i++) cell.tailDirs[i].set(0, 0, 1)
      cells.warmTail(sim, cell)
      return {
        lag: cell.tailLag,
        bend: cell.tailBend,
        phase: cell.tailPhase,
        carrier: cell.tailCarrier.clone(),
        pts: cell.tailPts.map((p) => p.length()),
        dirs: cell.tailDirs.map((v) => v.length()),
      }
    } finally {
      Math.random = originalRandom
    }
  })()

  const warmProblems = []
  if (warm.lag !== 0.5) warmProblems.push(`tailLag changed to ${warm.lag}`)
  if (warm.bend !== 0.3) warmProblems.push(`tailBend changed to ${warm.bend}`)
  if (warm.phase !== 1.2) warmProblems.push(`tailPhase changed to ${warm.phase}`)
  if (Math.abs(warm.carrier.x) > 1e-3 || Math.abs(warm.carrier.y + 1) > 1e-3) {
    warmProblems.push(`tailCarrier not re-aimed (${warm.carrier.toArray().join(',')})`)
  }
  if (!warm.pts.every((len) => Math.abs(len - SURFACE) < 1e-3)) {
    warmProblems.push('tailPts not re-aimed to the surface')
  }
  if (!warm.dirs.every((len) => Math.abs(len - 1) < 1e-3)) {
    warmProblems.push('tailDirs not re-aimed to unit length')
  }
  if (warmProblems.length) {
    console.log(`FAIL warmTail decoupling: ${warmProblems.join('; ')}`)
    code = 1
  } else {
    console.log(
      'PASS warmTail decoupling: tailLag/tailBend/tailPhase preserved, pose re-aimed',
    )
  }

  // The chain advances its wave phase by dt * TAIL_OSC_FREQ per sim step while
  // driving or turning, never when idle, and keeps every joint on the surface.
  const wave = (() => {
    const originalRandom = Math.random
    Math.random = mulberry32(SEED)
    try {
      const sim = new Simulation()
      sim.buildWorld()
      const cell = sim.cells[0]
      cell.pos.set(1, 0, 0)
      cell.heading.set(0, 1, 0)
      cell.drive = 1
      cell.headingRate = 0
      cell.tailPhase = 0
      cells.updateTailState(sim, cell, DT)
      const afterStep = cell.tailPhase
      cell.drive = 0
      cell.headingRate = 0
      const idlePhase = cell.tailPhase
      cells.updateTailState(sim, cell, DT)
      const afterIdle = cell.tailPhase
      const offSurface = cell.tailPts.some(
        (p) => Math.abs(p.length() - SURFACE) > 1e-3,
      )
      return {
        afterStep,
        idlePhase,
        afterIdle,
        expected: DT * TAIL_OSC_FREQ,
        offSurface,
      }
    } finally {
      Math.random = originalRandom
    }
  })()

  const waveProblems = []
  if (Math.abs(wave.afterStep - wave.expected) > 1e-9) {
    waveProblems.push(`drive advance ${wave.afterStep} != ${wave.expected}`)
  }
  if (wave.afterIdle !== wave.idlePhase) {
    waveProblems.push(`tailPhase advanced while idle (${wave.afterIdle})`)
  }
  if (wave.offSurface) {
    waveProblems.push('tail joints left the surface')
  }
  if (waveProblems.length) {
    console.log(`FAIL wave phase/chain: ${waveProblems.join('; ')}`)
    code = 1
  } else {
    console.log('PASS wave phase/chain: advances with sim dt, stays on the surface')
  }

  // Headless pose smoke: drive the render path directly (no WebGL), stepping a
  // long sim first, then asserting the derived tail stays finite.
  const smoke = (() => {
    const originalRandom = Math.random
    Math.random = mulberry32(SEED)
    try {
      const sim = new Simulation()
      sim.buildWorld()
      sim.tailsHidden = false
      const totalSteps = Math.round(SIM_SECONDS / DT)
      for (let i = 0; i < totalSteps; i++) sim.step(DT)
      for (let i = 0; i < 5; i++) sim.renderTails()
      for (const cell of sim.cells) {
        const fields = [cell.pos.x, cell.pos.y, cell.pos.z]
        for (const p of cell.tailPts) fields.push(p.x, p.y, p.z)
        if (fields.some((v) => !Number.isFinite(v))) {
          return `non-finite value in cell ${cell.index}`
        }
      }
      return null
    } catch (err) {
      return err && err.stack ? err.stack : String(err)
    } finally {
      Math.random = originalRandom
    }
  })()

  if (smoke) {
    console.log(`FAIL headless tail-pose smoke: ${smoke}`)
    code = 1
  } else {
    console.log('PASS headless tail-pose smoke: finite pose after 120s + renderTails')
  }

} finally {
  await server.close()
}

process.exit(code)
