<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Simulation } from './sim'
import { MAX_STEPS, FIXED_DT } from './constants'

const canvasHolder = ref(null)
const tailsActive = ref(true)
const simRate = ref(15)
const fps = ref(0)
const bacteriaCount = ref(0)
const foodCount = ref(0)
const MAX_SIM_RATE = MAX_STEPS
const MAX_BACKLOG = MAX_STEPS * FIXED_DT

let sim
let animationId
let lastTime = performance.now()
let accumulator = 0
let fpsCount = 0
let fpsTime = 0
const handleResize = () => sim.onResize()

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
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', handleResize)
  sim.dispose()
})
</script>

<template>
  <div ref="canvasHolder" class="canvas-holder"></div>
  <div class="overlay">
    <h1>Cell</h1>
    <p>render <span class="rate">{{ fps }} fps</span> · drag to orbit · scroll to zoom</p>
    <p class="counts">
      bacteria <span class="count">{{ bacteriaCount }}</span> · food
      <span class="count">{{ foodCount }}</span>
    </p>
    <div class="control">
      <label for="speed">sim rate</label>
      <input
        id="speed"
        type="range"
        min="0"
        :max="MAX_SIM_RATE"
        step="2"
        v-model.number="simRate"
      />
      <span class="readout">{{ simRate }}×</span>
      <span class="readout muted">max {{ MAX_SIM_RATE }}×</span>
    </div>
    <div class="control">
      <label for="tails">tails</label>
      <input id="tails" type="checkbox" v-model="tailsActive" />
      <span class="readout">{{ tailsActive ? 'on' : 'off' }}</span>
    </div>
    <div class="control">
      <button type="button" class="restart" @click="sim.reset()">restart</button>
    </div>
  </div>
</template>

<style scoped>
.canvas-holder {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.overlay {
  position: fixed;
  top: 28px;
  left: 32px;
  color: #e8ecf3;
  pointer-events: none;
  user-select: none;
  font-family: system-ui, sans-serif;
  z-index: 1;
}

.overlay h1 {
  margin: 0 0 6px;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.5px;
}

.overlay p {
  margin: 0;
  font-size: 13px;
  color: #8a93a6;
}

.overlay .counts {
  margin-top: 4px;
}

.overlay .counts .count {
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
}

.overlay .rate {
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
}

.control {
  margin-top: 22px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #8a93a6;
  pointer-events: auto;
}

.control label {
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-size: 11px;
}

.control input[type='range'] {
  width: 140px;
  accent-color: #6fa8ff;
  cursor: pointer;
}

.control .readout {
  min-width: 36px;
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
}

.control .readout.muted {
  color: #6b7484;
}

.control .restart {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #b7c2d4;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  padding: 4px 12px;
  cursor: pointer;
}

.control .restart:hover {
  color: #e8ecf3;
  background: rgba(255, 255, 255, 0.12);
}
</style>
