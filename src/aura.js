import { MAX_CELLS } from './constants'
import { cellAura } from './cells'
import { makeGlowMesh, disposeGlowMesh } from './glow'

// Glow half-length along the body axis and half-width across it. Slightly
// larger than the capsule so the halo spills past the silhouette, with a small
// width floor so a thin cell still gets a visible halo.
const LEN_K = 1.5
const WIDTH_K = 1.5
const WIDTH_PAD_K = 0.2
const _aura = { intensity: 0, r: 1, g: 1, b: 1 }

export function initAura(sim) {
  if (sim.auraGlow) return
  sim.auraGlow = makeGlowMesh(MAX_CELLS, 3)
  sim.scene.add(sim.auraGlow.mesh)
}

export function renderAura(sim) {
  const entry = sim.auraGlow
  if (!entry || !sim.camera) return
  const { mesh, halfLen, halfWidth, alpha, color, axis } = entry
  const dummy = sim._dummy
  let n = 0
  for (const d of sim.cells) {
    if (d.bodyBucket == null || d.sideHidden) continue
    const aura = cellAura(d, _aura)
    if (aura.intensity <= 0.001) continue
    dummy.position.copy(d.pos)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    mesh.setMatrixAt(n, dummy.matrix)
    halfLen.setX(n, d.radius * LEN_K)
    halfWidth.setX(n, d.width * WIDTH_K + d.radius * WIDTH_PAD_K)
    alpha.setX(n, aura.intensity)
    color.setXYZ(n, aura.r, aura.g, aura.b)
    axis.setXYZ(n, d.heading.x, d.heading.y, d.heading.z)
    n++
  }
  mesh.count = n
  if (n > 0) {
    mesh.instanceMatrix.needsUpdate = true
    halfLen.needsUpdate = true
    halfWidth.needsUpdate = true
    alpha.needsUpdate = true
    color.needsUpdate = true
    axis.needsUpdate = true
  }
}

export function disposeAura(sim) {
  if (!sim.auraGlow) return
  sim.scene.remove(sim.auraGlow.mesh)
  disposeGlowMesh(sim.auraGlow)
  sim.auraGlow = null
}
