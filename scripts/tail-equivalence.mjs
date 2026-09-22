import * as THREE from 'three'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { mulberry32 } from '../src/util.js'
import { classifyRegime, autocorrelation, createAcfTracker, broadMaximum, halveSamples } from '../src/components/popChartMath.js'
import { computeRates, lvPeriod } from '../src/components/rateModel.js'

const SEED = 1
const DT = 1 / 60
// The hidden/visible equivalence is structural, so a handful of substeps is
// enough: a pose write-back would surface on the next `advance`. Everything
// else exercises the tail pathway directly, without stepping the simulation.
const EQUIV_STEPS = 8

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

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

let code = 0
try {
  const { Simulation } = await server.ssrLoadModule('/src/sim.js')
  const constants = await server.ssrLoadModule('/src/constants.js')
  const { P, SURFACE, TAIL_OSC_FREQ, TAIL_SEGMENTS, TAIL_DYN_SUB } = constants
  const { capsuleDist } = await server.ssrLoadModule('/src/collision.js')
  const tail = await server.ssrLoadModule('/src/tail.js')
  const tailPool = await server.ssrLoadModule('/src/tailPool.js')
  const renderSync = await server.ssrLoadModule('/src/renderSync.js')

  const report = (label, problems, ok) => {
    if (problems.length) {
      console.log(`FAIL ${label}: ${problems.slice(0, 5).join('; ')}`)
      if (problems.length > 5) console.log(`  ...and ${problems.length - 5} more`)
      code = 1
    } else {
      console.log(`PASS ${label}: ${ok}`)
    }
  }

  // Build a world (cell data + pools + tail chains) but never step it. The
  // direct tail tests drive control/pose/pool functions on these cells.
  const buildWorld = () => {
    const originalRandom = Math.random
    Math.random = mulberry32(SEED)
    try {
      const sim = new Simulation()
      sim.attach()
      sim.buildWorld()
      // Physics no longer allocates pool slots; the render sync pass does.
      renderSync.syncCells(sim.view)
      return sim
    } finally {
      Math.random = originalRandom
    }
  }

  // Body state the tail must never touch, and control state the pose must never
  // touch.
  const FIELD = (d) => [
    d.pos.x,
    d.pos.y,
    d.pos.z,
    d.vel.x,
    d.vel.y,
    d.vel.z,
    d.heading.x,
    d.heading.y,
    d.heading.z,
    d.headingRate,
    d.energy,
  ]
  const CONTROL = (d) => [
    d.tailPhase,
    d.tailLag,
    d.tailBend,
    d.tailCarrier.x,
    d.tailCarrier.y,
    d.tailCarrier.z,
  ]
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

  // PARAM_DEFS, the exported bindings and the setters map are three parallel
  // lists kept in sync by hand. Check them first: a missing setter leaves the
  // binding undefined and turns the physics into NaN, which would otherwise
  // surface as a confusing failure further down.
  const paramProblems = []
  const defKeys = new Set()
  for (const def of constants.PARAM_DEFS) {
    if (defKeys.has(def.key)) paramProblems.push(`duplicate PARAM_DEFS key ${def.key}`)
    defKeys.add(def.key)
    if (!(def.key in constants.P)) {
      paramProblems.push(` has no P entry`)
      continue
    }
    if (def.def < def.min || def.def > def.max) {
      paramProblems.push(`${def.key} default ${def.def} outside [${def.min}, ${def.max}]`)
    }
  }
  for (const def of constants.PARAM_DEFS) {
    if (!defKeys.has(def.key) || !(def.key in constants.P)) continue
    for (const bound of [def.min, def.max]) {
      try {
        constants.setParam(def.key, bound)
      } catch (err) {
        paramProblems.push(`setParam(${def.key}) threw: ${err.message}`)
        continue
      }
      if (constants.P[def.key] !== bound) {
        paramProblems.push(
          `setParam(${def.key}, ${bound}) left ${def.key}=${constants.P[def.key]}`,
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
      if (!(def.key in constants.P)) continue
      if (constants.P[def.key] !== def.def) {
        paramProblems.push(
          `resetParams left ${def.key}=${constants.P[def.key]} (want ${def.def})`,
        )
      }
    }
  }
  report(
    'params registry',
    paramProblems,
    `${constants.PARAM_DEFS.length} keys have a P entry and a working setter`,
  )

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
  report('capsule distance', capsuleProblems, `${capsuleCases.length} gaps + overlap direction match`)

  // The only sim-level check: with tails visible vs hidden, `advance` must
  // produce byte-identical body state. A cosmetic pose that wrote back would
  // diverge here. Warm the lazy geometry/pool caches first so both runs draw
  // the same seeded stream (see the tail test notes in docs/NOTES.md).
  const run = (tailsHidden) => {
    const originalRandom = Math.random
    Math.random = mulberry32(SEED)
    try {
      const sim = new Simulation()
      sim.buildWorld()
      sim.poseEnabled = tailsHidden
      for (let i = 0; i < EQUIV_STEPS; i++) sim.advance(DT)
      return { sum: checksum(sim), n: sim.cells.length }
    } finally {
      Math.random = originalRandom
    }
  }
  run(false)
  run(false)
  const visible = run(false)
  const hidden = run(true)
  if (visible.n !== hidden.n || visible.sum !== hidden.sum) {
    console.log(
      `FAIL tail-equivalence: hidden ${hidden.n}/${hidden.sum} != visible ${visible.n}/${visible.sum}`,
    )
    code = 1
  } else {
    console.log(
      `PASS tail-equivalence: hidden/visible identical after ${EQUIV_STEPS} substeps (${visible.n} cells)`,
    )
  }

  // updateTailControl is the actuator side: it advances the wave and sets
  // tailBend, but must not write any body state.
  const controlProblems = []
  {
    const sim = buildWorld()
    for (let ci = 0; ci < sim.cells.length; ci++) {
      const d = sim.cells[ci]
      d.drive = 1
      d.headingRate = 0.3
      d.steer = 0.5
      const phys = FIELD(d)
      const before = CONTROL(d)
      tail.updateTailControl(sim, d, DT)
      if (!same(phys, FIELD(d))) controlProblems.push(`cell ${ci} physics changed`)
      const after = CONTROL(d)
      if (!(after[0] > before[0])) controlProblems.push(`cell ${ci} tailPhase did not advance`)
      if (!Number.isFinite(after[2]) || Math.abs(after[2]) > P.TAIL_ARC_MAX + 1e-9) {
        controlProblems.push(`cell ${ci} tailBend out of range`)
      }
    }
  }
  report('control decoupling', controlProblems, 'tailPhase/tailLag/tailBend only; no body state')

  // updateTailPose (both modes) is the cosmetic side: it may only write the
  // chain, never body or control state.
  const poseProblems = []
  for (const mode of [0, 1]) {
    constants.setParam('TAIL_MODE', mode)
    const sim = buildWorld()
    for (let ci = 0; ci < sim.cells.length; ci++) {
      const d = sim.cells[ci]
      d.tailGrow = 1
      const phys = FIELD(d)
      const ctrl = CONTROL(d)
      for (let i = 0; i < 4; i++) tail.updateTailPose(sim, d, DT)
      if (!same(phys, FIELD(d))) poseProblems.push(`mode ${mode} cell ${ci} physics changed`)
      if (!same(ctrl, CONTROL(d))) poseProblems.push(`mode ${mode} cell ${ci} control changed`)
      if (d.tailPts.some((p) => !Number.isFinite(p.x + p.y + p.z))) {
        poseProblems.push(`mode ${mode} cell ${ci} non-finite pose`)
      }
      if (d.tailPts.some((p) => Math.abs(p.length() - SURFACE) > 1e-3)) {
        poseProblems.push(`mode ${mode} cell ${ci} left the surface`)
      }
      if (d.tailDirs.some((v) => Math.abs(v.length() - 1) > 1e-3)) {
        poseProblems.push(`mode ${mode} cell ${ci} dir not unit`)
      }
    }
  }
  constants.setParam('TAIL_MODE', 0)
  report('pose decoupling', poseProblems, 'spring + kinematic pose write no body or control state')

  // warmTail must reset only the derived pose, never the physical controls that
  // drive body motion (tailLag/tailBend) or the oscillation phase.
  const warmProblems = []
  {
    const sim = buildWorld()
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
    tail.warmTail(sim, cell)
    if (cell.tailLag !== 0.5) warmProblems.push(`tailLag changed to ${cell.tailLag}`)
    if (cell.tailBend !== 0.3) warmProblems.push(`tailBend changed to ${cell.tailBend}`)
    if (cell.tailPhase !== 1.2) warmProblems.push(`tailPhase changed to ${cell.tailPhase}`)
    if (Math.abs(cell.tailCarrier.x) > 1e-3 || Math.abs(cell.tailCarrier.y + 1) > 1e-3) {
      warmProblems.push(`tailCarrier not re-aimed (${cell.tailCarrier.toArray().join(',')})`)
    }
    if (cell.tailPts.some((p) => Math.abs(p.length() - SURFACE) > 1e-3)) {
      warmProblems.push('tailPts not re-aimed to the surface')
    }
    if (cell.tailDirs.some((v) => Math.abs(v.length() - 1) > 1e-3)) {
      warmProblems.push('tailDirs not re-aimed to unit length')
    }
  }
  report('warmTail decoupling', warmProblems, 'tailLag/tailBend/tailPhase preserved, pose re-aimed')

  // The chain advances its wave phase by dt * TAIL_OSC_FREQ per sim step while
  // driving or turning, never when idle, and keeps every joint on the surface.
  const waveProblems = []
  {
    const sim = buildWorld()
    const cell = sim.cells[0]
    cell.pos.set(1, 0, 0)
    cell.heading.set(0, 1, 0)
    cell.drive = 1
    cell.headingRate = 0
    cell.tailPhase = 0
    tail.updateTailState(sim, cell, DT)
    const afterStep = cell.tailPhase
    cell.drive = 0
    cell.headingRate = 0
    const idlePhase = cell.tailPhase
    tail.updateTailState(sim, cell, DT)
    const afterIdle = cell.tailPhase
    if (Math.abs(afterStep - DT * TAIL_OSC_FREQ) > 1e-9) {
      waveProblems.push(`drive advance ${afterStep} != ${DT * TAIL_OSC_FREQ}`)
    }
    if (afterIdle !== idlePhase) waveProblems.push(`tailPhase advanced while idle (${afterIdle})`)
    if (cell.tailPts.some((p) => Math.abs(p.length() - SURFACE) > 1e-3)) {
      waveProblems.push('tail joints left the surface')
    }
  }
  report('wave phase/chain', waveProblems, 'advances with sim dt, stays on the surface')

  // The tail pool's mitosis handover is the one path that could leak or
  // double-book a slot: the front daughter inherits the parent's slot while the
  // parent must end up slotless, so its releaseTail/clearTail become no-ops.
  const handoverProblems = []
  {
    const sim = buildWorld()
    const parent = sim.cells[0]
    const chunk = parent.tailChunk
    const slot = parent.tailSlot
    const daughter = { color: parent.color }
    tailPool.inheritTailSlot(sim.view, parent, daughter)
    if (parent.tailChunk !== null || parent.tailSlot !== -1) {
      handoverProblems.push('parent kept its tail slot after handing it over')
    }
    if (daughter.tailChunk !== chunk || daughter.tailSlot !== slot) {
      handoverProblems.push('front daughter did not inherit the parent slot')
    }
    if (chunk.owners[slot] !== daughter) {
      handoverProblems.push('front daughter is not the recorded slot owner')
    }
    const live = chunk.live
    tailPool.releaseTail(sim.view, parent)
    if (chunk.live !== live) handoverProblems.push('releasing the slotless parent changed the pool')
  }
  report('tail slot handover', handoverProblems, 'front daughter inherits, parent goes slotless')

  // Pool invariants under churn: every live cell owns exactly one packed slot,
  // chunk.live matches the number of cells pointing at the chunk, and
  // mesh.count stays exact. Force deaths (release + drop) and births (claim) so
  // the free/claim and swap-remove paths run without stepping the sim.
  const poolProblems = []
  {
    const sim = buildWorld()
    const kept = []
    for (let i = 0; i < sim.cells.length; i++) {
      if (i % 3 === 0) tailPool.releaseTail(sim.view, sim.cells[i])
      else kept.push(sim.cells[i])
    }
    sim.cells = kept
    for (let i = 0; i < 5; i++) {
      const born = { color: new THREE.Color(1, 1, 1) }
      tailPool.claimTailSlot(sim.view, born)
      sim.cells.push(born)
    }
    const claimed = new Map()
    const perChunk = new Map()
    for (let i = 0; i < sim.cells.length; i++) {
      const d = sim.cells[i]
      if (!d.tailChunk || d.tailSlot < 0) {
        // A dividing parent hands its slot to the front daughter and stays
        // slotless until it finishes fading (mitoParent), so that is valid.
        if (!d.mitoParent) poolProblems.push(`cell ${i} has no tail slot`)
        continue
      }
      const ci = sim.view.tailChunks.indexOf(d.tailChunk)
      const key = `${ci}:${d.tailSlot}`
      if (claimed.has(key)) poolProblems.push(`slot ${key} claimed by two cells`)
      claimed.set(key, i)
      perChunk.set(ci, (perChunk.get(ci) || 0) + 1)
      if (d.tailSlot >= d.tailChunk.live) {
        poolProblems.push(`cell ${i} slot ${d.tailSlot} is at or beyond live ${d.tailChunk.live}`)
      }
      if (d.tailChunk.owners[d.tailSlot] !== d) {
        poolProblems.push(`cell ${i} is not the owner of its slot`)
      }
    }
    for (let ci = 0; ci < sim.view.tailChunks.length; ci++) {
      const chunk = sim.view.tailChunks[ci]
      const live = perChunk.get(ci) || 0
      if (chunk.live !== live) {
        poolProblems.push(`chunk ${ci} live=${chunk.live} but ${live} cells point at it`)
      }
      if (chunk.mesh.count !== chunk.live * TAIL_SEGMENTS) {
        poolProblems.push(`chunk ${ci} mesh.count=${chunk.mesh.count} != live*segments`)
      }
      for (let s = chunk.live; s < chunk.owners.length; s++) {
        if (chunk.owners[s]) poolProblems.push(`chunk ${ci} slot ${s} beyond live is still owned`)
      }
    }
  }
  report(
    'tail pool invariants',
    poolProblems,
    'slots unique, packed, owners and counts consistent',
  )

  // Headless render smoke: drive the per-segment placement path (no WebGL) and
  // assert the derived tail stays finite.
  const renderProblems = []
  {
    const sim = buildWorld()
    sim.view.tailsHidden = false
    try {
      for (let i = 0; i < 3; i++) sim.renderTails()
    } catch (err) {
      renderProblems.push(err && err.stack ? err.stack : String(err))
    }
    for (let ci = 0; ci < sim.cells.length; ci++) {
      const d = sim.cells[ci]
      if (d.tailPts.some((p) => !Number.isFinite(p.x + p.y + p.z))) {
        renderProblems.push(`cell ${ci} non-finite after renderTails`)
      }
    }
  }
  report('headless render smoke', renderProblems, 'renderTails/placeTail finite, pose untouched')

  // Per-joint surface normals are computed once per substep and shared by the
  // accumulate, self-avoid and integrate loops (cell-bjm). The budget below is
  // the exact shared-normal design, with a little headroom:
  //   (S+1)*SUB shared normals + S+1 tangents + ~4 for n0/behind/root
  // Reintroducing a per-loop normalize() (the old design did ~165) trips it.
  const budgetProblems = []
  {
    const sim = buildWorld()
    const perCellLimit = (TAIL_SEGMENTS + 1) * TAIL_DYN_SUB + TAIL_SEGMENTS + 14
    let n = 0
    const proto = Object.getPrototypeOf(sim._v1)
    const orig = proto.normalize
    proto.normalize = function () {
      n++
      return orig.call(this)
    }
    try {
      for (const d of sim.cells) tail.updateTailPose(sim, d, DT)
    } finally {
      proto.normalize = orig
    }
    const perCell = n / Math.max(1, sim.cells.length)
    if (perCell > perCellLimit) {
      budgetProblems.push(
        `tail pose does ${perCell.toFixed(1)} normalize() per cell, budget ${perCellLimit}`,
      )
    }
  }
  report(
    'tail pose normalize budget',
    budgetProblems,
    'per-joint normals shared across loops',
  )

  // Rate model: alpha/gamma and the ratio-dependent attack must be well-behaved.
  const rateProblems = []
  {
    const r = computeRates(50, 10)
    if (!(r.alpha > 0)) rateProblems.push('alpha not positive on defaults')
    if (!(r.gamma > 0)) rateProblems.push('gamma not positive on defaults')
    const direct = (2 * Math.PI) / Math.sqrt(r.alpha * r.gamma)
    if (Math.abs(lvPeriod(r.alpha, r.gamma) - direct) > 1e-9) {
      rateProblems.push('lvPeriod disagrees with 2*pi/sqrt(alpha*gamma)')
    }
    if (lvPeriod(0, 1) !== null || lvPeriod(1, 0) !== null) {
      rateProblems.push('lvPeriod should be null when alpha or gamma is 0')
    }
    if (P.PRED_RATIO > 0 && computeRates(0, 10).attack !== 0) {
      rateProblems.push('ratio response should zero attack when there are no prey')
    }
  }
  report('rate model', rateProblems, 'alpha/gamma and lvPeriod consistent, ratio response gated')

  // Regime classifier: a sustained sinusoid is cyclic, a decaying one is damped,
  // and a series that ends at zero population is extinct.
  const regimeProblems = []
  {
    const make = (amp, t) => ({ t, green: Math.max(0, 50 + amp * Math.sin((2 * Math.PI * t) / 120)), red: 20 })
    const cyclic = []
    const damped = []
    for (let i = 0; i < 1200; i++) {
      const t = i * 0.5
      cyclic.push(make(40, t))
      damped.push(make(40 * Math.exp(-t / 150), t))
    }
    if (classifyRegime(cyclic).label !== 'cyclic') {
      regimeProblems.push(`sustained sinusoid classified ${classifyRegime(cyclic).label}`)
    }
    if (classifyRegime(damped).label !== 'damped') {
      regimeProblems.push(`decaying sinusoid classified ${classifyRegime(damped).label}`)
    }
    const extinct = cyclic.map((s) => ({ ...s }))
    extinct[extinct.length - 1].red = 0
    if (classifyRegime(extinct).label !== 'predators extinct') {
      regimeProblems.push(`red-zero series classified ${classifyRegime(extinct).label}`)
    }
    if (classifyRegime([{ t: 0, green: 1, red: 1 }]).label !== 'no data') {
      regimeProblems.push('stub series not classified as no data')
    }
  }
  report('regime classifier', regimeProblems, 'cyclic/damped/extinct distinguished')

  // The population history is capped by halving its resolution: the chart has to
  // keep spanning the whole run, so both endpoints and the ordering must survive.
  const historyProblems = []
  {
    const src = []
    for (let i = 0; i < 9; i++) src.push({ t: i * 0.5, green: 10 + i, red: 5 })
    for (const n of [3, 7, 8, 9]) {
      const s = src.slice(0, n)
      const h = halveSamples(s)
      const tag = `n=${n}`
      if (h.length !== Math.ceil(n / 2)) historyProblems.push(`${tag}: kept ${h.length} of ${n}`)
      if (h[0] !== s[0]) historyProblems.push(`${tag}: oldest sample dropped`)
      if (h[h.length - 1] !== s[n - 1]) historyProblems.push(`${tag}: newest sample dropped`)
      for (let i = 1; i < h.length; i++) {
        if (h[i].t <= h[i - 1].t) historyProblems.push(`${tag}: time went backwards`)
        if (s.indexOf(h[i]) <= s.indexOf(h[i - 1])) historyProblems.push(`${tag}: sample repeated`)
      }
      for (const x of h) if (!s.includes(x)) historyProblems.push(`${tag}: sample not from the input`)
    }
    // Only the leading edge can survive a one-slot output: a stale newest sample
    // is the one thing the chart cannot show.
    const two = halveSamples(src.slice(0, 2))
    if (two.length !== 1 || two[0] !== src[1]) historyProblems.push('n=2: newest sample dropped')
    // Repeated halving is how a long run stays bounded: while more than one
    // sample survives, it must keep the endpoints it started with, and the last
    // step down to a single sample must keep the newest.
    let h = src
    for (let i = 0; i < 3; i++) h = halveSamples(h)
    if (h.length !== 2 || h[0] !== src[0] || h[1] !== src[8]) {
      historyProblems.push('repeated halving lost an endpoint')
    }
    if (halveSamples(h)[0] !== src[8]) historyProblems.push('final halving lost the newest sample')
  }
  report('history decimation', historyProblems, 'halving keeps endpoints, order and every other sample')

  // Autocorrelation is the robust cycle test: a clean sinusoid peaks at its
  // period, white noise does not.
  const acfProblems = []
  {
    const T = 120
    const series = []
    for (let i = 0; i < 1200; i++) {
      const t = i * 0.5
      series.push({ t, green: 50 + 40 * Math.sin((2 * Math.PI * t) / T) })
    }
    const peak = broadMaximum(autocorrelation(series, 'green'), 'r', { minValue: 0.2 })
    if (!peak) acfProblems.push('clean sinusoid had no autocorrelation peak')
    else if (Math.abs(peak.lag - T) > 0.1 * T) {
      acfProblems.push(`sinusoid acf peak at ${peak.lag.toFixed(0)}s, expected ${T}`)
    } else if (peak.lag < T / 2) {
      acfProblems.push(`central acf lobe reported as the cycle (lag ${peak.lag.toFixed(0)}s)`)
    } else if (!(peak.value > 0) || peak.width < 3 || !(peak.prominence > 0)) {
      acfProblems.push(
        `sinusoid peak not broad/positive: value ${peak.value.toFixed(2)}, width ${peak.width}, prominence ${peak.prominence.toFixed(2)}`,
      )
    }
    let seed = 1
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const noise = []
    for (let i = 0; i < 1200; i++) noise.push({ t: i * 0.5, green: 50 + (rnd() - 0.5) * 20 })
    if (broadMaximum(autocorrelation(noise, 'green'), 'r', { minValue: 0.2 })) {
      acfProblems.push('white noise reported a cycle')
    }
  }
  report('autocorrelation cycle test', acfProblems, 'period recovered, noise rejected')

  // The incremental tracker must reproduce the batch autocorrelation exactly
  // enough for the 2-decimal footer readout, both while the window fills, while
  // it slides, and across a window resize.
  const trackerProblems = []
  {
    let seed = 11
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const sample = (i) => {
      const t = i * 0.5
      return { t, green: 50 + 30 * Math.sin((2 * Math.PI * t) / 90) + 4 * (t / 300) + 3 * (rnd() - 0.5) }
    }
    const series = []
    for (let i = 0; i < 700; i++) series.push(sample(i))
    const same = (label, tracker, tail) => {
      const ref = autocorrelation(tail, 'green')
      const got = tracker.series()
      if (!ref || !got || ref.length !== got.length) {
        trackerProblems.push(`${label}: batch/tracker shape mismatch`)
        return
      }
      let err = 0
      for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(ref[i].r - got[i].r), Math.abs(ref[i].lag - got[i].lag))
      if (!(err < 1e-6)) trackerProblems.push(`${label}: tracker off by ${err.toExponential(1)}`)
    }
    const cap = 120
    const tracker = createAcfTracker(cap)
    for (let i = 0; i < 60; i++) tracker.push(series[i].t, series[i].green)
    same('filling', tracker, series.slice(0, 60))
    for (let i = 60; i < 700; i++) tracker.push(series[i].t, series[i].green)
    same('sliding', tracker, series.slice(700 - cap))
    if (tracker.count !== cap || tracker.size !== cap) trackerProblems.push('tracker window not full after sliding')
    tracker.setSize(50)
    same('shrink', tracker, series.slice(700 - 50))
    if (tracker.count !== 50 || tracker.size !== 50) trackerProblems.push('tracker kept the wrong tail on shrink')
    for (let i = 700; i < 740; i++) {
      series.push(sample(i))
      tracker.push(series[i].t, series[i].green)
    }
    same('slide after shrink', tracker, series.slice(740 - 50))
    tracker.setSize(200)
    same('grow', tracker, series.slice(740 - 50))
    const empty = createAcfTracker(32)
    for (let i = 0; i < 3; i++) empty.push(series[i].t, series[i].green)
    if (empty.series() !== null) trackerProblems.push('tracker produced an ACF below the sample floor')
  }
  report('incremental acf tracker', trackerProblems, 'matches batch through fill, slide and resize')

  // A target just inside a scan's Euclidean threshold has to be found whatever
  // bucket phase the sensor's centre sits at: the radius must cover both capsule
  // half-lengths on top of the threshold, or the scan silently clips reach
  // (cell-kkl). Sweep the phase for every threshold-derived scan.
  const scanProblems = []
  {
    const { createCell } = await server.ssrLoadModule('/src/cells.js')
    const { buildCellGrid } = await server.ssrLoadModule('/src/collision.js')
    const { predatorSense, predation } = await server.ssrLoadModule('/src/predator.js')
    const { concentration, makeFood, buildFoodGrid } = await server.ssrLoadModule('/src/food.js')
    const { P, GRID, CELL_GRID, MAX_RADIUS, resetParams } = constants
    const PHASES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99]
    const FWD = new THREE.Vector3(0, 0, 1)
    const BACK = new THREE.Vector3(0, 0, -1)
    const at = (z) => new THREE.Vector3(0, 0, z)
    const half = (d) => Math.max(d.radius - d.width, 0)
    const fresh = () => {
      const sim = new Simulation()
      sim.buildWorld()
      return sim
    }
    // Axis-aligned worst case for a per-axis scan: both capsules on one axis,
    // the sensor's centre swept through its bucket by `f`.
    const foodFound = (boost, f) => {
      P.SENSE_BOOST = boost
      const sim = fresh()
      const d = createCell(sim, at(f * GRID), FWD.clone(), MAX_RADIUS, 0)
      sim.cells = [d]
      const sense = d.width + boost
      const spec = makeFood(sim)
      spec.pos.copy(d.pos).addScaledVector(FWD, half(d) + sense - 0.01)
      sim.foods = [spec]
      buildFoodGrid(sim)
      concentration(sim)
      return d.foodAmt > 0
    }
    const preyFound = (sense, f) => {
      P.PRED_SENSE = sense
      const sim = fresh()
      const red = createCell(sim, at(f * CELL_GRID), FWD.clone(), MAX_RADIUS * P.RED_SIZE, 1)
      const green = createCell(sim, at(0), BACK.clone(), MAX_RADIUS, 0)
      green.pos.copy(red.pos).addScaledVector(FWD, sense - 0.02 + half(red) + half(green))
      sim.cells = [red, green]
      buildCellGrid(sim)
      predatorSense(sim)
      return red.preyAmt > 0
    }
    const latchFound = (range, f) => {
      P.PRED_RANGE = range
      P.PRED_BITE = range
      P.PRED_SENSE = 0
      P.PRED_RATIO = 0
      const sim = fresh()
      const red = createCell(sim, at(f * CELL_GRID), FWD.clone(), MAX_RADIUS * P.RED_SIZE, 1)
      const green = createCell(sim, at(0), BACK.clone(), MAX_RADIUS, 0)
      green.pos.copy(red.pos).addScaledVector(FWD, range * 0.95 + half(red) + half(green))
      sim.cells = [red, green]
      buildCellGrid(sim)
      predation(sim, 1 / 60)
      return red.target !== null
    }
    const check = (site, knob, found, values) => {
      for (const v of values) {
        const n = PHASES.filter((f) => !found(v, f)).length
        if (n) scanProblems.push(`${site}: ${knob}=${v} missed ${n}/${PHASES.length} phases`)
      }
    }
    check('concentration', 'SENSE_BOOST', foodFound, [0.25, 0.5, 0.75, 1.0, 1.5, 2.0])
    for (const redSize of [0.5, 1]) {
      P.RED_SIZE = redSize
      check(`predatorSense (RED_SIZE ${redSize})`, 'PRED_SENSE', preyFound, [0.5, 1.0, 1.5, 1.9, 2.0, 2.5, 3.9, 5.0])
      check(`predation latch (RED_SIZE ${redSize})`, 'PRED_RANGE', latchFound, [0.18, 0.5, 0.8, 0.9, 1.0])
    }
    resetParams()
  }
  report('scan radius phase coverage', scanProblems, 'targets inside the threshold found at every bucket phase')

  // Divided sisters are born facing each other (their tails must stream
  // outward), so they have to turn apart during MITO_REST instead of driving
  // head-on the moment drive resumes (cell-jyg). One isolated division, no food,
  // run well past the release.
  const sisterProblems = []
  {
    const { gainEnergy } = await server.ssrLoadModule('/src/cells.js')
    const { capsuleDist } = await server.ssrLoadModule('/src/collision.js')
    const { buildFoodGrid } = await server.ssrLoadModule('/src/food.js')
    const { P, ENERGY_MAX, resetParams } = constants
    const sim = new Simulation()
    sim.buildWorld()
    const green = sim.cells.find((c) => c.breed === 0)
    gainEnergy(sim, green, ENERGY_MAX)
    sim.cells = [green]
    sim.foods = []
    sim.clumps = []
    buildFoodGrid(sim)

    let m = null
    for (let i = 0; i < 30000 && !m; i++) {
      sim.step(1 / 60)
      for (const d of sim.cells) if (d.mito) m = d.mito
    }
    if (!m) {
      sisterProblems.push('a lone max-energy cell never divided')
    } else {
      // The release is the end of the MITO_TIME window: the daughters are held
      // kinematic and collision-excluded until then (finalizeMito sets `rest`).
      for (let i = 0; i < 30000 && !(m.back.rest > 0); i++) sim.step(1 / 60)
      let minGap = Infinity
      for (let i = 0; i < 8 * 60; i++) {
        sim.step(1 / 60)
        capsuleDist(sim, m.back, m.front)
        minGap = Math.min(minGap, sim._col.dist - (m.back.width + m.front.width))
      }
      // The sisters must not overlap, must end up further apart than they were
      // released, and must not be heading at each other.
      if (minGap < -0.01) sisterProblems.push(`sisters overlapped after division (min gap ${minGap.toFixed(3)})`)
      capsuleDist(sim, m.back, m.front)
      const finalGap = sim._col.dist - (m.back.width + m.front.width)
      if (finalGap < 0.1) sisterProblems.push(`sisters did not part (gap ${finalGap.toFixed(3)} after 8 s)`)
      const n = new THREE.Vector3().copy(m.front.pos).normalize()
      const axis = new THREE.Vector3().subVectors(m.front.pos, m.back.pos).normalize()
      for (const [side, dir] of [[m.front, 1], [m.back, -1]]) {
        const fwd = side.heading.clone().addScaledVector(n, -side.heading.dot(n)).normalize()
        const along = fwd.dot(axis) * dir
        if (along < 0) sisterProblems.push(`a released daughter still heads at its sister (cos ${along.toFixed(2)})`)
      }
    }
    resetParams()
  }
  report('division separation', sisterProblems, 'released sisters turn apart, never overlap, and part')

  // Component smoke: the chart SFCs must render to a string without touching the
  // DOM (scaleCanvas/draw only run on mount, which SSR skips).
  const componentProblems = []
  {
    const pop = [
      { t: 0, green: 50, red: 15 },
      { t: 10, green: 60, red: 14 },
    ]
    const rates = { alpha: 0.1, gamma: 0.0025, attack: 0.8 }
    for (const path of ['/src/components/PopChart.vue', '/src/components/RateChart.vue']) {
      try {
        const mod = await server.ssrLoadModule(path)
        const html = await renderToString(
          createSSRApp(mod.default, { samples: pop, popSamples: pop, rates }),
        )
        if (!html || html.length < 50) componentProblems.push(`${path} rendered empty`)
      } catch (err) {
        componentProblems.push(`${path}: ${err && err.message ? err.message : String(err)}`)
      }
    }
  }
  report('chart components SSR render', componentProblems, 'PopChart/RateChart render to string')
} finally {
  await server.close()
}

process.exit(code)
