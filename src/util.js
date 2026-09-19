// Dependency-free helpers for headless scripts and tests. Kept import-free so
// plain Node can load it (Vite resolves extension-less imports, Node does not).

// Deterministic PRNG for reproducible seeded runs: `Math.random = mulberry32(s)`.
export function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
