<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Simulation } from './sim.js'
import {
  P,
  FIXED_DT,
  MAX_SIM_RATE,
  POP_SAMPLES,
  resetParams,
  setParam,
} from './constants.js'
import Hud from './components/Hud.vue'
import PerfPanel from './components/PerfPanel.vue'
import Tuner from './components/Tuner.vue'
import PopChart from './components/PopChart.vue'

const canvasHolder = ref(null)
const tailsActive = ref(true)
const tunerRef = ref(null)
const simRate = ref(P.SIM_SPEED)
const frameMs = ref(0)
const blueCount = ref(0)
const redCount = ref(0)
const foodCount = ref(0)
const popHistory = ref([])
const perf = ref({})
const MAX_BACKLOG = MAX_SIM_RATE * FIXED_DT

let sim
let animationId
let lastTime = performance.now()
let accumulator = 0
let fpsCount = 0
let fpsTime = 0
const handleResize = () => sim.onResize()
const onKey = (e) => {
  if (e.key === 'Escape') tunerRef.value?.collapse()
}

function onReset() {
  resetParams()
  tunerRef.value?.syncValues()
  simRate.value = P.SIM_SPEED
  popHistory.value = []
  sim.reset()
}

function onRestart() {
  popHistory.value = []
  sim.reset()
}

function onParamChange(key, value) {
  if (key === 'SIM_SPEED') simRate.value = value
}

function onSpeed(v) {
  simRate.value = v
  setParam('SIM_SPEED', v)
}

function onTails(active) {
  tailsActive.value = active
  // The cosmetic tail pose is gated by a sim-owned flag so advance() never reads
  // render state; tails are visual-only, so this cannot change motion.
  if (sim) sim.poseEnabled = active
}

onMounted(() => {
  sim = new Simulation()
  sim.attach(canvasHolder.value)
  sim.buildWorld()
  sim.poseEnabled = tailsActive.value

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
      let blue = 0
      let red = 0
      for (const c of sim.cells) {
        if (c.breed === 0) blue++
        else red++
      }
      blueCount.value = blue
      redCount.value = red
      popHistory.value.push({ t: sim.simTime, blue, red })
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
  <Hud
    :blue-count="blueCount"
    :red-count="redCount"
    :food-count="foodCount"
    :sim-rate="simRate"
    :max-sim-rate="MAX_SIM_RATE"
    :tails-active="tailsActive"
    @update:sim-rate="onSpeed"
    @update:tails-active="onTails"
    @restart="onRestart"
  />
  <Tuner ref="tunerRef" @rebuild="onRestart" @default="onReset" @param="onParamChange" />
  <div class="bottom-left">
    <PerfPanel :frame-ms="frameMs" :perf="perf" />
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
