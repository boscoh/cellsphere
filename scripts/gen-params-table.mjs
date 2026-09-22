// Regenerates the tuning-constants table in docs/DESIGN.md from the single
// source of truth, src/constants.js. Run with --write to update the doc, or
// --check to fail when it has drifted (wired into `npm run build`).
//
// The fixed constants have no description in the module, so they carry one
// here; adding a fixed constant without a role fails the run on purpose.

import { readFile, writeFile } from 'node:fs/promises'

const BEGIN = '<!-- BEGIN GENERATED: tuning constants -->'
const END = '<!-- END GENERATED: tuning constants -->'
const DOC = new URL('../docs/DESIGN.md', import.meta.url)

const FIXED_ROLES = {
  SHELL_GAP: 'gap between the collision surface and the sphere shell mesh',
  SURFACE: 'surface offset (`SPHERE_RADIUS + SHELL_GAP`); every entity is placed here',
  MAX_CELLS: 'logical population ceiling; pools grow on demand rather than reserving it',
  GRID: 'food spatial-hash cell size',
  FOOD_RADIUS_MIN: 'minimum per-particle food radius',
  FOOD_RADIUS_MAX: 'maximum per-particle food radius; feeds the sense-scan radius',
  CELL_GRID: 'cell spatial-hash cell size',
  FIXED_DT: 'physics substep, in seconds (1/60)',
  MAX_STEPS: 'per-frame substep ceiling',
  MAX_SIM_RATE: 'speed slider cap, and the `SIM_SPEED` parameter maximum',
  SAMPLE_DT: 'sim-time spacing between population-history samples; fixed so sample spacing stays constant at any speed',
  ACF_MAX_S: 'largest autocorrelation window, in sim seconds: the retained span (`POP_WINDOW_S`), so the panel cannot ask for more history than the window holds',
  ACF_MIN_S: 'smallest autocorrelation window, in sim seconds (used when no textbook period is available)',
  POP_WINDOW_S: 'sim-time span of the sliding population window both chart panels read; older samples are dropped, so nothing grows with run length',
  MIN_RADIUS: 'radius at zero energy',
  MAX_RADIUS: 'radius at full energy; chosen so a full cell exactly spans both daughters',
  START_RADIUS: 'spawn radius',
  WIDTH: 'base body width; per-cell width is `WIDTH * RED_SIZE` for reds',
  ENERGY_MAX: 'energy at which a cell divides; size is linear in energy',
  TAIL_LINK: 'tail link pitch; `TAIL_SEGMENTS = round(1.5 * MAX_RADIUS / TAIL_LINK)`',
  TAIL_SEGMENTS: 'tail segments per cell',
  TAIL_MOTOR_AMP: 'tail wave amplitude (40 degrees, in radians)',
  TAIL_DYN_SUB: 'spring-chain substeps per step',
  TAIL_CHUNK_CELLS: 'cells per tail instance chunk',
  BODY_CHUNK_CELLS: 'cells per body instance chunk',
  CULL_COS: 'cos(normal, cam) at or below which a tail is culled',
}

function fmt(value) {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(6)))
}

function table(rows) {
  return [
    '| Parameter | Default | Role |',
    '|---|---|---|',
    ...rows.map(([name, value, role]) => `| \`${name}\` | ${value} | ${role} |`),
  ].join('\n')
}

export function render(constants) {
  const paramKeys = new Set(constants.PARAM_DEFS.map((p) => p.key))
  const fixed = Object.entries(constants)
    .filter(([key, value]) => typeof value === 'number' && !paramKeys.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const role = FIXED_ROLES[key]
      if (!role) throw new Error(`no role recorded for fixed constant ${key}`)
      return [key, fmt(value), role]
    })

  const out = [
    '_Fixed constants (not tunable at runtime)._',
    '',
    table(fixed),
    '',
    '_Editable at runtime in the Tuner (`PARAM_DEFS`)._',
  ]

  for (const group of constants.GROUPS) {
    const rows = constants.PARAM_DEFS.filter((p) => p.group === group.key).map((p) => [
      p.key,
      fmt(p.def),
      p.desc,
    ])
    if (!rows.length) continue
    out.push('', `**${group.label}**`, '', table(rows))
  }

  return out.join('\n')
}

function splice(text, block) {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start === -1 || end === -1) {
    throw new Error(`markers not found in ${DOC.pathname}`)
  }
  return text.slice(0, start) + `${BEGIN}\n${block}\n${END}` + text.slice(end + END.length)
}

const constants = await import('../src/constants.js')
const block = render(constants)
const text = await readFile(DOC, 'utf8')
const next = splice(text, block)

if (process.argv.includes('--check')) {
  if (next === text) {
    console.log('PASS tuning table: docs/DESIGN.md matches src/constants.js')
  } else {
    const firstDiff = [...text].findIndex((ch, i) => ch !== next[i])
    const line = text.slice(0, firstDiff).split('\n').length
    console.error(`FAIL tuning table: docs/DESIGN.md is stale near line ${line}`)
    console.error('  Run: node scripts/gen-params-table.mjs --write')
    process.exit(1)
  }
} else {
  await writeFile(DOC, next)
  console.log('Wrote the tuning table to docs/DESIGN.md')
}
