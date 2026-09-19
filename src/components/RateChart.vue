<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  scaleCanvas,
  fmtTime,
  drawAxes,
  drawYLabel,
  drawAxisMax,
} from './chartCanvas.js'
import { classifyRegime, createAcfTracker, broadMaximum } from './popChartMath.js'
import { lvPeriod } from './rateModel.js'
import { SAMPLE_DT } from '../constants.js'

const props = defineProps({
  // Latest knob-derived rates (for the textbook period).
  rates: { type: Object, default: null },
  popSamples: { type: Array, default: () => [] },
})

const canvasRef = ref(null)

const acfColor = '#4fa3ff'

const TONE_FILL = {
  good: 'rgba(80, 200, 120, 0.07)',
  warn: 'rgba(255, 179, 71, 0.06)',
  bad: 'rgba(255, 107, 107, 0.09)',
  muted: 'rgba(255, 255, 255, 0.02)',
}

const latestKnob = computed(() => props.rates)
const textbook = computed(() =>
  latestKnob.value ? lvPeriod(latestKnob.value.alpha, latestKnob.value.gamma) : null,
)
const guessLabel = computed(() =>
  textbook.value ? `textbook period: ${textbook.value.toFixed(0)} s` : '',
)

// The window is sized to span ~4x the textbook period, so the max lag is ~2x the
// textbook period: long enough for the expected peak to appear, since the ACF
// cannot see a period longer than half its snapshot. Clamped so a missing or
// absurd textbook estimate still gives a usable window.
const ACF_MIN_S = 600
const ACF_MAX_S = 1800
// Quantised to whole samples of a 128-sample (~64 s) grid: resizing the tracker
// rebuilds its lag sums, and a slider drag would otherwise trigger a ~O(n^2)
// rebuild on every step.
const ACF_STEP = 128
const acfSamples = computed(() => {
  const wanted = textbook.value ? 4 * textbook.value : ACF_MIN_S
  const secs = Math.max(ACF_MIN_S, Math.min(ACF_MAX_S, wanted))
  return Math.max(8, Math.round(secs / SAMPLE_DT / ACF_STEP) * ACF_STEP)
})

// The detrended autocorrelation is maintained incrementally, so it is current on
// every sample rather than refreshed every THROTTLE samples.
const tracker = createAcfTracker(acfSamples.value)
const acf = ref(null)
const heavy = ref([])
let consumed = 0

function refreshAcf() {
  const samples = props.popSamples
  if (samples.length < consumed) {
    tracker.reset()
    consumed = 0
  }
  for (let i = consumed; i < samples.length; i++) tracker.push(samples[i].t, samples[i].blue)
  consumed = samples.length
  heavy.value = samples.slice(-acfSamples.value)
  acf.value = tracker.series()
}

// A window resize keeps only the last `acfSamples` of history, so restart the
// tracker from that tail rather than replaying the whole run.
function rebuildAcf() {
  tracker.setSize(acfSamples.value)
  tracker.reset()
  consumed = Math.max(0, props.popSamples.length - acfSamples.value)
  refreshAcf()
}

watch(() => props.popSamples.length, refreshAcf, { immediate: true })
watch(acfSamples, rebuildAcf)
// A ripple in the ACF is not a cycle, so require the dome to clear r = 0.2.
const ACF_MIN_R = 0.2
const peak = computed(() => broadMaximum(acf.value, 'r', { minValue: ACF_MIN_R }))
const regime = computed(() => classifyRegime(heavy.value))
const secondaryLines = computed(() => {
  const pk = peak.value
  if (!pk) return ['no clear repeating period']
  return [
    `peak for period ${pk.lag.toFixed(0)} s at ${pk.value.toFixed(2)}`,
  ]
})

let ro

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
    ctx.arc(X(pk.lag), Y(pk.value), 2.4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const { ctx, w, h } = scaleCanvas(canvas)
  ctx.clearRect(0, 0, w, h)
  const pad = { l: 44, r: 12, t: 12, b: 16 }
  drawCycle(ctx, pad, w, h, acf.value)
}

watch(
  () => props.rates,
  () => draw(),
  { flush: 'post' },
)
watch(
  () => props.popSamples[props.popSamples.length - 1],
  () => draw(),
  { flush: 'post' },
)

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
      <span class="ctl">Cycles</span>
    </div>
    <canvas ref="canvasRef" class="rate-canvas"></canvas>
    <div
      class="rate-foot"
      title="Regime from the population trajectory."
    >
      <span class="badge" :class="regime.tone">{{ regime.label }}</span>
    </div>
    <div
      class="rate-foot stack"
      title="Textbook estimate (Lotka-Volterra 2π/√(αγ)) & Autocorrelation peak of the prey series, linearly detrended: the lag at which the population most resembles itself."
    >
      <span v-for="(line, i) in secondaryLines" :key="i" class="foot-line">{{ line }}</span>
      {{ guessLabel }}
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

.ctl {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #6b7484;
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
