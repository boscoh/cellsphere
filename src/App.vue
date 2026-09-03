<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Simulation } from './sim'
import { FIXED_DT } from './constants'

const canvasHolder = ref(null)
const tailsActive = ref(true)
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
  <div class="hud">
    <div class="stats">
      <span class="title">Cell</span>
      <span class="stat">{{ fps }} fps</span>
      <span class="stat">{{ bacteriaCount }} bacteria</span>
      <span class="stat">{{ foodCount }} food</span>
    </div>
    <span class="divider"></span>
    <div class="controls">
      <label class="ctl" for="speed">Speed</label>
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
      <span class="divider"></span>
      <span class="ctl">Tails</span>
      <button
        type="button"
        class="switch"
        :class="tailsActive ? 'on' : 'off'"
        role="switch"
        :aria-checked="String(tailsActive)"
        :aria-label="'tails ' + (tailsActive ? 'on' : 'off')"
        @click="tailsActive = !tailsActive"
      >
        <span class="sw-opt off">off</span>
        <span class="sw-thumb"></span>
        <span class="sw-opt on">on</span>
      </button>
      <span class="divider"></span>
      <button type="button" class="restart" @click="sim.reset()">Restart</button>
    </div>
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
  flex-direction: row;
  align-items: center;
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

.stats {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 12px;
  color: #8a93a6;
}

.stats .title {
  font-size: 15px;
  font-weight: 600;
  color: #eef2f8;
  letter-spacing: -0.3px;
  padding-right: 2px;
}

.stats .stat {
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
}

.stats .stat + .stat {
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  padding-left: 12px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: auto;
  font-size: 11px;
  color: #8a93a6;
}

.ctl {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #6b7484;
}

.slider {
  width: 110px;
  accent-color: #6fa8ff;
  cursor: pointer;
}

.readout {
  min-width: 30px;
  text-align: left;
  color: #b7c2d4;
  font-variant-numeric: tabular-nums;
}

.divider {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.12);
}

.switch {
  position: relative;
  width: 66px;
  height: 24px;
  padding: 0;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  cursor: pointer;
}

.sw-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 30px;
  height: 18px;
  border-radius: 999px;
  background: #6fa8ff;
  transition: transform 0.18s ease;
}

.switch.on .sw-thumb {
  transform: translateX(30px);
}

.sw-opt {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #7c8698;
  pointer-events: none;
  transition: color 0.15s ease;
}

.sw-opt.off {
  left: 7px;
}

.sw-opt.on {
  right: 7px;
}

.switch.on .sw-opt.on,
.switch.off .sw-opt.off {
  color: #10141c;
  font-weight: 700;
}

.switch:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 2px;
}

.restart {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #b7c2d4;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
}

.restart:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.restart:focus-visible {
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
