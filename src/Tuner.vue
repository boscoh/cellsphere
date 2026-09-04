<script setup>
import { reactive, computed, ref, onMounted } from 'vue'
import { GROUPS, PARAMS, setParam } from './constants'

const emit = defineEmits(['rebuild'])

function syncValues() {
  for (const r of rows) r.value = r.def
}

defineExpose({ syncValues })

const panelEl = ref(null)
const panelPos = ref({ top: 128, left: 24 })

onMounted(() => {
  const btn = document.getElementById('tune-toggle')
  if (btn) {
    const b = btn.getBoundingClientRect()
    const w = panelEl.value?.getBoundingClientRect().width ?? 300
    const cx = b.left + b.width / 2
    const left = Math.min(Math.max(8, cx - w / 2), window.innerWidth - w - 8)
    panelPos.value = { top: b.bottom + 8, left }
    return
  }
  const hud = document.querySelector('.hud')
  if (hud) {
    const r = hud.getBoundingClientRect()
    panelPos.value = { top: r.bottom + 8, left: r.right - 300 }
  }
})

const rows = reactive(
  PARAMS.map((p) => ({
    key: p.key,
    group: p.group,
    label: p.label,
    desc: p.desc,
    min: p.min,
    max: p.max,
    step: p.step,
    def: p.def,
    value: p.value,
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
}

function onChange(row) {
  if (row.rebuild) emit('rebuild')
}

function fmt(v) {
  return String(parseFloat(v.toFixed(4)))
}
</script>

<template>
  <aside id="tuner-panel" ref="panelEl" class="panel" :style="{ top: panelPos.top + 'px', left: panelPos.left + 'px' }">
    <header class="head">
      <span class="title">Parameter Tuner</span>
    </header>
    <div class="body">
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
  z-index: 3;
  width: 300px;
  max-height: calc(100vh - 156px);
  display: flex;
  flex-direction: column;
  background: rgba(10, 12, 16, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 14px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  font-family: system-ui, sans-serif;
  color: #b7c2d4;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.head .title {
  font-size: 12px;
  font-weight: 600;
  color: #eef2f8;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.body {
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
  padding: 6px 0 8px;
}

.param-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.param-label {
  font-size: 11px;
  color: #c6cfdf;
}

.readout {
  font-size: 11px;
  color: #8a93a6;
  font-variant-numeric: tabular-nums;
}

.slider {
  width: 100%;
  margin: 4px 0;
  accent-color: #6fa8ff;
  cursor: pointer;
}

.desc {
  margin: 0;
  font-size: 10px;
  line-height: 1.35;
  color: #5f6876;
}
</style>
