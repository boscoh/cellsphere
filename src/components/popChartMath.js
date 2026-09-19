// Pure helpers for the charts: empirical regime classification from the prey
// counts, and the autocorrelation cycle test. Kept out of the SFCs so they are
// testable without a DOM.

function smooth(values, window) {
  if (window <= 1) return values.slice()
  const half = Math.floor(window / 2)
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let sum = 0
    let n = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= values.length) continue
      sum += values[j]
      n++
    }
    out[i] = sum / n
  }
  return out
}

// Fractional change in peak height per cycle (least-squares slope over the peak
// values, normalised by their mean). Negative = envelope shrinking.
function peakTrend(peaks) {
  const n = peaks.length
  if (n < 3) return 0
  let sum = 0
  for (const p of peaks) sum += p.v
  const meanV = sum / n
  if (!(meanV > 0)) return 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sx += i
    sy += peaks[i].v
    sxx += i * i
    sxy += i * peaks[i].v
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return 0
  return (n * sxy - sx * sy) / denom / meanV
}

// Upward mean-crossings of a smoothed series, and the period/envelope statistics
// derived from them. Returns null until at least one full cycle exists, or if the
// series is too flat to define one.
function analyzeCycle(samples, key, { window = 5, minRelativeRange = 0.02 } = {}) {
  if (!samples || samples.length < 3) return null
  const values = samples.map((s) => s[key])
  const sm = smooth(values, window)
  let lo = Infinity
  let hi = -Infinity
  for (const v of sm) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const range = hi - lo
  if (range < Math.max(1, minRelativeRange * hi)) return null

  const mean = (hi + lo) / 2
  const crossings = []
  for (let i = 1; i < sm.length; i++) {
    const a = sm[i - 1]
    const b = sm[i]
    if (a <= mean && b > mean) {
      const f = (mean - a) / (b - a || 1)
      crossings.push(samples[i - 1].t + f * (samples[i].t - samples[i - 1].t))
    }
  }
  if (crossings.length < 2) return null

  const periods = []
  for (let i = 1; i < crossings.length; i++) periods.push(crossings[i] - crossings[i - 1])
  const meanP = periods.reduce((s, p) => s + p, 0) / periods.length
  if (!(meanP > 0)) return null
  let variance = 0
  for (const p of periods) variance += (p - meanP) * (p - meanP)
  const periodCV = Math.sqrt(variance / periods.length) / meanP

  const sorted = periods.slice().sort((x, y) => x - y)
  const period = sorted[Math.floor(sorted.length / 2)]

  const peaks = []
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1]) peaks.push({ t: samples[i].t, v: sm[i] })
  }

  return { period, cycles: crossings.length - 1, periodCV, ampTrend: peakTrend(peaks) }
}

// Empirical regime classifier from a prey count series. Whether the trajectory
// settles onto a limit cycle is read off the trajectory, not the rates, so
// classify on the history: persistence, envelope trend, and period stability.
export function classifyRegime(samples) {
  if (!samples || samples.length < 3) return { label: 'no data', tone: 'muted', cycles: 0 }
  const last = samples[samples.length - 1]
  if (last.blue === 0 && last.red === 0) return { label: 'collapsed', tone: 'bad', cycles: 0 }
  if (last.blue === 0) return { label: 'prey extinct', tone: 'bad', cycles: 0 }
  if (last.red === 0) return { label: 'predators extinct', tone: 'bad', cycles: 0 }

  const a = analyzeCycle(samples, 'blue')
  if (!a || a.cycles < 2) return { label: 'transient', tone: 'muted', cycles: a ? a.cycles : 0 }

  const base = { cycles: a.cycles, period: a.period, periodCV: a.periodCV, ampTrend: a.ampTrend }
  if (a.ampTrend < -0.08) return { label: 'damped', tone: 'warn', ...base }
  if (a.ampTrend > 0.08) return { label: 'diverging', tone: 'warn', ...base }
  if (a.periodCV <= 0.3) return { label: 'cyclic', tone: 'good', ...base }
  return { label: 'irregular', tone: 'warn', ...base }
}

// Normalised autocorrelation of a linearly-detrended series. This is the robust
// test for a cycle: a peak at lag T means the population really repeats every T,
// and unlike a per-capita rate it is not swamped by small-count noise.
export function autocorrelation(samples, key, { maxLag = null } = {}) {
  const n = samples ? samples.length : 0
  if (n < 8) return null
  const t0 = samples[0].t
  const ts = new Array(n)
  const xs = new Array(n)
  for (let i = 0; i < n; i++) {
    ts[i] = samples[i].t - t0
    xs[i] = samples[i][key]
  }
  // Least-squares linear detrend so a slow drift cannot masquerade as a cycle.
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sx += ts[i]
    sy += xs[i]
    sxx += ts[i] * ts[i]
    sxy += ts[i] * xs[i]
  }
  const den = n * sxx - sx * sx
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den
  const intercept = (sy - slope * sx) / n
  let denom = 0
  const dev = new Array(n)
  for (let i = 0; i < n; i++) {
    dev[i] = xs[i] - (intercept + slope * ts[i])
    denom += dev[i] * dev[i]
  }
  if (!(denom > 0)) return null
  const dt = (samples[n - 1].t - samples[0].t) / (n - 1)
  const spanS = samples[n - 1].t - samples[0].t
  const lagS = maxLag == null ? spanS / 2 : maxLag
  const maxK = Math.max(1, Math.min(Math.floor(n / 2), Math.round(lagS / (dt || 1))))
  const out = []
  for (let k = 0; k <= maxK; k++) {
    let sum = 0
    for (let i = 0; i + k < n; i++) sum += dev[i] * dev[i + k]
    out.push({ lag: k * dt, r: sum / denom })
  }
  return out
}

// First local maximum of the autocorrelation above `minR` (skipping lag 0).
export function acfPeak(acf, { minR = 0.2 } = {}) {
  if (!acf || acf.length < 3) return null
  for (let i = 1; i < acf.length - 1; i++) {
    if (acf[i].r > minR && acf[i].r > acf[i - 1].r && acf[i].r >= acf[i + 1].r) return acf[i]
  }
  return null
}
