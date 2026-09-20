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
  if (last.green === 0 && last.red === 0) return { label: 'collapsed', tone: 'bad', cycles: 0 }
  if (last.green === 0) return { label: 'prey extinct', tone: 'bad', cycles: 0 }
  if (last.red === 0) return { label: 'predators extinct', tone: 'bad', cycles: 0 }

  const a = analyzeCycle(samples, 'green')
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

const ACF_MIN_SAMPLES = 8
// Sliding sums lose precision one add/subtract at a time, so replay the window
// from scratch this often (the window itself is bounded, so the drift is small).
const ACF_RESYNC_EVERY = 100000

// Incremental version of the autocorrelation above: an online sliding window of
// the last `size` samples whose raw per-lag pair sums are kept current, so a
// refresh costs O(size) instead of O(size^2). Detrending is not an obstacle
// because `sum dev_i dev_{i+k}` expands back into the raw pair sums:
//
//   C_k = S_k - A*U_k - B*V_k + A^2*N_k + A*B*T1_k + B^2*T2_k
//
// where the window's least-squares line is `A + B*t`, `S_k = sum x_i x_{i+k}`,
// `U_k = sum (x_i + x_{i+k})`, `V_k = sum (t_i x_{i+k} + t_{i+k} x_i)` and
// `T1_k`/`T2_k` are the same sums of the timestamps alone. Exactly one pair
// enters and one leaves per lag on a slide, so the update is O(size) per sample.
// `setSize` keeps the last `min(count, size)` samples; shrinking is O(size^2)
// because the lag rows have to be rebuilt from the retained window.
export function createAcfTracker(size = 64) {
  let cap = Math.max(2, Math.floor(size))
  let bufT = new Float64Array(cap)
  let bufX = new Float64Array(cap)
  let start = 0
  let count = 0
  let K = 0
  let S = new Float64Array(1)
  let U = new Float64Array(1)
  let V = new Float64Array(1)
  let T1 = new Float64Array(1)
  let T2 = new Float64Array(1)
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let syy = 0
  let drift = 0

  function growLags(next) {
    const len = next + 1
    const nS = new Float64Array(len)
    const nU = new Float64Array(len)
    const nV = new Float64Array(len)
    const nT1 = new Float64Array(len)
    const nT2 = new Float64Array(len)
    nS.set(S)
    nU.set(U)
    nV.set(V)
    nT1.set(T1)
    nT2.set(T2)
    S = nS
    U = nU
    V = nV
    T1 = nT1
    T2 = nT2
    K = next
  }

  function pair(k, i, j, sign) {
    const xi = bufX[i]
    const xj = bufX[j]
    const ti = bufT[i]
    const tj = bufT[j]
    S[k] += sign * xi * xj
    U[k] += sign * (xi + xj)
    V[k] += sign * (ti * xj + tj * xi)
    T1[k] += sign * (ti + tj)
    T2[k] += sign * ti * tj
  }

  // Sum lag k over the whole window; used when the row first appears and on
  // resync.
  function initLag(k) {
    S[k] = 0
    U[k] = 0
    V[k] = 0
    T1[k] = 0
    T2[k] = 0
    for (let i = 0; i + k < count; i++) {
      pair(k, (start + i) % cap, (start + i + k) % cap, 1)
    }
  }

  function append(t, x) {
    const pos = (start + count) % cap
    bufT[pos] = t
    bufX[pos] = x
    count++
    const n = count
    const grew = Math.floor(n / 2) > K
    if (grew) growLags(Math.floor(n / 2))
    for (let k = 1; k < n && k <= K; k++) {
      if (grew && k === K) break
      pair(k, (pos - k + cap) % cap, pos, 1)
    }
    if (grew) initLag(K)
    sx += t
    sy += x
    sxx += t * t
    sxy += t * x
    syy += x * x
  }

  function slide(t, x) {
    const old = start
    for (let k = 1; k <= K; k++) pair(k, old, (old + k) % cap, -1)
    const ot = bufT[old]
    const ox = bufX[old]
    sx -= ot
    sy -= ox
    sxx -= ot * ot
    sxy -= ot * ox
    syy -= ox * ox
    bufT[old] = t
    bufX[old] = x
    for (let k = 1; k <= K; k++) pair(k, (old - k + cap) % cap, old, 1)
    sx += t
    sy += x
    sxx += t * t
    sxy += t * x
    syy += x * x
    start = (start + 1) % cap
  }

  function reset() {
    start = 0
    count = 0
    K = 0
    S = new Float64Array(1)
    U = new Float64Array(1)
    V = new Float64Array(1)
    T1 = new Float64Array(1)
    T2 = new Float64Array(1)
    sx = 0
    sy = 0
    sxx = 0
    sxy = 0
    syy = 0
    drift = 0
  }

  function resync() {
    const n = count
    const ts = new Float64Array(n)
    const xs = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const s = (start + i) % cap
      ts[i] = bufT[s]
      xs[i] = bufX[s]
    }
    reset()
    for (let i = 0; i < n; i++) append(ts[i], xs[i])
  }

  function setSize(next) {
    const want = Math.max(2, Math.floor(next))
    if (want === cap) return
    const n = count
    const keep = Math.min(n, want)
    const ts = new Float64Array(keep)
    const xs = new Float64Array(keep)
    for (let i = 0; i < keep; i++) {
      const s = (start + n - keep + i) % cap
      ts[i] = bufT[s]
      xs[i] = bufX[s]
    }
    cap = want
    bufT = new Float64Array(cap)
    bufX = new Float64Array(cap)
    reset()
    for (let i = 0; i < keep; i++) append(ts[i], xs[i])
  }

  function push(t, x) {
    if (count < cap) append(t, x)
    else slide(t, x)
    if (++drift >= ACF_RESYNC_EVERY) resync()
  }

  // Same shape as `autocorrelation`, computed from the running sums.
  function series() {
    const n = count
    if (n < ACF_MIN_SAMPLES) return null
    const den = n * sxx - sx * sx
    const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den
    const intercept = (sy - slope * sx) / n
    const denom =
      syy - 2 * intercept * sy - 2 * slope * sxy +
      n * intercept * intercept + 2 * intercept * slope * sx + slope * slope * sxx
    if (!(denom > 0)) return null
    const dt = (bufT[(start + n - 1) % cap] - bufT[start]) / (n - 1)
    // Lag 0 is exactly the denominator, so it is set rather than summed.
    const out = new Array(K + 1)
    out[0] = { lag: 0, r: 1 }
    for (let k = 1; k <= K; k++) {
      const C =
        S[k] - intercept * U[k] - slope * V[k] +
        intercept * intercept * (n - k) +
        intercept * slope * T1[k] + slope * slope * T2[k]
      out[k] = { lag: k * dt, r: C / denom }
    }
    return out
  }

  return { push, reset, setSize, series, get count() { return count }, get size() { return cap } }
}

// Widest interior maximum of a positive series: the broadest plateau of values
// within `tol` of a local peak, with lower values on both sides so it cannot be
// the edge of the window (for an ACF, the lag-0 lobe). Candidates are ranked by
// prominence -- the height above the higher of the two saddles bounding the hump
// -- so a genuine dome beats a taller but one-sided shoulder. The plateau centre
// is reported rather than the argmax, which is what stays stable when the top of
// a broad peak is flat or noisy.
export function broadMaximum(
  series,
  key,
  { tol = 0.1, minWidth = 3, margin = 2, minValue = 0, minProminence = 0 } = {},
) {
  const n = series ? series.length : 0
  if (n < 2 * margin + minWidth) return null

  let best = null
  for (let i = margin; i < n - margin; i++) {
    const v = series[i][key]
    if (!(v > minValue)) continue
    if (!(v > series[i - 1][key] && v >= series[i + 1][key])) continue

    const band = tol * v
    let a = i
    let b = i
    while (a > 0 && series[a - 1][key] >= v - band) a--
    while (b < n - 1 && series[b + 1][key] >= v - band) b++
    const width = b - a + 1
    if (width < minWidth) continue

    // Walk out until a taller point bounds each flank; a flank that runs into
    // the window edge (or an equal-height plateau) leaves the saddle unbounded.
    let lo = Infinity
    for (let j = a - 1; j >= 0 && series[j][key] < v; j--) {
      if (series[j][key] < lo) lo = series[j][key]
    }
    let hi = Infinity
    for (let j = b + 1; j < n && series[j][key] < v; j++) {
      if (series[j][key] < hi) hi = series[j][key]
    }
    const saddle = Math.max(lo, hi)
    if (saddle === Infinity) continue
    const prominence = v - saddle
    if (!(prominence > minProminence)) continue

    if (
      !best ||
      prominence > best.prominence ||
      (prominence === best.prominence && v > best.value)
    ) {
      best = {
        index: i,
        lag: (series[a].lag + series[b].lag) / 2,
        start: series[a].lag,
        end: series[b].lag,
        value: v,
        width,
        prominence,
      }
    }
  }
  return best
}
