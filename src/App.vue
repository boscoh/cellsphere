<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Simulation } from './sim'
import { FIXED_DT } from './constants'
import Tuner from './Tuner.vue'

const canvasHolder = ref(null)
const tailsActive = ref(true)
const tunerOpen = ref(false)
const simRate = ref(1)
const fps = ref(0)
const bacteriaCount = ref(0)
const foodCount = ref(0)
const MAX_SIM_RATE = 10
const MAX_BACKLOG = MAX_SIM_RATE * FIXED_DT

let sim
let animationId
let lastTime = performance.now()
let accumulator = 0
let fpsCount = 0
let fpsTime = 0
const handleResize = () => sim.onResize()
const onKey = (e) => {
  if (e.key === 'Escape') {
    tunerOpen.value = false
    return
  }
  if (e.metaKey || e.ctrlKey || sim == null) return
  const o = sim.renderOptions
  const key = e.key.toLowerCase()
  const set = (k) => {
    o[k] = !o[k]
    console.log(k, '=', o[k], JSON.stringify(o))
  }
  if (key === 's') set('drawShell')
  else if (key === 'o') set('forceOpaqueBodies')
  else if (key === 't') set('drawTails')
  else if (key === 'c') set('cull')
  else if (key === 'b') set('drawBodies')
  else if (key === 'f') set('drawFood')
}

onMounted(() => {
  sim = new Simulation()
  sim.attach(canvasHolder.value)
  sim.buildWorld()
  window.sim = sim
  console.log('render debug keys — s:shell  o:opaqueBodies  t:tails  c:cull  b:bodies  f:food')

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
    sim.render(tailsActive.value ? 1 : 0.0001)

    fpsCount++
    fpsTime += rawDt
    if (fpsTime >= 0.5) {
      fps.value = Math.round(fpsCount / fpsTime)
      fpsCount = 0
      fpsTime = 0
      bacteriaCount.value = sim.cells.length
      foodCount.value = 0
      for (const f of sim.foods) if (f.visible) foodCount.value++
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
    <span class="brand">Cell</span>
    <span class="sep"></span>
    <div class="cell">
      <span class="ctl">Fps</span>
      <div class="row"><span class="num">{{ fps }}</span></div>
    </div>
    <div class="cell">
      <span class="ctl">Cell</span>
      <div class="row"><span class="num">{{ bacteriaCount }}</span></div>
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
          step="2"
          v-model.number="simRate"
        />
        <span class="readout">{{ simRate }}×</span>
      </div>
    </div>
    <div class="cell">
      <span class="ctl">Tails</span>
      <div class="row">
        <input
          type="checkbox"
          class="checkbox"
          :checked="tailsActive"
          aria-label="Tails"
          @change="tailsActive = $event.target.checked"
        />
      </div>
    </div>
    <span class="sep"></span>
    <div class="cell">
      <span class="ctl">Tuner</span>
      <div class="row">
        <button
          type="button"
          id="tune-toggle"
          class="tune-btn"
          :class="{ active: tunerOpen }"
          :aria-expanded="String(tunerOpen)"
          aria-controls="tuner-panel"
          aria-label="Open or close the parameter tuner"
          :title="tunerOpen ? 'Close parameter tuner' : 'Open parameter tuner'"
          @click="tunerOpen = !tunerOpen"
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <line x1="21" y1="4" x2="14" y2="4" />
            <line x1="10" y1="4" x2="3" y2="4" />
            <line x1="14" y1="2" x2="14" y2="6" />
            <line x1="21" y1="12" x2="12" y2="12" />
            <line x1="8" y1="12" x2="3" y2="12" />
            <line x1="12" y1="10" x2="12" y2="14" />
            <line x1="21" y1="20" x2="16" y2="20" />
            <line x1="12" y1="20" x2="3" y2="20" />
            <line x1="16" y1="18" x2="16" y2="22" />
          </svg>
        </button>
      </div>
    </div>
  </div>
  <Tuner v-if="tunerOpen" @rebuild="sim.reset()" />
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
  flex-direction: column;
  justify-content: flex-start;
  gap: 6px;
}

.cell .num {
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  line-height: 1;
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

.tune-btn,
.checkbox {
  pointer-events: auto;
}

.readout {
  min-width: 30px;
  text-align: left;
  color: #b7c2d4;
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.checkbox {
  position: relative;
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin: 0;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.checkbox:hover {
  background: rgba(255, 255, 255, 0.13);
}

.checkbox:checked {
  background: #6fa8ff;
  border-color: #6fa8ff;
}

.checkbox:checked::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid #10141c;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.checkbox:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 2px;
}

.tune-btn {
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

.tune-btn:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.tune-btn.active {
  color: #eef2f8;
  background: rgba(111, 168, 255, 0.18);
  border-color: rgba(111, 168, 255, 0.45);
}

.tune-btn:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 2px;
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
