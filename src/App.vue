<script setup>
import { markRaw, onMounted, onBeforeUnmount, ref, toRaw } from 'vue'
import { Simulation } from './sim.js'
import {
  P,
  FIXED_DT,
  MAX_SIM_RATE,
  SAMPLE_DT,
  POP_WINDOW_S,
  resetParams,
} from './constants.js'
import Hud from './components/Hud.vue'
import PanelTabs from './components/PanelTabs.vue'
import PerfPanel from './components/PerfPanel.vue'
import Tuner from './components/Tuner.vue'
import PopChart from './components/PopChart.vue'
import RateChart from './components/RateChart.vue'
import { computeRates } from './components/rateModel.js'
import { windowTail } from './components/popChartMath.js'

const canvasHolder = ref(null)
const tailsActive = ref(true)
const activePanel = ref('population')
const tunerRef = ref(null)
const simRate = ref(P.SIM_SPEED)
const frameMs = ref(0)
const greenCount = ref(0)
const redCount = ref(0)
const foodCount = ref(0)
// The sliding window: the only retained run history in the app. Both chart
// panels read it — the population chart draws it, the autocorrelation panel
// correlates over it (its window is clamped to the same span) — so there is one
// retention policy and one place that can grow.
const popHistory = ref([])
const latestRates = ref(null)
const perf = ref({})
const MAX_BACKLOG = MAX_SIM_RATE * FIXED_DT

const PANEL_TABS = [
  { key: 'tune', label: 'Tune' },
  { key: 'population', label: 'Population' },
  { key: 'cycles', label: 'Cycles' },
  { key: 'perf', label: 'Perf' },
  { key: 'github', label: 'GitHub', href: 'https://github.com/boscoh/cellsphere' },
]

let sim
let animationId
let lastTime = performance.now()
let accumulator = 0
let fpsCount = 0
let fpsTime = 0
let nextSampleT = 0
const handleResize = () => sim.onResize()
const onKey = (e) => {
  if (e.key === 'Escape') activePanel.value = ''
}

function onReset() {
  resetParams()
  tunerRef.value?.syncValues()
  simRate.value = P.SIM_SPEED
  popHistory.value = []
  latestRates.value = null
  nextSampleT = 0
  sim.reset()
}

function onRestart() {
  simRate.value = P.SIM_SPEED
  popHistory.value = []
  latestRates.value = null
  nextSampleT = 0
  sim.reset()
}

// One sample per case into the sliding window. Samples are `markRaw` plain data,
// so no proxy is ever built for one. The window is published as a raw copy on the
// samples that age out rather than shifted a slot per push, which would be a
// proxy trap for every element moved.
function pushSample(t, green, red) {
  const sample = markRaw({ t, green, red })
  const hist = popHistory.value
  hist.push(sample)
  const raw = toRaw(hist)
  const kept = windowTail(raw, POP_WINDOW_S)
  if (kept !== raw) popHistory.value = kept
}

function onSpeed(v) {
  simRate.value = v
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

    // Population history is sampled on a fixed *sim-time* cadence, not wall
    // time: wall-time sampling coarsens the spacing as simRate rises (25 s per
    // sample at 50x), which would make the rate curves noisy exactly when you
    // speed up to watch a cycle. The history therefore spans a fixed sim-time
    // window at any rate.
    if (sim.simTime >= nextSampleT) {
      let green = 0
      let red = 0
      for (const c of sim.cells) {
        if (c.breed === 0) green++
        else red++
      }
      greenCount.value = green
      redCount.value = red
      pushSample(sim.simTime, green, red)
      latestRates.value = computeRates(green, red)
      nextSampleT = sim.simTime + SAMPLE_DT
    }

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
    :sim-rate="simRate"
    :max-sim-rate="MAX_SIM_RATE"
    :tails-active="tailsActive"
    :green-count="greenCount"
    :red-count="redCount"
    @update:sim-rate="onSpeed"
    @update:tails-active="onTails"
    @restart="onRestart"
  />
  <div v-if="activePanel" class="dock">
    <Tuner
      v-if="activePanel === 'tune'"
      ref="tunerRef"
      @rebuild="onRestart"
      @default="onReset"
    />
    <PopChart
      v-else-if="activePanel === 'population'"
      :samples="popHistory"
      :rates="latestRates"
      :food-count="foodCount"
    />
    <RateChart
      v-else-if="activePanel === 'cycles'"
      :rates="latestRates"
      :pop-samples="popHistory"
    />
    <PerfPanel v-else-if="activePanel === 'perf'" :frame-ms="frameMs" :perf="perf" />
  </div>
  <PanelTabs v-model:active="activePanel" :tabs="PANEL_TABS" class="tabs" />
</template>

<style scoped>
.canvas-holder {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.dock {
  position: fixed;
  left: 12px;
  bottom: 48px;
  z-index: 3;
  max-height: 40vh;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  pointer-events: none;
}

.tabs {
  position: fixed;
  left: 12px;
  bottom: 9px;
  z-index: 4;
}
</style>
