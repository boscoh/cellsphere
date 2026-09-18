import * as THREE from 'three'
import { createServer } from 'vite'

const SEED = 1
const DT = 1 / 60
// The hidden/visible equivalence is structural, so a handful of substeps is
// enough: a pose write-back would surface on the next `advance`. Everything
// else exercises the tail pathway directly, without stepping the simulation.
const EQUIV_STEPS = 8

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
      sim.buildWorld()
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
      sim.tailsHidden = tailsHidden
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
    tailPool.inheritTailSlot(sim, parent, daughter)
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
    tailPool.releaseTail(sim, parent)
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
      if (i % 3 === 0) tailPool.releaseTail(sim, sim.cells[i])
      else kept.push(sim.cells[i])
    }
    sim.cells = kept
    for (let i = 0; i < 5; i++) {
      const born = { color: new THREE.Color(1, 1, 1) }
      tailPool.claimTailSlot(sim, born)
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
      const ci = sim.tailChunks.indexOf(d.tailChunk)
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
    for (let ci = 0; ci < sim.tailChunks.length; ci++) {
      const chunk = sim.tailChunks[ci]
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
    sim.tailsHidden = false
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
} finally {
  await server.close()
}

process.exit(code)
