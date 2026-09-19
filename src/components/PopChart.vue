<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { computeCellColor } from '../cells.js'
import { POP_SAMPLES } from '../constants.js'
import { fitRatePlane } from './popChartMath.js'
import { scaleCanvas, fmtTime, drawAxes, drawYLabel, drawAxisMax } from './chartCanvas.js'

const props = defineProps({
  samples: { type: Array, default: () => [] },
  rates: { type: Object, default: null },
})

const canvasRef = ref(null)
const expanded = ref(true)
const mode = ref('time')
const blueColor = '#' + computeCellColor(0).getHexString()
const redColor = '#' + computeCellColor(1).getHexString()
const redRgb = colorRgb(computeCellColor(1))
const blueRgb = colorRgb(computeCellColor(0))

const analysis = computed(() => {
  const s = props.samples
  return s.length > POP_SAMPLES ? s.slice(s.length - POP_SAMPLES) : s
})
const nulls = computed(() => {
  const f = fitRatePlane(analysis.value)
  return { prey: f.preyNull, pred: f.predNull }
})
const huntLabel = computed(() => (props.rates ? props.rates.attack.toFixed(2) : '—'))

function colorRgb(c) {
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]
}

function rgba(rgb, a) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`
}

let ro

function maxOf(samples, key) {
  let m = 1
  for (let i = 0; i < samples.length; i++) if (samples[i][key] > m) m = samples[i][key]
  return m
}

function drawTime(ctx, pad, w, h, samples) {
  const t0 = samples[0].t
  const t1 = samples[samples.length - 1].t
  const maxC = Math.max(maxOf(samples, 'blue'), maxOf(samples, 'red'))
  const pw = w - pad.l - pad.r
  const ph = h - pad.t - pad.b
  const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * pw
  const Y = (c) => pad.t + ph - (c / maxC) * ph

  drawAxes(ctx, pad, w, h, 'time')
  drawYLabel(ctx, pad, h, 'count')
  drawAxisMax(ctx, pad.l - 3, pad.t, String(maxC), 'right', 'top')
  drawAxisMax(ctx, pad.l - 3, h - pad.b, '0', 'right', 'bottom')
  drawAxisMax(ctx, pad.l, h - 3, `${fmtTime(t0)} s`, 'left', 'bottom')
  drawAxisMax(ctx, w - pad.r, h - 3, `${fmtTime(t1)} s`, 'right', 'bottom')

  const n = samples.length
  const step = Math.max(1, Math.floor(n / 1200))
  for (const [key, color] of [['blue', blueColor], ['red', redColor]]) {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < n; i += step) {
      const x = X(samples[i].t)
      const y = Y(samples[i][key])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    if ((n - 1) % step !== 0) {
      ctx.lineTo(X(samples[n - 1].t), Y(samples[n - 1][key]))
    }
    ctx.stroke()
  }
}

function drawPhase(ctx, pad, w, h, samples) {
  const maxB = maxOf(samples, 'blue')
  const maxR = maxOf(samples, 'red')
  const pw = w - pad.l - pad.r
  const ph = h - pad.t - pad.b
  const X = (b) => pad.l + (b / maxB) * pw
  const Y = (r) => pad.t + ph - (r / maxR) * ph

  drawAxes(ctx, pad, w, h, 'prey (blue)')
  drawYLabel(ctx, pad, h, 'predators')
  drawAxisMax(ctx, pad.l - 3, pad.t, String(maxR), 'right', 'top')
  drawAxisMax(ctx, pad.l - 3, h - pad.b, '0', 'right', 'bottom')
  drawAxisMax(ctx, pad.l, h - 3, '0', 'left', 'bottom')
  drawAxisMax(ctx, w - pad.r, h - 3, String(maxB), 'right', 'bottom')

  // Fading trail: the cycle's direction of travel is blue->bright. Subsample so
  // long histories stay cheap to draw.
  const n = samples.length
  const step = Math.max(1, Math.floor(n / 500))
  ctx.lineWidth = 1.5
  for (let i = step; i < n; i += step) {
    const a = i / n
    ctx.strokeStyle = rgba(redRgb, 0.06 + 0.7 * a)
    ctx.beginPath()
    ctx.moveTo(X(samples[i - step].blue), Y(samples[i - step].red))
    ctx.lineTo(X(samples[i].blue), Y(samples[i].red))
    ctx.stroke()
  }

  const last = samples[n - 1]
  ctx.fillStyle = rgba(blueRgb, 1)
  ctx.beginPath()
  ctx.arc(X(last.blue), Y(last.red), 2.5, 0, Math.PI * 2)
  ctx.fill()

  // Empirical cycle center (mean of the window) — the loop should encircle it.
  let sb = 0
  let sr = 0
  for (const s of samples) {
    sb += s.blue
    sr += s.red
  }
  const cb = X(sb / n)
  const cr = Y(sr / n)
  ctx.strokeStyle = rgba(blueRgb, 0.85)
  ctx.setLineDash([2, 2])
  ctx.beginPath()
  ctx.moveTo(cb - 4, cr)
  ctx.lineTo(cb + 4, cr)
  ctx.moveTo(cb, cr - 4)
  ctx.lineTo(cb, cr + 4)
  ctx.stroke()
  ctx.setLineDash([])

  // Fitted nullclines: where each species' per-capita growth is zero. A cycle is
  // a loop around their intersection, so this is the cycle test in state space.
  const nc = nulls.value
  const okPrey = nc.prey !== null && nc.prey > 0 && nc.prey <= maxR
  const okPred = nc.pred !== null && nc.pred > 0 && nc.pred <= maxB
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.setLineDash([3, 3])
  if (okPrey) {
    ctx.beginPath()
    ctx.moveTo(pad.l, Y(nc.prey))
    ctx.lineTo(w - pad.r, Y(nc.prey))
    ctx.stroke()
    drawAxisMax(ctx, w - pad.r, Y(nc.prey) - 2, 'prey steady', 'right', 'bottom')
  }
  if (okPred) {
    ctx.beginPath()
    ctx.moveTo(X(nc.pred), pad.t)
    ctx.lineTo(X(nc.pred), h - pad.b)
    ctx.stroke()
    drawAxisMax(ctx, X(nc.pred) + 2, pad.t + 8, 'predators steady', 'left', 'top')
  }
  ctx.setLineDash([])
  if (okPrey && okPred) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.beginPath()
    ctx.arc(X(nc.pred), Y(nc.prey), 3, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function draw() {
  if (!expanded.value) return
  const canvas = canvasRef.value
  if (!canvas) return
  const { ctx, w, h } = scaleCanvas(canvas)
  ctx.clearRect(0, 0, w, h)
  const samples = props.samples
  if (samples.length < 2) return
  const pad = { l: 30, r: 10, t: 12, b: 16 }
  if (mode.value === 'phase') drawPhase(ctx, pad, w, h, samples)
  else drawTime(ctx, pad, w, h, samples)
}

watch(
  () => props.samples[props.samples.length - 1],
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
  <div class="pop-panel">
    <div class="pop-head">
      <button
        type="button"
        class="expand-btn"
        :class="{ collapsed: !expanded }"
        :aria-expanded="String(expanded)"
        :title="expanded ? 'Collapse population chart' : 'Expand population chart'"
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
      <span class="ctl">Population</span>
      <div class="mode-toggle">
        <button
          type="button"
          class="mode-btn"
          :class="{ active: mode === 'time' }"
          @click="mode = 'time'"
        >
          Time
        </button>
        <button
          type="button"
          class="mode-btn"
          :class="{ active: mode === 'phase' }"
          @click="mode = 'phase'"
        >
          Phase
        </button>
      </div>
    </div>
    <canvas v-show="expanded" ref="canvasRef" class="pop-canvas"></canvas>
    <div
      v-if="expanded"
      class="pop-hunt"
      title="Ratio-dependent hunting strength: how hard each predator hunts at the current prey-per-predator ratio (PRED_RATIO)"
    >
      hunting effort {{ huntLabel }}
    </div>
  </div>
</template>

<style scoped>
.pop-panel {
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

.pop-head {
  display: flex;
  align-items: center;
  justify-content: flex-start;
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

.pop-canvas {
  display: block;
  width: 250px;
  height: 130px;
}

.pop-hunt {
  font-size: 9px;
  color: #556072;
  white-space: nowrap;
}
</style>
