<script setup>
import { ref } from 'vue'

defineProps({
  frameMs: { type: Number, default: 0 },
  perf: { type: Object, default: () => ({}) },
})

const expanded = ref(true)

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
  pops: 'pops (bursts)',
  draw: 'draw',
}
</script>

<template>
  <div class="perf-panel">
    <div class="perf-head">
      <button
        type="button"
        class="perf-toggle"
        :class="{ collapsed: !expanded }"
        :aria-expanded="String(expanded)"
        :title="expanded ? 'Collapse perf' : 'Expand perf'"
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
      <span class="ctl">Perf ms</span>
    </div>
    <div v-show="expanded" class="perfs">
      <span class="perf-name">frame</span>
      <span class="perf-val">{{ frameMs.toFixed(1) }}</span>
      <template v-for="(ms, name) in perf" :key="name">
        <span class="perf-name">{{ PERF_LABELS[name] || name }}</span>
        <span class="perf-val">{{ ms.toFixed(1) }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
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
</style>
