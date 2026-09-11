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
  const { SURFACE, TAIL_OSC_FREQ, TAIL_WAVE_MAX_HZ } =
    await server.ssrLoadModule('/src/constants.js')
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

  // The travelling wave advances by the SIM time since the last render, so its
  // frequency scales with sim speed, but the per-frame step is capped so high
  // sim speeds can't alias/flatten it. Control passes must never advance it.
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
      for (let i = 0; i < 10; i++) cells.updateTailBend(sim, cell, DT)
      const afterControl = cell.tailPhase
      cells.updateTailState(sim, cell, DT, DT)
      const afterSlow = cell.tailPhase
      cell.tailPhase = 0
      cells.updateTailState(sim, cell, DT, 1.0)
      const afterFast = cell.tailPhase
      return {
        afterControl,
        afterSlow,
        afterFast,
        slowExpected: DT * TAIL_OSC_FREQ,
        cap: Math.PI * 2 * TAIL_WAVE_MAX_HZ * DT,
      }
    } finally {
      Math.random = originalRandom
    }
  })()

  const waveProblems = []
  if (wave.afterControl !== 0) {
    waveProblems.push(`tailPhase advanced on control passes (${wave.afterControl})`)
  }
  if (Math.abs(wave.afterSlow - wave.slowExpected) > 1e-9) {
    waveProblems.push(`slow advance ${wave.afterSlow} != ${wave.slowExpected}`)
  }
  if (Math.abs(wave.afterFast - wave.cap) > 1e-9) {
    waveProblems.push(`fast advance ${wave.afterFast} not clamped to cap ${wave.cap}`)
  }
  if (wave.cap >= Math.PI) {
    waveProblems.push(`cap ${wave.cap} not below Nyquist`)
  }
  if (wave.cap <= wave.slowExpected) {
    waveProblems.push('cap does not exceed the slow step')
  }
  if (waveProblems.length) {
    console.log(`FAIL wave scaling/clamp: ${waveProblems.join('; ')}`)
    code = 1
  } else {
    console.log('PASS wave scaling/clamp: scales with sim dt, clamped below Nyquist')
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
      for (let i = 0; i < 5; i++) sim.renderTails(DT)
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
