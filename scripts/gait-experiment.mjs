// Seeded headless A/B harness for the opt-in gait prototype (cell-d4z).
//
// Runs a fixed-seed world for a given sim time and reports ecology (green/red
// population range, curve crossings, extinction) plus locomotion stats (mean
// drive/speed/|headingRate| and the gait phase / forward-mode mix). Pose is
// disabled: it is visual-only and never writes body state, so turning it off is
// free and makes long runs bearable.
//
// Usage:
//   node scripts/gait-experiment.mjs --seed 1 --duration 600
//   node scripts/gait-experiment.mjs --seed 1 --duration 600 --gait 1
//   node scripts/gait-experiment.mjs --seed 1 --duration 600 --set GAIT_TURN_DRIVE=0.4

import { Simulation } from '../src/sim.js'
import { P } from '../src/constants.js'
import { mulberry32 } from '../src/util.js'

import { pathToFileURL } from 'node:url'

const DT = 1 / 60
const SAMPLE_DT = 0.5

function parseArgs(argv) {
  const out = { seed: 1, duration: 600, gait: null, set: [] }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seed') out.seed = Number(argv[++i])
    else if (a === '--duration') out.duration = Number(argv[++i])
    else if (a === '--gait') out.gait = Number(argv[++i])
    else if (a === '--set') out.set.push(argv[++i])
  }
  return out
}

function applyOverrides(overrides) {
  const before = {}
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in P)) throw new Error(`unknown parameter ${k}`)
    before[k] = P[k]
    P[k] = v
  }
  return before
}

export function run({ seed, duration, overrides }) {
  const saved = applyOverrides(overrides)
  const savedRandom = Math.random
  Math.random = mulberry32(seed)
  try {
    const sim = new Simulation()
    sim.poseEnabled = false
    sim.buildWorld()

    const samples = []
    const loco = {
      n: 0,
      drive: 0,
      speed: 0,
      spin: 0,
      turn: 0,
      mode: [0, 0, 0],
      green: { drive: 0, speed: 0, spin: 0, turn: 0, n: 0, energy: 0 },
      red: { drive: 0, speed: 0, spin: 0, turn: 0, n: 0, energy: 0 },
    }
    let births = 0
    let prevCells = sim.cells.length
    let nonfinite = 0

    const steps = Math.round(duration / DT)
    const sampleEvery = Math.round(SAMPLE_DT / DT)
    for (let i = 0; i < steps; i++) {
      sim.advance(DT)
      if (i % sampleEvery === 0) {
        let green = 0
        let red = 0
        for (const d of sim.cells) {
          if (d.dead) continue
          if (d.breed === 0) green++
          else red++
        }
        samples.push([green, red])
      }
      if (sim.cells.length > prevCells) births += sim.cells.length - prevCells
      prevCells = sim.cells.length

      for (const d of sim.cells) {
        if (d.dead) continue
        if (!Number.isFinite(d.pos.x + d.pos.y + d.pos.z + d.energy)) nonfinite++
        loco.n++
        loco.drive += Math.abs(d.drive || 0)
        loco.speed += Math.hypot(d.vel.x, d.vel.y, d.vel.z)
        loco.spin += Math.abs(d.headingRate || 0)
        if (d.gait === 1) loco.turn++
        loco.mode[d.gaitMode || 0]++
        const b = d.breed === 0 ? loco.green : loco.red
        b.n++
        b.drive += Math.abs(d.drive || 0)
        b.speed += Math.hypot(d.vel.x, d.vel.y, d.vel.z)
        b.spin += Math.abs(d.headingRate || 0)
        b.energy += d.energy || 0
        if (d.gait === 1) b.turn++
      }
    }

    let greenMin = Infinity
    let greenMax = 0
    let redMin = Infinity
    let redMax = 0
    let crossings = 0
    let prevSign = 0
    for (const [b, r] of samples) {
      greenMin = Math.min(greenMin, b)
      greenMax = Math.max(greenMax, b)
      redMin = Math.min(redMin, r)
      redMax = Math.max(redMax, r)
      const sign = b > r ? 1 : b < r ? -1 : 0
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++
      if (sign !== 0) prevSign = sign
    }
    const last = samples[samples.length - 1] || [0, 0]
    return {
      seed,
      duration,
      green: [greenMin, greenMax, last[0]],
      red: [redMin, redMax, last[1]],
      crossings,
      extinct: last[0] === 0 || last[1] === 0,
      births,
      nonfinite,
      loco,
    }
  } finally {
    Math.random = savedRandom
    Object.assign(P, saved)
  }
}

function fmtRange(r) {
  return `${r[0]}..${r[1]} (end ${r[2]})`
}

function report(tag, res) {
  const { loco } = res
  const pct = (x) => `${((100 * x) / Math.max(1, loco.n)).toFixed(1)}%`
  const mean = (v) => (v / Math.max(1, loco.n)).toFixed(3)
  const bmean = (v) => (v / Math.max(1, loco.green.n)).toFixed(3)
  const rmean = (v) => (v / Math.max(1, loco.red.n)).toFixed(3)
  console.log(`\n${tag}  seed ${res.seed}, ${res.duration}s`)
  console.log(`  green ${fmtRange(res.green)}   red ${fmtRange(res.red)}`)
  console.log(`  crossings ${res.crossings}   births ${res.births}   extinct ${res.extinct}`)
  console.log(`  all : drive ${mean(loco.drive)}  speed ${mean(loco.speed)}  spin ${mean(loco.spin)}  turn ${pct(loco.turn)}  mode g/d/e ${pct(loco.mode[0])}/${pct(loco.mode[1])}/${pct(loco.mode[2])}`)
  console.log(`  green: drive ${bmean(loco.green.drive)}  speed ${bmean(loco.green.speed)}  spin ${bmean(loco.green.spin)}  turn ${((100 * loco.green.turn) / Math.max(1, loco.green.n)).toFixed(1)}%`)
  console.log(`  red : drive ${rmean(loco.red.drive)}  speed ${rmean(loco.red.speed)}  spin ${rmean(loco.red.spin)}  turn ${((100 * loco.red.turn) / Math.max(1, loco.red.n)).toFixed(1)}%`)
}

const args = parseArgs(process.argv)
const overrides = {}
for (const s of args.set) {
  const [k, v] = s.split('=')
  overrides[k] = Number(v)
}
if (args.gait !== null) overrides.GAIT_MODE = args.gait

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  report('baseline', run({ seed: args.seed, duration: args.duration, overrides: {} }))
  if (Object.keys(overrides).length) {
    report(`gait ${JSON.stringify(overrides)}`, run({ seed: args.seed, duration: args.duration, overrides }))
  }
}
