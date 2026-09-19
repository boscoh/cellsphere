<script setup>
import { reactive, computed, ref } from 'vue'
import { GROUPS, P, PARAM_DEFS, setParam } from '../constants.js'

const emit = defineEmits(['rebuild', 'default', 'param'])

const expanded = ref(false)

function syncValues() {
  for (const r of rows) r.value = r.def
}

function collapse() {
  expanded.value = false
}

defineExpose({ syncValues, collapse })

const rows = reactive(
  PARAM_DEFS.map((p) => ({
    key: p.key,
    group: p.group,
    label: p.label,
    desc: p.desc,
    min: p.min,
    max: p.max,
    step: p.step,
    def: p.def,
    value: P[p.key],
    rebuild: !!p.rebuild,
  })),
)

const groups = computed(() => {
  const buckets = new Map(GROUPS.map((g) => [g.key, []]))
  for (const r of rows) buckets.get(r.group)?.push(r)
  return GROUPS.filter((g) => buckets.get(g.key).length).map((g) => ({
    label: g.label,
    params: buckets.get(g.key),
  }))
})

function onInput(row, event) {
  const v = Number(event.target.value)
  row.value = v
  setParam(row.key, v)
  emit('param', row.key, v)
}

function onChange(row) {
  if (row.rebuild) emit('rebuild')
}

function fmt(v) {
  return String(parseFloat(v.toFixed(4)))
}

function fillPct(value, min, max) {
  return max > min ? ((value - min) / (max - min)) * 100 : 0
}
</script>

<template>
  <aside id="tuner-panel" class="panel">
    <header class="head">
      <button
        type="button"
        class="icon-btn"
        :class="{ collapsed: !expanded }"
        :aria-expanded="String(expanded)"
        :title="expanded ? 'Collapse parameters' : 'Expand parameters'"
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
      <span class="title">Parameters</span>
    </header>
    <div v-show="expanded" class="body">
      <button
        type="button"
        class="secondary-btn"
        title="Reset all parameters to defaults"
        @click="emit('default')"
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <polyline points="3 3 3 9 9 9" />
        </svg>
        Reset
      </button>
      <section v-for="g in groups" :key="g.label" class="group">
        <h2 class="group-title">{{ g.label }}</h2>
        <div v-for="p in g.params" :key="p.key" class="param" :title="p.desc">
          <div class="param-head">
            <span class="param-label">{{ p.label }}</span>
            <span class="readout">{{ fmt(p.value) }}</span>
          </div>
          <input
            type="range"
            :min="p.min"
            :max="p.max"
            :step="p.step"
            :value="p.value"
            class="slider"
            :style="{ '--fill': fillPct(p.value, p.min, p.max) + '%' }"
            :aria-label="p.label"
            @input="onInput(p, $event)"
            @change="onChange(p)"
          />
          <p class="desc">{{ p.desc }}</p>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  position: fixed;
  top: 74px;
  left: 24px;
  z-index: 3;
  width: max-content;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 172px);
  display: flex;
  flex-direction: column;
  background: rgba(10, 12, 16, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  font-family: system-ui, sans-serif;
  color: #b7c2d4;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 10px 14px;
}

.head .title {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #6b7484;
  line-height: 1.2;
}

.icon-btn {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: #b7c2d4;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.icon-btn:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.icon-btn:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 2px;
}

.icon-btn svg {
  transition: transform 0.15s ease;
}

.icon-btn.collapsed svg {
  transform: rotate(180deg);
}

.secondary-btn {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: 26px;
  padding: 0 12px;
  margin: 2px 0 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #b7c2d4;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.secondary-btn:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.12);
}

.secondary-btn:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 2px;
}

.body {
  width: 300px;
  box-sizing: border-box;
  margin-left: 14px;
  overflow-y: auto;
  padding: 6px 14px 16px;
}

.group {
  padding: 10px 0 2px;
}

.group-title {
  margin: 0 0 4px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: #6b7484;
}

.param {
  padding: 8px 0 14px;
}

.param-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.param-label {
  text-transform: uppercase;
  letter-spacing: 0.3px;
  font-size: 10px;
  color: #c6cfdf;
}

.readout {
  font-size: 10px;
  color: #8a93a6;
  font-variant-numeric: tabular-nums;
}

.slider {
  width: 100%;
  margin: 4px 0 9px;
  cursor: pointer;
}

.desc {
  margin: 0;
  font-size: 10px;
  line-height: 1.35;
  color: #c6cfdf;
}
</style>
