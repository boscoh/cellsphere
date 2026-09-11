<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { computeCellColor } from './cells'

const props = defineProps({
  samples: { type: Array, default: () => [] },
})

const canvasRef = ref(null)
const expanded = ref(true)
const blueColor = '#' + computeCellColor(0).getHexString()
const redColor = '#' + computeCellColor(1).getHexString()
const axisColor = 'rgba(255, 255, 255, 0.12)'
const labelColor = '#6b7484'

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

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const { ctx, w, h } = scaleCanvas(canvas)
  ctx.clearRect(0, 0, w, h)
  const samples = props.samples
  if (samples.length < 2) return
  const pad = { l: 30, r: 10, t: 12, b: 16 }
  drawTime(ctx, pad, w, h, samples)
}

watch(
  () => props.samples[props.samples.length - 1],
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
  <div class="pop-panel">
    <div class="pop-head">
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
      <span class="ctl">Graph</span>
    </div>
    <canvas v-show="expanded" ref="canvasRef" class="pop-canvas"></canvas>
  </div>
</template>

<style scoped>
.pop-panel {
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

.pop-canvas {
  display: block;
  width: 250px;
  height: 130px;
}
</style>
