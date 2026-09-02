<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Simulation } from './sim'

const canvasHolder = ref(null)
const tailsActive = ref(true)
const simSpeed = ref(1500)

let sim
let animationId
let lastTime = performance.now()
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
    const timeScale = simSpeed.value / 100
    sim.frame(rawDt * timeScale, tailsActive.value ? 1 : 0.0001)
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
    <p>bacteria graze the sphere · drag to orbit · scroll to zoom</p>
    <div class="control">
      <label for="speed">sim speed</label>
      <input
        id="speed"
        type="range"
        min="0"
        max="3000"
        step="20"
        v-model.number="simSpeed"
      />
      <span class="readout">{{ simSpeed }}%</span>
    </div>
    <div class="control">
      <label for="tails">tails</label>
      <input id="tails" type="checkbox" v-model="tailsActive" />
      <span class="readout">{{ tailsActive ? 'on' : 'off' }}</span>
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
</style>
