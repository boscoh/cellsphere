<script setup>
defineProps({
  frameMs: { type: Number, default: 0 },
  perf: { type: Object, default: () => ({}) },
})

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
      <span class="ctl">Perf ms</span>
    </div>
    <div class="perfs">
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
