<script setup>
defineProps({
  tabs: { type: Array, default: () => [] },
  active: { type: String, default: '' },
})

const emit = defineEmits(['update:active'])

function select(key, current) {
  emit('update:active', current === key ? '' : key)
}
</script>

<template>
  <div class="tabs" role="tablist" aria-label="Panels">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      role="tab"
      class="tab"
      :class="{ active: active === tab.key }"
      :aria-selected="String(active === tab.key)"
      @click="select(tab.key, active)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: rgba(10, 12, 16, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  font-family: system-ui, sans-serif;
  user-select: none;
  pointer-events: auto;
}

.tab {
  padding: 5px 12px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8a93a6;
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.tab:hover {
  color: #eef2f8;
  background: rgba(255, 255, 255, 0.07);
}

.tab.active {
  color: #eef2f8;
  background: rgba(111, 168, 255, 0.22);
  box-shadow: inset 0 0 0 1px rgba(111, 168, 255, 0.4);
}

.tab:focus-visible {
  outline: 2px solid rgba(111, 168, 255, 0.7);
  outline-offset: 1px;
}
</style>
