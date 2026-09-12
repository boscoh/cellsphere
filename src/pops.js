import { makeGlowMesh, disposeGlowMesh } from './glow'

const MAX_POPS = 96
const POP_LIFE = 0.55
// Grow the burst to ~1.55x as it fades, as a uniform scale of the cell's
// capsule (radius x width) so the burst stays an oval matching the body.
const POP_GROW = 0.55
const LEN_K = 1.5
const WIDTH_K = 1.5

export function initPops(sim) {
  if (sim.popGlow) return
  sim.pops = []
  sim.popGlow = makeGlowMesh(MAX_POPS, 5)
  sim.scene.add(sim.popGlow.mesh)
}

export function spawnPop(sim, d) {
  if (!sim.popGlow) return
  if (sim.pops.length >= MAX_POPS) sim.pops.shift()
  sim.pops.push({
    x: d.pos.x,
    y: d.pos.y,
    z: d.pos.z,
    radius: d.radius,
    width: d.width,
    hx: d.heading.x,
    hy: d.heading.y,
    hz: d.heading.z,
    r: d.color.r,
    g: d.color.g,
    b: d.color.b,
    age: 0,
  })
}

export function updatePops(sim, dt) {
  const entry = sim.popGlow
  if (!entry) return
  const pops = sim.pops
  for (let i = pops.length - 1; i >= 0; i--) {
    pops[i].age += dt
    if (pops[i].age >= POP_LIFE) pops.splice(i, 1)
  }
  const { mesh, halfLen, halfWidth, alpha, color, axis } = entry
  const dummy = sim._dummy
  let n = 0
  for (let i = 0; i < pops.length; i++) {
    const p = pops[i]
    const t = p.age / POP_LIFE
    const ease = 1 - (1 - t) * (1 - t)
    const grow = 1 + POP_GROW * ease
    const a = (1 - t) * (1 - t)
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    mesh.setMatrixAt(n, dummy.matrix)
    halfLen.setX(n, p.radius * LEN_K * grow)
    halfWidth.setX(n, p.width * WIDTH_K * grow)
    alpha.setX(n, a)
    color.setXYZ(n, p.r, p.g, p.b)
    axis.setXYZ(n, p.hx, p.hy, p.hz)
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

export function disposePops(sim) {
  if (!sim.popGlow) return
  sim.scene.remove(sim.popGlow.mesh)
  disposeGlowMesh(sim.popGlow)
  sim.popGlow = null
  sim.pops = []
}
