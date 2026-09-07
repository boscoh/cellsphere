export function createPerf() {
  const totals = {}
  const start = {}
  return {
    totals,
    begin(name) {
      start[name] = performance.now()
    },
    end(name) {
      const t = performance.now() - (start[name] || 0)
      totals[name] = (totals[name] || 0) + t
      start[name] = 0
    },
    clear() {
      for (const k in totals) delete totals[k]
    },
  }
}
