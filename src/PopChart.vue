<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { computeCellColor } from './cells'

const props = defineProps({
  samples: { type: Array, default: () => [] },
})

const canvasRef = ref(null)
const mode = ref('phase')
const blueColor = '#' + computeCellColor(0).getHexString()
const redColor = '#' + computeCellColor(1).getHexString()
const axisColor = 'rgba(255, 255, 255, 0.12)'
const labelColor = '#6b7484'
const rateSeries = [
  { key: 'alpha', label: 'α', color: '#6fd08c' },
  { key: 'beta', label: 'β', color: '#ff9a5c' },
  { key: 'gamma', label: 'γ', color: '#ff6f8c' },
  { key: 'delta', label: 'δ', color: '#f2d35e' },
]

let ro

function scaleCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w, h }
}

function maxOf(samples, key) {
  let m = 1
  for (let i = 0; i < samples.length; i++) if (samples[i][key] > m) m = samples[i][key]
  return m
}

function maxAbsOf(samples, key) {
  let m = 1e-9
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i][key])
    if (a > m) m = a
  }
  return m
}

function fmtRate(v) {
  if (!isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 0.01) return v.toFixed(3)
  if (a >= 0.0001) return v.toFixed(4)
  return v.toExponential(1)
}

function fmtTime(t) {
  if (!isFinite(t)) return '—'
  return Math.abs(t) >= 10 ? t.toFixed(0) : t.toFixed(1)
}

function drawAxisMax(ctx, x, y, text, align, baseline) {
  ctx.fillStyle = labelColor
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = align
  ctx.textBaseline = baseline
  ctx.fillText(text, x, y)
}

function drawYLabel(ctx, pad, h, text) {
  ctx.save()
  ctx.fillStyle = labelColor
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.translate(pad.l - 3, h - pad.b)
  ctx.rotate(-Math.PI / 2)
  const tw = ctx.measureText(text).width
  ctx.fillText(text, 0, 0)
  const ay = -4.5
  const ax = tw + 3
  ctx.strokeStyle = labelColor
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(ax + 5, ay)
  ctx.moveTo(ax + 2.5, ay - 2.5)
  ctx.lineTo(ax + 5, ay)
  ctx.lineTo(ax + 2.5, ay + 2.5)
  ctx.stroke()
  ctx.restore()
}

function drawAxes(ctx, pad, w, h, xLabel) {
  ctx.strokeStyle = axisColor
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad.l, pad.t)
  ctx.lineTo(pad.l, h - pad.b)
  ctx.lineTo(w - pad.r, h - pad.b)
  ctx.stroke()
  ctx.fillStyle = labelColor
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillText(xLabel, pad.l + 1, h - 3)
}

function drawTime(ctx, pad, w, h, samples) {
  const t0 = samples[0].t
  const t1 = samples[samples.length - 1].t
  const maxC = Math.max(maxOf(samples, 'blue'), maxOf(samples, 'red'))
  const pw = w - pad.l - pad.r
  const ph = h - pad.t - pad.b
  const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * pw
  const Y = (c) => pad.t + ph - (c / maxC) * ph

  drawAxes(ctx, pad, w, h, 'time →')
  drawYLabel(ctx, pad, h, 'count')
  drawAxisMax(ctx, pad.l - 3, pad.t, String(maxC), 'right', 'top')
  drawAxisMax(ctx, w - pad.r, h - 3, fmtTime(t1), 'right', 'bottom')

  for (const [key, color] of [['blue', blueColor], ['red', redColor]]) {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < samples.length; i++) {
      const x = X(samples[i].t)
      const y = Y(samples[i][key])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

function drawPhase(ctx, pad, w, h, samples) {
  const maxB = maxOf(samples, 'blue')
  const maxR = maxOf(samples, 'red')
  const max = Math.max(maxB, maxR)
  const pw = w - pad.l - pad.r
  const ph = h - pad.t - pad.b
  const X = (b) => pad.l + (b / max) * pw
  const Y = (r) => pad.t + ph - (r / max) * ph

  ctx.strokeStyle = axisColor
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad.l, h - pad.b)
  ctx.lineTo(w - pad.r, h - pad.b)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(pad.l, pad.t)
  ctx.lineTo(pad.l, h - pad.b)
  ctx.stroke()
  drawYLabel(ctx, pad, h, 'pred')
  drawAxisMax(ctx, pad.l - 3, pad.t, String(max), 'right', 'top')
  drawAxisMax(ctx, w - pad.r, h - 3, String(max), 'right', 'bottom')
  ctx.fillStyle = labelColor
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillText('prey →', pad.l + 1, h - 3)

  const n = samples.length
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const alpha = 0.25 + 0.75 * (i / n)
    ctx.strokeStyle = `rgba(111, 168, 255, ${alpha})`
    ctx.beginPath()
    ctx.moveTo(X(a.blue), Y(a.red))
    ctx.lineTo(X(b.blue), Y(b.red))
    ctx.stroke()
  }

  const last = samples[n - 1]
  ctx.fillStyle = blueColor
  ctx.beginPath()
  ctx.arc(X(last.blue), Y(last.red), 2.5, 0, Math.PI * 2)
  ctx.fill()
}

function drawRates(ctx, pad, w, h, samples) {
  const top = pad.t + 12
  const pw = w - pad.l - pad.r
  const ph = h - top - pad.b
  const mid = top + ph / 2
  const t0 = samples[0].t
  const t1 = samples[samples.length - 1].t
  const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * pw
  // Each coefficient is scaled to its own peak so their shapes are comparable
  // on one plot; the numeric legend carries the true magnitudes.
  const maxes = {}
  for (const s of rateSeries) maxes[s.key] = maxAbsOf(samples, s.key)

  ctx.strokeStyle = axisColor
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad.l, mid)
  ctx.lineTo(w - pad.r, mid)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(pad.l, top)
  ctx.lineTo(pad.l, h - pad.b)
  ctx.stroke()

  drawYLabel(ctx, pad, h, 'rate')
  drawAxisMax(ctx, pad.l - 3, pad.t, '1', 'right', 'top')
  drawAxisMax(ctx, w - pad.r, h - 3, fmtTime(t1), 'right', 'bottom')

  for (const s of rateSeries) {
    const m = maxes[s.key]
    ctx.strokeStyle = s.color
    ctx.lineWidth = 1.3
    ctx.beginPath()
    for (let i = 0; i < samples.length; i++) {
      const x = X(samples[i].t)
      const y = mid - (samples[i][s.key] / m) * (ph / 2)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  const last = samples[samples.length - 1]
  ctx.font = '9px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  const colW = pw / rateSeries.length
  rateSeries.forEach((s, i) => {
    ctx.fillStyle = s.color
    ctx.fillText(`${s.label} ${fmtRate(last[s.key])}`, pad.l + 2 + i * colW, pad.t)
  })
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const { ctx, w, h } = scaleCanvas(canvas)
  ctx.clearRect(0, 0, w, h)
  const samples = props.samples
  if (samples.length < 2) return
  const pad = { l: 30, r: 10, t: 12, b: 16 }
  if (mode.value === 'rates') drawRates(ctx, pad, w, h, samples)
  else if (mode.value === 'time') drawTime(ctx, pad, w, h, samples)
  else drawPhase(ctx, pad, w, h, samples)
}

watch(
  () => props.samples[props.samples.length - 1],
  () => draw(),
  { flush: 'post' },
)
watch(mode, () => draw(), { flush: 'post' })

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
      <span class="ctl">Graph</span>
      <div class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ active: mode === 'phase' }"
          @click="mode = 'phase'"
        >
          Phase
        </button>
        <button
          type="button"
          class="tab"
          :class="{ active: mode === 'time' }"
          @click="mode = 'time'"
        >
          Time
        </button>
        <button
          type="button"
          class="tab"
          :class="{ active: mode === 'rates' }"
          @click="mode = 'rates'"
        >
          Rates
        </button>
      </div>
    </div>
    <canvas ref="canvasRef" class="pop-canvas"></canvas>
  </div>
</template>

<style scoped>
.pop-panel {
  position: fixed;
  left: 24px;
  bottom: 18px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 6px;
  background: rgba(10, 12, 16, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  font-family: system-ui, sans-serif;
  user-select: none;
}

.pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ctl {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #6b7484;
}

.tabs {
  display: flex;
  gap: 4px;
}

.tab {
  padding: 2px 7px;
  font-size: 10px;
  color: #9aa6ba;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.tab:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.tab.active {
  color: #eef2f8;
  background: rgba(111, 168, 255, 0.18);
  border-color: rgba(111, 168, 255, 0.45);
}

.pop-canvas {
  display: block;
  width: 210px;
  height: 130px;
}
</style>
