// Pure helpers for the population chart. Kept out of the SFC so the cycle-period
// estimate and the regime classifier are testable without a DOM.

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

// Upward mean-crossings of a smoothed series. Crossings (not peaks) make the
// period estimate robust to the amplitude modulation a predator-prey cycle shows.
// Returns null until at least one full cycle exists, or if the series is too flat
// to define one.
export function analyzeCycle(samples, key, { window = 5, minRelativeRange = 0.02 } = {}) {
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

  return {
    period,
    omega: (2 * Math.PI) / period,
    cycles: crossings.length - 1,
    crossings,
    periods,
    periodCV,
    ampTrend: peakTrend(peaks),
  }
}

export function estimateCyclePeriod(samples, key, opts = {}) {
  const a = analyzeCycle(samples, key, opts)
  if (!a) return null
  return { period: a.period, omega: a.omega, crossings: a.crossings, cycles: a.cycles }
}

// Empirical regime classifier from a prey count series. The four LV rates set the
// clock and the coexistence scale, but in this model (explicit food resource +
// ratio-dependent attack) whether the trajectory settles onto a limit cycle is
// read off the trajectory, not the rates. So classify on the history:
// persistence, envelope trend, and period stability.
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

// Per-capita growth rates measured from a population history:
//   rN = (1/N) dN/dt,  rP = (1/P) dP/dt
// The derivative is taken over a *time stencil* of +/-window seconds, not between
// adjacent samples: counts are small integers, so adjacent-sample differences are
// dominated by counting noise (a single prey event is ~1/N at one sample). The
// stencil averages that out and shows the slow growth/decline phases. window is
// clamped to span/4 so short histories still vary. Zero-crossings of these rates
// are the effective equilibria (rN = 0 at P* = alpha/beta, rP = 0 at N* = gamma/delta).
export function perCapitaRates(samples, { window = 20 } = {}) {
  const n = samples ? samples.length : 0
  if (n < 3) return []
  const span = samples[n - 1].t - samples[0].t
  const W = Math.max(1e-6, Math.min(window, span / 4))
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const c = samples[i]
    let a = i
    while (a > 0 && c.t - samples[a].t < W) a--
    let b = i
    while (b < n - 1 && samples[b].t - c.t < W) b++
    const dt = samples[b].t - samples[a].t
    out[i] = {
      t: c.t,
      n: c.blue,
      p: c.red,
      rN: dt > 0 && c.blue > 0 ? (samples[b].blue - samples[a].blue) / dt / c.blue : 0,
      rP: dt > 0 && c.red > 0 ? (samples[b].red - samples[a].red) / dt / c.red : 0,
    }
  }
  return out
}

// Times where each per-capita rate crosses zero. At an rN = 0 crossing the
// predator count equals the effective P* = alpha/beta; at rP = 0 the prey count
// equals N* = gamma/delta. These are the turning points of the cycle.
export function rateZeroCrossings(samples, opts = {}) {
  const rates = perCapitaRates(samples, opts)
  const rN = []
  const rP = []
  for (let i = 1; i < rates.length; i++) {
    const a = rates[i - 1]
    const b = rates[i]
    if ((a.rN <= 0) !== (b.rN <= 0)) {
      const f = a.rN === b.rN ? 0 : (0 - a.rN) / (b.rN - a.rN)
      rN.push({ t: a.t + f * (b.t - a.t), level: a.p + f * (b.p - a.p) })
    }
    if ((a.rP <= 0) !== (b.rP <= 0)) {
      const f = a.rP === b.rP ? 0 : (0 - a.rP) / (b.rP - a.rP)
      rP.push({ t: a.t + f * (b.t - a.t), level: a.n + f * (b.n - a.n) })
    }
  }
  return { rN, rP }
}

// Keep only samples within `span` (in t units) of the newest sample. Used to show
// a sliding window; callers compute rates on the full history first so the finite
// differences keep their central-difference neighbours at the window edge.
export function sliceWindow(samples, span) {
  if (!samples || samples.length < 2) return samples || []
  const t0 = samples[samples.length - 1].t - span
  let i = samples.length - 1
  while (i > 0 && samples[i - 1].t >= t0) i--
  return samples.slice(i)
}

function fitLine(xs, ys) {
  const n = xs.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
    sxx += xs[i] * xs[i]
    sxy += xs[i] * ys[i]
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const slope = (n * sxy - sx * sy) / denom
  return { slope, intercept: (sy - slope * sx) / n }
}

// Fit the LV rate plane from the trajectory:
//   rN = alpha - beta * P      (alpha = intercept, beta = -slope)
//   rP = delta * N - gamma     (delta = slope, gamma = -intercept)
// These are the rates the run actually exhibits, not the knob values.
export function fitRatePlane(samples, { minPop = 1, window = 20 } = {}) {
  const rates = perCapitaRates(samples, { window })
  const xsN = []
  const ysN = []
  const xsP = []
  const ysP = []
  for (const r of rates) {
    if (r.p >= minPop) {
      xsN.push(r.p)
      ysN.push(r.rN)
    }
    if (r.n >= minPop) {
      xsP.push(r.n)
      ysP.push(r.rP)
    }
  }
  const fN = fitLine(xsN, ysN)
  const fP = fitLine(xsP, ysP)
  return {
    rn: fN ? { ...fN, xs: xsN, ys: ysN } : null,
    rp: fP ? { ...fP, xs: xsP, ys: ysP } : null,
    alpha: fN ? fN.intercept : null,
    beta: fN ? -fN.slope : null,
    delta: fP ? fP.slope : null,
    gamma: fP ? -fP.intercept : null,
    // Nullclines in population units: the predator count at which prey stop
    // growing, and the prey count at which predators stop growing.
    preyNull: fN && fN.slope !== 0 ? -fN.intercept / fN.slope : null,
    predNull: fP && fP.slope !== 0 ? -fP.intercept / fP.slope : null,
  }
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

// Measured cycle length in seconds: the autocorrelation peak lag, or null when
// there is no clear repeating period. Shared by both chart footers so they agree.
export function cycleLength(samples, key = 'blue') {
  const pk = acfPeak(autocorrelation(samples, key))
  return pk ? pk.lag : null
}
