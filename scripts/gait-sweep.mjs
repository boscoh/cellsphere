// Aggregate a gait sweep (cell-aj9): run one config over several seeds and
// print a single JSON summary line. Launch one process per config in parallel;
// `scripts/gait-sweep.sh` does that and combines the lines.
//
// Usage:
//   node scripts/gait-sweep.mjs --label baseline --config '{}' --seeds 1,2,3,4,5 --duration 1800

import { run } from './gait-experiment.mjs'

function parseArgs(argv) {
  const out = { label: 'config', config: '{}', seeds: [1, 2, 3, 4, 5], duration: 1800 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--label') out.label = argv[++i]
    else if (a === '--config') out.config = argv[++i]
    else if (a === '--seeds') out.seeds = argv[++i].split(',').map(Number)
    else if (a === '--duration') out.duration = Number(argv[++i])
  }
  return out
}

const args = parseArgs(process.argv)
const overrides = JSON.parse(args.config)
const results = args.seeds.map((seed) => run({ seed, duration: args.duration, overrides }))

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const bMean = (r, k) => mean(r.map((x) => x.loco.green[k] / Math.max(1, x.loco.green.n)))
const rMean = (r, k) => mean(r.map((x) => x.loco.red[k] / Math.max(1, x.loco.red.n)))
const turnPct = mean(
  results.map((x) => (100 * x.loco.turn) / Math.max(1, x.loco.n)),
)
const greenTurnPct = mean(
  results.map((x) => (100 * x.loco.green.turn) / Math.max(1, x.loco.green.n)),
)
const redTurnPct = mean(
  results.map((x) => (100 * x.loco.red.turn) / Math.max(1, x.loco.red.n)),
)

const out = {
  label: args.label,
  config: overrides,
  duration: args.duration,
  seeds: args.seeds,
  extinctions: results.filter((x) => x.extinct).length,
  nonfinite: results.reduce((a, x) => a + x.nonfinite, 0),
  crossingsTotal: results.reduce((a, x) => a + x.crossings, 0),
  greenMin: Math.min(...results.map((x) => x.green[0])),
  greenMax: Math.max(...results.map((x) => x.green[1])),
  redMin: Math.min(...results.map((x) => x.red[0])),
  redMax: Math.max(...results.map((x) => x.red[1])),
  greenEnd: mean(results.map((x) => x.green[2])).toFixed(1),
  redEnd: mean(results.map((x) => x.red[2])).toFixed(1),
  birthsMean: mean(results.map((x) => x.births)).toFixed(0),
  greenDrive: bMean(results, 'drive').toFixed(3),
  greenSpeed: bMean(results, 'speed').toFixed(3),
  greenEnergy: bMean(results, 'energy').toFixed(3),
  redDrive: rMean(results, 'drive').toFixed(3),
  redSpeed: rMean(results, 'speed').toFixed(3),
  turnPct: turnPct.toFixed(1),
  greenTurnPct: greenTurnPct.toFixed(1),
  redTurnPct: redTurnPct.toFixed(1),
}

console.log(JSON.stringify(out))
