<script setup>
import { computeCellColor } from '../cells.js'

defineProps({
  simRate: { type: Number, default: 1 },
  maxSimRate: { type: Number, default: 50 },
  tailsActive: { type: Boolean, default: true },
  greenCount: { type: Number, default: 0 },
  redCount: { type: Number, default: 0 },
})

const emit = defineEmits(['update:simRate', 'update:tailsActive', 'restart'])

const greenColor = '#' + computeCellColor(0).getHexString()
const redColor = '#' + computeCellColor(1).getHexString()

function onSpeed(event) {
  emit('update:simRate', Number(event.target.value))
}

function fillPct(value, min, max) {
  return max > min ? ((value - min) / (max - min)) * 100 : 0
}
</script>

<template>
  <div class="hud-root">
    <div class="hud">
      <span class="brand">CellSphere</span>
      <div class="cell">
        <span class="stat"><span class="dot" :style="{ background: greenColor }"></span>{{ greenCount }}</span>
        <span class="stat"><span class="dot" :style="{ background: redColor }"></span>{{ redCount }}</span>
      </div>
      <div class="cell">
        <button
          type="button"
          class="toggle-btn"
          :class="{ active: tailsActive }"
          :aria-pressed="String(tailsActive)"
          title="Toggle tail"
          aria-label="Toggle tail"
          @click="emit('update:tailsActive', !tailsActive)"
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M12 4c-4.2 1.6-4.2 3.6 0 5.2s4.2 3.6 0 5.2-4.2 3.6 0 5.2" />
          </svg>
        </button>
        <button
          type="button"
          class="reset-btn"
          aria-label="Restart"
          title="Restart"
          @click="emit('restart')"
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
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>
      <div class="cell">
        <div class="row">
          <input
            id="speed"
            class="slider"
            aria-label="Time"
            type="range"
            min="1"
            :max="maxSimRate"
            step="1"
            :value="simRate"
            :style="{ '--fill': fillPct(simRate, 1, maxSimRate) + '%' }"
            @input="onSpeed"
          />
          <span class="readout">{{ simRate }}x</span>
        </div>
      </div>
    </div>
    <p class="tagline">Predator&ndash;prey bacteria on a sphere of food clumps</p>
  </div>
</template>

<style scoped>
.hud-root {
  position: fixed;
  top: 10px;
  left: 12px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  pointer-events: none;
  font-family: system-ui, sans-serif;
  user-select: none;
}

.hud {
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

.tagline {
  margin: 0 0 0 3px;
  font-size: 11px;
  line-height: 1.3;
  letter-spacing: 0.2px;
  color: rgba(160, 172, 192, 0.8);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.65);
}

.cell {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #b7c2d4;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
}

.slider {
  width: 60px;
  height: 20px;
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
  width: 28px;
  height: 24px;
  padding: 0;
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
</style>
