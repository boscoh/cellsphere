<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, toRaw } from 'vue'
import { computeCellColor } from '../cells.js'
import { scaleCanvas, fmtTime, drawAxes, drawYLabel, drawAxisMax } from './chartCanvas.js'

const props = defineProps({
  samples: { type: Array, default: () => [] },
  rates: { type: Object, default: null },
  foodCount: { type: Number, default: 0 },
})

const canvasRef = ref(null)
const greenColor = '#' + computeCellColor(0).getHexString()
const redColor = '#' + computeCellColor(1).getHexString()

const huntLabel = computed(() => (props.rates ? props.rates.attack.toFixed(2) : '—'))

let ro

function maxOf(samples, key) {
  let m = 1
  for (let i = 0; i < samples.length; i++) if (samples[i][key] > m) m = samples[i][key]
  return m
}

function drawTime(ctx, pad, w, h, samples) {
  const t0 = samples[0].t
  const t1 = samples[samples.length - 1].t
  const maxC = Math.max(maxOf(samples, 'green'), maxOf(samples, 'red'))
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
  for (const [key, color] of [['green', greenColor], ['red', redColor]]) {
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

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const { ctx, w, h } = scaleCanvas(canvas)
  ctx.clearRect(0, 0, w, h)
  // The whole run is scanned for the axis maximum on every draw, so it is read
  // raw: the samples are plain data, and going through the reactive array here
  // would cost a proxy trap per sample per frame.
  const samples = toRaw(props.samples)
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
      <span class="ctl">Population</span>
    </div>
    <canvas ref="canvasRef" class="pop-canvas"></canvas>
    <div class="pop-foot">
      <span class="stat">food {{ foodCount }}</span>
      <span
        class="pop-hunt"
        title="Ratio-dependent hunting strength: how hard each predator hunts at the current prey-per-predator ratio (PRED_RATIO)"
      >
        hunting effort {{ huntLabel }}
      </span>
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

.ctl {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #6b7484;
}

.pop-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  color: #9aa6ba;
  font-variant-numeric: tabular-nums;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.pop-canvas {
  display: block;
  width: 250px;
  height: 130px;
}
.pop-hunt {
  white-space: nowrap;
}
</style>
