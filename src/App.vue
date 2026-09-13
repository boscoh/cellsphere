<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Simulation } from './sim'
import { FIXED_DT, SIM_SPEED, resetParams, setParam } from './constants'
import { computeCellColor } from './cells'
import Tuner from './Tuner.vue'
import PopChart from './PopChart.vue'

const POP_SAMPLES = 1200
const canvasHolder = ref(null)
const tailsActive = ref(true)
const tunerRef = ref(null)
const simRate = ref(SIM_SPEED)
const frameMs = ref(0)
const bacteriaCount = ref(0)
const blueCount = ref(0)
const redCount = ref(0)
const foodCount = ref(0)
const popHistory = ref([])
const perf = ref({})
const perfExpanded = ref(true)
const MAX_SIM_RATE = 50
const MAX_BACKLOG = MAX_SIM_RATE * FIXED_DT
const dotBlue = '#' + computeCellColor(0).getHexString()
const dotRed = '#' + computeCellColor(1).getHexString()
const PERF_LABELS = {
  grid: 'grid (spatial hash)',
  cells: 'cells (move+steer)',
  collide: 'collide',
  eat: 'eat (food)',
  pred: 'pred (predation)',
  sense: 'sense (chemotaxis)',
  split: 'split (mitosis)',
  tail: 'tail (control)',
  vis: 'vis (cull)',
  bodies: 'bodies (render)',
  tails: 'tails (render)',
  draw: 'draw',
  pops: 'pops (bursts)',
}

let sim
let animationId
let lastTime = performance.now()
let accumulator = 0
let fpsCount = 0
let fpsTime = 0
let prevSample = null
const handleResize = () => sim.onResize()
const onKey = (e) => {
  if (e.key === 'Escape') tunerRef.value?.collapse()
}

function onReset() {
  resetParams()
  tunerRef.value?.syncValues()
  simRate.value = SIM_SPEED
  popHistory.value = []
  prevSample = null
  sim.reset()
}

function onRestart() {
  popHistory.value = []
  prevSample = null
  sim.reset()
}

// Effective Lotka-Volterra coefficients over the last sampling window, from
// cumulative sim event counters and mean populations:
//   dN/dt = alpha*N - beta*N*P,  dP/dt = delta*N*P - gamma*P
function estimateRates(sim, blue, red) {
  const ev = sim.events
  const out = { alpha: 0, beta: 0, gamma: 0, delta: 0 }
  if (prevSample) {
    const dt = sim.simTime - prevSample.t
    const nBar = (blue + prevSample.blue) / 2
    const pBar = (red + prevSample.red) / 2
    const preyBirths = ev.preyBirths - prevSample.events.preyBirths
    const predBirths = ev.predBirths - prevSample.events.predBirths
    const preyStarved = ev.preyStarved - prevSample.events.preyStarved
    const predStarved = ev.predStarved - prevSample.events.predStarved
    const predKills = ev.predKills - prevSample.events.predKills
    if (dt > 0 && nBar > 0) out.alpha = (preyBirths - preyStarved) / (nBar * dt)
    if (dt > 0 && pBar > 0) out.gamma = predStarved / (pBar * dt)
    if (dt > 0 && nBar > 0 && pBar > 0) {
      out.beta = predKills / (nBar * pBar * dt)
      out.delta = predBirths / (nBar * pBar * dt)
    }
  }
  prevSample = { t: sim.simTime, blue, red, events: { ...ev } }
  return out
}

function onParamChange(key, value) {
  if (key === 'SIM_SPEED') simRate.value = value
}

function onSpeed(event) {
  const v = Number(event.target.value)
  simRate.value = v
  setParam('SIM_SPEED', v)
}

onMounted(() => {
  sim = new Simulation()
  sim.attach(canvasHolder.value)
  sim.buildWorld()

  const tick = () => {
    animationId = requestAnimationFrame(tick)
    const now = performance.now()
    const rawDt = Math.min((now - lastTime) / 1000, 0.05)
    lastTime = now

    accumulator = Math.min(
      accumulator + rawDt * Math.min(simRate.value, MAX_SIM_RATE),
      MAX_BACKLOG,
    )
    if (accumulator > 0) {
      sim.step(accumulator)
      accumulator = 0
    }
    sim.render(tailsActive.value ? 1 : 0.0001, rawDt)

    fpsCount++
    fpsTime += rawDt
    if (fpsTime >= 0.5) {
      // perf.totals sums every phase over the whole window (and every substep),
      // so divide by the window's frame count to report per-frame ms on the same
      // basis as frameMs.
      const frames = Math.max(fpsCount, 1)
      frameMs.value = (fpsTime / frames) * 1000
      fpsCount = 0
      fpsTime = 0
      bacteriaCount.value = sim.cells.length
      let blue = 0
      let red = 0
      for (const c of sim.cells) {
        if (c.breed === 0) blue++
        else red++
      }
      blueCount.value = blue
      redCount.value = red
      const rates = estimateRates(sim, blue, red)
      popHistory.value.push({ t: sim.simTime, blue, red, ...rates })
      if (popHistory.value.length > POP_SAMPLES) popHistory.value.shift()
      foodCount.value = 0
      for (const f of sim.foods) if (f.visible) foodCount.value++
      perf.value = {}
      for (const name in sim.perf.totals) {
        perf.value[name] = sim.perf.totals[name] / frames
      }
      sim.perf.clear()
    }
  }
  tick()

  window.addEventListener('resize', handleResize)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('keydown', onKey)
  sim.dispose()
})
</script>

<template>
  <div ref="canvasHolder" class="canvas-holder"></div>
  <div class="hud">
    <span class="brand">CellSphere</span>
    <span class="sep"></span>
    <div class="cell">
      <span class="ctl">Cells</span>
      <div class="row">
        <span class="dot" :style="{ background: dotBlue }"></span><span class="num">{{ blueCount }}</span>
        <span class="dot" :style="{ background: dotRed }"></span><span class="num">{{ redCount }}</span>
      </div>
    </div>
    <div class="cell">
      <span class="ctl">Food</span>
      <div class="row"><span class="num">{{ foodCount }}</span></div>
    </div>
    <span class="sep"></span>
    <div class="cell">
      <label class="ctl" for="speed">Speed</label>
      <div class="row">
        <input
          id="speed"
          class="slider"
          type="range"
          min="1"
          :max="MAX_SIM_RATE"
          step="1"
          :value="simRate"
          @input="onSpeed"
        />
        <span class="readout">{{ simRate }}×</span>
      </div>
    </div>
    <div class="cell">
      <button
        type="button"
        class="toggle-btn"
        :class="{ active: tailsActive }"
        :aria-pressed="String(tailsActive)"
        title="Toggle tails"
        @click="tailsActive = !tailsActive"
      >
        Tails
      </button>
    </div>
    <div class="cell">
      <button type="button" class="reset-btn" aria-label="Restart" title="Restart" @click="onRestart">
        <svg
          class="icon"
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
      </button>
    </div>
  </div>
  <Tuner ref="tunerRef" @rebuild="onRestart" @default="onReset" @param="onParamChange" />
  <div class="bottom-left">
    <div class="perf-panel">
      <div class="perf-head">
        <button
          type="button"
          class="perf-toggle"
          :class="{ collapsed: !perfExpanded }"
          :aria-expanded="String(perfExpanded)"
          :title="perfExpanded ? 'Collapse perf' : 'Expand perf'"
          @click="perfExpanded = !perfExpanded"
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
        <span class="ctl">Perf ms</span>
      </div>
      <div v-show="perfExpanded" class="perfs">
        <span class="perf-name">frame</span>
        <span class="perf-val">{{ frameMs.toFixed(1) }}</span>
        <template v-for="(ms, name) in perf" :key="name">
          <span class="perf-name">{{ PERF_LABELS[name] || name }}</span>
          <span class="perf-val">{{ ms.toFixed(1) }}</span>
        </template>
      </div>
    </div>
    <PopChart :samples="popHistory" />
  </div>
  <div class="hint">drag to orbit · scroll to zoom</div>
</template>

<style scoped>
.canvas-holder {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.hud {
  position: fixed;
  top: 20px;
  left: 24px;
  z-index: 2;
  display: flex;
  align-items: stretch;
  gap: 14px;
  padding: 10px 14px;
  background: rgba(10, 12, 16, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 14px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  pointer-events: none;
  font-family: system-ui, sans-serif;
  user-select: none;
}

.brand {
  align-self: center;
  font-size: 15px;
  font-weight: 600;
  color: #eef2f8;
  letter-spacing: -0.3px;
}

.sep {
  width: 1px;
  align-self: stretch;
  background: rgba(255, 255, 255, 0.12);
}

.cell {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.cell .num {
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  line-height: 1;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin: 0 2px 0 4px;
}

.perf-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.perf-toggle {
  pointer-events: auto;
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

.perf-toggle:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.perf-toggle svg {
  transition: transform 0.15s ease;
}

.perf-toggle.collapsed svg {
  transform: rotate(180deg);
}

.perfs {
  display: grid;
  grid-template-columns: auto auto;
  gap: 1px 10px;
  font-variant-numeric: tabular-nums;
}

.perf-name,
.perf-val {
  font-size: 10px;
  color: #9aa6ba;
  line-height: 1.4;
  white-space: nowrap;
}

.perf-val {
  text-align: right;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
}

.ctl {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #6b7484;
  line-height: 1.2;
}

.slider {
  width: 110px;
  height: 20px;
  accent-color: #6fa8ff;
  cursor: pointer;
  pointer-events: auto;
}

.reset-btn {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
  color: #b7c2d4;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.reset-btn:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.reset-btn:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 2px;
}

.readout {
  min-width: 30px;
  text-align: left;
  color: #b7c2d4;
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.toggle-btn {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 0 10px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #6b7484;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.toggle-btn:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.toggle-btn.active {
  color: #eef2f8;
  background: rgba(111, 168, 255, 0.18);
  border-color: rgba(111, 168, 255, 0.45);
}

.toggle-btn:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 2px;
}

.bottom-left {
  position: fixed;
  left: 24px;
  bottom: 18px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  pointer-events: none;
}

.perf-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 14px;
  background: rgba(10, 12, 16, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  pointer-events: none;
  font-family: system-ui, sans-serif;
  user-select: none;
}

.hint {
  position: fixed;
  bottom: 18px;
  left: 0;
  right: 0;
  text-align: center;
  color: #5c6472;
  font-family: system-ui, sans-serif;
  font-size: 11px;
  letter-spacing: 0.2px;
  pointer-events: none;
  user-select: none;
}
</style>
