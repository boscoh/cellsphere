import * as THREE from 'three'

const MAX_POPS = 96
const POP_LIFE = 0.55
// Base capsule matching makeBodyGeo(1, 0.5): half-length 1, radius 0.5, along X.
const POP_BASE_LEN = 1
const POP_BASE_WIDTH = 0.5
const POP_GROW = 0.9

function makePopGeo() {
  const cylLen = Math.max(2 * (POP_BASE_LEN - POP_BASE_WIDTH), 0.001)
  const geo = new THREE.CapsuleGeometry(POP_BASE_WIDTH, cylLen, 6, 12)
  geo.rotateZ(Math.PI / 2)
  return geo
}

export function initPops(sim) {
  if (sim.popMesh) return
  const geo = makePopGeo()
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_POPS)
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.renderOrder = 4
  sim.scene.add(mesh)
  sim.popMesh = mesh
  sim.pops = []
  sim._popColor = new THREE.Color()
}

export function spawnPop(sim, d) {
  if (!sim.popMesh) return
  if (sim.pops.length >= MAX_POPS) sim.pops.shift()
  sim.pops.push({
    x: d.pos.x,
    y: d.pos.y,
    z: d.pos.z,
    qx: d.quat.x,
    qy: d.quat.y,
    qz: d.quat.z,
    qw: d.quat.w,
    // Base scale that reproduces this cell's capsule from the unit geometry.
    sx: d.radius / POP_BASE_LEN,
    sy: d.width / POP_BASE_WIDTH,
    r: d.color.r,
    g: d.color.g,
    b: d.color.b,
    age: 0,
  })
}

export function updatePops(sim, dt) {
  const mesh = sim.popMesh
  if (!mesh) return
  const pops = sim.pops
  for (let i = pops.length - 1; i >= 0; i--) {
    pops[i].age += dt
    if (pops[i].age >= POP_LIFE) pops.splice(i, 1)
  }
  if (!sim.camera) {
    mesh.count = 0
    return
  }
  // Expand each pop as a shell in the cell's own capsule shape, fading by
  // scaling the additive instance color toward black.
  const col = sim._popColor
  const dummy = sim._dummy
  let n = 0
  for (let i = 0; i < pops.length; i++) {
    const p = pops[i]
    const t = p.age / POP_LIFE
    const ease = 1 - (1 - t) * (1 - t)
    const grow = 1 + POP_GROW * ease
    const a = (1 - t) * (1 - t)
    dummy.position.set(p.x, p.y, p.z)
    dummy.quaternion.set(p.qx, p.qy, p.qz, p.qw)
    dummy.scale.set(p.sx * grow, p.sy * grow, p.sy * grow)
    dummy.updateMatrix()
    mesh.setMatrixAt(n, dummy.matrix)
    mesh.setColorAt(n, col.setRGB(p.r * a, p.g * a, p.b * a))
    n++
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

export function disposePops(sim) {
  if (!sim.popMesh) return
  sim.scene.remove(sim.popMesh)
  sim.popMesh.geometry.dispose()
  sim.popMesh.material.dispose()
  sim.popMesh = null
  sim.pops = []
}
