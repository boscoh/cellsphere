<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  scaleCanvas,
  fmtTime,
  drawAxes,
  drawYLabel,
  drawAxisMax,
  AXIS_COLOR,
  LABEL_COLOR,
} from './chartCanvas.js'
import {
  classifyRegime,
  analyzeCycle,
  perCapitaRates,
  rateZeroCrossings,
  sliceWindow,
  autocorrelation,
  acfPeak,
} from './popChartMath.js'
import { lvPeriod } from './rateModel.js'

const props = defineProps({
  samples: { type: Array, default: () => [] },
  popSamples: { type: Array, default: () => [] },
})

const canvasRef = ref(null)
const expanded = ref(true)
const mode = ref('time')

const rNColor = '#4fa3ff'
const rPColor = '#ff6b6b'
const acfColor = '#4fa3ff'

const TONE_FILL = {
  good: 'rgba(80, 200, 120, 0.07)',
  warn: 'rgba(255, 179, 71, 0.06)',
  bad: 'rgba(255, 107, 107, 0.09)',
  muted: 'rgba(255, 255, 255, 0.02)',
}

const WIN_MIN = 120
const WIN_MAX = 600

const latestKnob = computed(() => props.samples[props.samples.length - 1])
const regime = computed(() => classifyRegime(props.popSamples))
const cycle = computed(() => analyzeCycle(props.popSamples, 'blue'))
const crossings = computed(() => (cycle.value ? cycle.value.crossings : []))
const rateCross = computed(() => rateZeroCrossings(props.popSamples))

// Sliding window: ~4 cycles when a period is known, else the whole buffer.
const acf = computed(() => autocorrelation(props.popSamples, 'blue'))
const peak = computed(() => acfPeak(acf.value))
const measuredT = computed(() => (peak.value ? peak.value.lag : null))

const span = computed(() => {
  const T = measuredT.value
  return Math.max(WIN_MIN, Math.min(WIN_MAX, T ? 4 * T : WIN_MAX))
})
// Rates are measured on the full history first, then sliced, so the stencil keeps
// its neighbours at the window edge.
const measured = computed(() => sliceWindow(perCapitaRates(props.popSamples), span.value))

const predicted = computed(() =>
  latestKnob.value ? lvPeriod(latestKnob.value.alpha, latestKnob.value.gamma) : null,
)
const guessLabel = computed(() =>
  predicted.value ? `textbook period: ${predicted.value.toFixed(0)} s` : '',
)
const secondaryLines = computed(() => {
  const pk = peak.value
  if (!pk) return ['no clear repeating period', 'autocorrelation stays low']
  return [
    `repeats about every ${pk.lag.toFixed(0)} s`,
    `correlation peak ${pk.r.toFixed(2)} (1 = perfect repeat)`,
  ]
})

let ro

function robustRange(values) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (!clean.length) return [-1, 1]
  clean.sort((a, b) => a - b)
  let lo = clean[Math.floor(clean.length * 0.02)]
  let hi = clean[Math.floor((clean.length - 1) * 0.98)]
  lo = Math.min(lo, 0)
  hi = Math.max(hi, 0)
  if (!(hi > lo)) hi = lo + 1
  const pad = (hi - lo) * 0.08
  return [lo - pad, hi + pad]
}

function fmtVal(v) {
  const a = Math.abs(v)
  if (a >= 100) return v.toFixed(0)
  if (a >= 1) return v.toFixed(1)
  if (a >= 0.01) return v.toFixed(2)
  return v.toExponential(1)
}

function regimeFill(ctx, pad, w, h) {
  ctx.fillStyle = TONE_FILL[regime.value.tone] || TONE_FILL.muted
  ctx.fillRect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b)
}

function label(ctx, text, x, y, color, align, baseline) {
  ctx.font = '8px system-ui, sans-serif'
  ctx.textAlign = align
  ctx.textBaseline = baseline
  ctx.lineWidth = 2.5
  ctx.strokeStyle = 'rgba(10, 12, 16, 0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

function caption(ctx, text, x, y) {
  ctx.font = '8px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const wd = ctx.measureText(text).width
  ctx.fillStyle = 'rgba(10, 12, 16, 0.78)'
  ctx.fillRect(x - 2, y - 1, wd + 4, 10)
  ctx.fillStyle = '#98a4b6'
  ctx.fillText(text, x, y)
}

function drawTime(ctx, pad, w, h, data) {
  const vals = []
  for (const d of data) vals.push(d.rN, d.rP)
  const [lo, hi] = robustRange(vals)
  const t0 = data[0].t
  const t1 = data[data.length - 1].t
  const pw = w - pad.l - pad.r
  const ph = h - pad.t - pad.b
  const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * pw
  const Y = (v) => pad.t + ph - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ph

  regimeFill(ctx, pad, w, h)

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  ctx.setLineDash([2, 3])
  for (const t of crossings.value) {
    if (t < t0 || t > t1) continue
    ctx.beginPath()
    ctx.moveTo(X(t), pad.t)
    ctx.lineTo(X(t), h - pad.b)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(pad.l, Y(0))
  ctx.lineTo(w - pad.r, Y(0))
  ctx.stroke()
  ctx.setLineDash([])

  drawAxes(ctx, pad, w, h, `time window (${Math.round(span.value)} s)`)
  drawYLabel(ctx, pad, h, 'growth rate 1/s')
  drawAxisMax(ctx, pad.l - 3, pad.t, fmtVal(hi), 'right', 'top')
  drawAxisMax(ctx, pad.l - 3, h - pad.b, fmtVal(lo), 'right', 'bottom')
  drawAxisMax(ctx, pad.l, h - 3, `${fmtTime(t0)} s`, 'left', 'bottom')
  drawAxisMax(ctx, w - pad.r, h - 3, `${fmtTime(t1)} s`, 'right', 'bottom')

  for (const [key, color] of [['rN', rNColor], ['rP', rPColor]]) {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < data.length; i++) {
      const y = Y(data[i][key])
      if (i === 0) ctx.moveTo(X(data[i].t), y)
      else ctx.lineTo(X(data[i].t), y)
    }
    ctx.stroke()
  }

  const cross = rateCross.value
  for (const [list, color] of [
    [cross.rN, rNColor],
    [cross.rP, rPColor],
  ]) {
    ctx.fillStyle = color
    for (const c of list) {
      if (c.t < t0 || c.t > t1) continue
      ctx.beginPath()
      ctx.arc(X(c.t), Y(0), 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const yN = Math.max(pad.t + 4, Math.min(h - pad.b - 4, Y(data[data.length - 1].rN)))
  const yP = Math.max(pad.t + 4, Math.min(h - pad.b - 4, Y(data[data.length - 1].rP)))
  label(ctx, 'prey', w - pad.r + 3, yN, rNColor, 'left', 'middle')
  label(ctx, 'predators', w - pad.r + 3, yP, rPColor, 'left', 'middle')
  label(ctx, 'rising', w - pad.r + 3, Y(0) - 2, LABEL_COLOR, 'left', 'bottom')
  label(ctx, 'falling', w - pad.r + 3, Y(0) + 2, LABEL_COLOR, 'left', 'top')
}

function drawCycle(ctx, pad, w, h, series) {
  regimeFill(ctx, pad, w, h)
  if (!series || series.length < 3) {
    caption(ctx, 'not enough history yet', pad.l + 3, h - pad.b - 10)
    return
  }
  const maxLag = series[series.length - 1].lag
  let lo = 0
  for (const p of series) if (p.r < lo) lo = p.r
  const hi = 1
  const pw = w - pad.l - pad.r
  const ph = h - pad.t - pad.b
  const X = (lag) => pad.l + (lag / (maxLag || 1)) * pw
  const Y = (r) => pad.t + ph - ((Math.max(lo, Math.min(hi, r)) - lo) / (hi - lo)) * ph

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  ctx.setLineDash([2, 3])
  ctx.beginPath()
  ctx.moveTo(pad.l, Y(0))
  ctx.lineTo(w - pad.r, Y(0))
  ctx.stroke()
  ctx.setLineDash([])

  drawAxes(ctx, pad, w, h, 'lag')
  drawYLabel(ctx, pad, h, 'correlation')
  drawAxisMax(ctx, pad.l - 3, pad.t, '1', 'right', 'top')
  drawAxisMax(ctx, pad.l - 3, h - pad.b, fmtVal(lo), 'right', 'bottom')
  drawAxisMax(ctx, pad.l, h - 3, '0 s', 'left', 'bottom')
  drawAxisMax(ctx, w - pad.r, h - 3, `${fmtTime(maxLag)} s`, 'right', 'bottom')

  ctx.strokeStyle = acfColor
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i < series.length; i++) {
    const x = X(series[i].lag)
    const y = Y(series[i].r)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  const pk = peak.value
  if (pk) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(X(pk.lag), pad.t)
    ctx.lineTo(X(pk.lag), h - pad.b)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = acfColor
    ctx.beginPath()
    ctx.arc(X(pk.lag), Y(pk.r), 2.4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const { ctx, w, h } = scaleCanvas(canvas)
  ctx.clearRect(0, 0, w, h)
  const pad = { l: 40, r: 52, t: 12, b: 16 }
  if (mode.value === 'cycle') drawCycle(ctx, pad, w, h, acf.value)
  else if (measured.value.length >= 2) drawTime(ctx, pad, w, h, measured.value)
}

watch(
  () => props.samples[props.samples.length - 1],
  () => draw(),
  { flush: 'post' },
)
watch(
  () => props.popSamples[props.popSamples.length - 1],
  () => draw(),
  { flush: 'post' },
)
watch([mode, expanded], () => draw(), { flush: 'post' })

onMounted(() => {
  ro = new ResizeObserver(() => draw())
  ro.observe(canvasRef.value)
  draw()
})

onBeforeUnmount(() => {
  if (ro) ro.disconnect()
})
</script>

<template>
  <div class="rate-panel">
    <div class="rate-head">
      <button
        type="button"
        class="expand-btn"
        :class="{ collapsed: !expanded }"
        :aria-expanded="String(expanded)"
        :title="expanded ? 'Collapse graph' : 'Expand graph'"
        @click="expanded = !expanded"
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <span class="ctl">Rates</span>
      <div class="mode-toggle">
        <button
          type="button"
          class="mode-btn"
          :class="{ active: mode === 'time' }"
          title="Measured per-capita growth rates over the sliding window"
          @click="mode = 'time'"
        >
          growth rate
        </button>
        <button
          type="button"
          class="mode-btn"
          :class="{ active: mode === 'cycle' }"
          title="Autocorrelation of the prey series: a peak means a real repeating period"
          @click="mode = 'cycle'"
        >
          cycle
        </button>
      </div>
    </div>
    <canvas v-show="expanded" ref="canvasRef" class="rate-canvas"></canvas>
    <div
      v-show="expanded"
      class="rate-foot"
      title="Regime from the population trajectory."
    >
      <span class="badge" :class="regime.tone">{{ regime.label }}</span>
    </div>
    <div
      v-show="expanded && mode === 'cycle' && guessLabel"
      class="rate-foot muted"
      title="Textbook estimate (Lotka-Volterra 2π/√(αγ)) from the slider-implied rates — rough and uncalibrated, not measured from the run."
    >
      {{ guessLabel }}
    </div>
    <div
      v-show="expanded && mode === 'cycle'"
      class="rate-foot muted stack"
      title="Autocorrelation peak of the prey series, linearly detrended: the lag at which the population most resembles itself."
    >
      <span v-for="(line, i) in secondaryLines" :key="i" class="foot-line">{{ line }}</span>
    </div>
  </div>
</template>

<style scoped>
.rate-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  background: rgba(10, 12, 16, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  font-family: system-ui, sans-serif;
  user-select: none;
  pointer-events: auto;
}

.rate-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.expand-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 18px;
  padding: 0;
  color: #9aa6ba;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.expand-btn:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.expand-btn svg {
  transition: transform 0.15s ease;
}

.expand-btn.collapsed svg {
  transform: rotate(180deg);
}

.ctl {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #6b7484;
}

.mode-toggle {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.mode-btn {
  padding: 2px 6px;
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.3px;
  color: #9aa6ba;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.mode-btn:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.mode-btn.active {
  color: #eef2f8;
  background: rgba(120, 160, 255, 0.22);
  border-color: rgba(120, 160, 255, 0.45);
}

.rate-canvas {
  display: block;
  width: 250px;
  height: 130px;
}

.rate-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  color: #6b7484;
  white-space: nowrap;
  min-height: 11px;
}

.rate-foot.muted {
  color: #556072;
}

.rate-foot.muted {
  color: #556072;
}

.rate-foot.stack {
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  white-space: normal;
}

.foot-line {
  white-space: nowrap;
}

.badge {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  letter-spacing: 0.2px;
  text-transform: uppercase;
}

.badge.good {
  color: #b6f2c4;
  background: rgba(80, 200, 120, 0.18);
  border: 1px solid rgba(80, 200, 120, 0.4);
}

.badge.warn {
  color: #ffd9a0;
  background: rgba(255, 179, 71, 0.16);
  border: 1px solid rgba(255, 179, 71, 0.4);
}

.badge.bad {
  color: #ffb3b3;
  background: rgba(255, 107, 107, 0.16);
  border: 1px solid rgba(255, 107, 107, 0.4);
}

.badge.muted {
  color: #9aa6ba;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
}
</style>
