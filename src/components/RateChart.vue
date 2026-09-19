<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  scaleCanvas,
  fmtTime,
  drawAxes,
  drawYLabel,
  drawAxisMax,
} from './chartCanvas.js'
import { classifyRegime, autocorrelation, acfPeak } from './popChartMath.js'
import { lvPeriod } from './rateModel.js'
import { SAMPLE_DT } from '../constants.js'

const props = defineProps({
  // Latest knob-derived rates (for the textbook period).
  rates: { type: Object, default: null },
  popSamples: { type: Array, default: () => [] },
})

const canvasRef = ref(null)
const expanded = ref(true)

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

// The ACF cannot see a period longer than half its snapshot, so size the snapshot
// to span ~4x the textbook period: the max lag is then ~2x the textbook period,
// i.e. long enough for the expected peak to appear with margin. Clamped so a
// missing or absurd textbook estimate still gives a usable window and bounds the
// O(n^2) cost.
const ACF_MIN_S = 600
const ACF_MAX_S = 1800
const acfSamples = computed(() => {
  const wanted = textbook.value ? 4 * textbook.value : ACF_MIN_S
  const secs = Math.max(ACF_MIN_S, Math.min(ACF_MAX_S, wanted))
  return Math.max(8, Math.round(secs / SAMPLE_DT))
})

// The autocorrelation is O(n^2), so it runs from a snapshot refreshed every
// THROTTLE samples (~8 s of sim time) rather than on every sample; a period
// estimate varies slowly, so this is not visible.
const THROTTLE = 16
const heavy = ref([])
let lastHeavyLen = -1
function refreshHeavy() {
  lastHeavyLen = props.popSamples.length
  heavy.value = props.popSamples.slice(-acfSamples.value)
}
watch(
  () => props.popSamples.length,
  (n) => {
    if (lastHeavyLen < 0 || n - lastHeavyLen >= THROTTLE || n < lastHeavyLen) refreshHeavy()
  },
  { immediate: true },
)
watch(acfSamples, () => refreshHeavy())
const acf = computed(() => autocorrelation(heavy.value, 'blue'))
const peak = computed(() => acfPeak(acf.value))
const regime = computed(() => classifyRegime(heavy.value))
const secondaryLines = computed(() => {
  const pk = peak.value
  if (!pk) return ['no clear repeating period', 'autocorrelation stays low']
  return [
    `repeats about every ${pk.lag.toFixed(0)} s`,
    `correlation peak ${pk.r.toFixed(2)} (1 = perfect repeat)`,
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
    ctx.arc(X(pk.lag), Y(pk.r), 2.4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function draw() {
  if (!expanded.value) return
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
watch(expanded, () => draw(), { flush: 'post' })

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
      <span class="ctl">Autocorrelation</span>
    </div>
    <canvas v-show="expanded" ref="canvasRef" class="rate-canvas"></canvas>
    <div
      v-if="expanded"
      class="rate-foot"
      title="Regime from the population trajectory."
    >
      <span class="badge" :class="regime.tone">{{ regime.label }}</span>
    </div>
    <div
      v-if="expanded && guessLabel"
      class="rate-foot muted"
      title="Textbook estimate (Lotka-Volterra 2π/√(αγ)) from the slider-implied rates — rough and uncalibrated, not measured from the run."
    >
      {{ guessLabel }}
    </div>
    <div
      v-if="expanded"
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
