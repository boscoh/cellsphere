// Format the JSON lines from `gait-sweep.sh` into one aligned table. Kept
// separate so the sweep can run configs in parallel and stream results.

const ORDER = [
  'baseline',
  'both',
  'prey-only',
  'pred-only',
  'td-0.35',
  'td-0.5',
  'mt-1.2',
  'no-drift',
  'tumble',
]

const input = await new Promise((resolve) => {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => (data += chunk))
  process.stdin.on('end', () => resolve(data))
})

const byLabel = new Map()
for (const line of input.split('\n')) {
  const t = line.trim()
  if (!t) continue
  const row = JSON.parse(t)
  byLabel.set(row.label, row)
}

const rows = ORDER.filter((l) => byLabel.has(l)).map((l) => byLabel.get(l))

const cols = [
  ['label', 10],
  ['ex', 3],
  ['NaN', 4],
  ['xing', 5],
  ['blue', 11],
  ['red', 11],
  ['end', 11],
  ['births', 6],
  ['bDrive', 6],
  ['bSpd', 5],
  ['rDrive', 6],
  ['rSpd', 5],
  ['turn%', 5],
  ['bTrn', 4],
  ['rTrn', 4],
]

const header = cols.map(([h, w]) => h.padEnd(w)).join(' ')
console.log(header)
console.log('-'.repeat(header.length))
for (const r of rows) {
  const vals = {
    label: r.label,
    ex: r.extinctions,
    NaN: r.nonfinite,
    xing: r.crossingsTotal,
    blue: `${r.blueMin}..${r.blueMax}`,
    red: `${r.redMin}..${r.redMax}`,
    end: `${r.blueEnd}/${r.redEnd}`,
    births: r.birthsMean,
    bDrive: r.blueDrive,
    bSpd: r.blueSpeed,
    rDrive: r.redDrive,
    rSpd: r.redSpeed,
    'turn%': r.turnPct,
    bTrn: r.blueTurnPct,
    rTrn: r.redTurnPct,
  }
  console.log(cols.map(([h, w]) => String(vals[h]).padEnd(w)).join(' '))
}
console.log(`\n${rows[0]?.seeds.length ?? 0} seeds, ${rows[0]?.duration ?? '?'}s per run`)
