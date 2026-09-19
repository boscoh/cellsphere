import * as THREE from 'three'
import { P } from './constants.js'
import { foodGeo, foodMat } from './materials.js'

// Food instancing is a view concern: the mesh is created on demand from the
// render pass, and `syncFood` uploads only the records that changed. The sim
// keeps plain food data (pos/visible/scale/index/dirty); it never touches a GPU
// buffer. Replaces the old food.js `placeFood`.

export function ensureFoodMesh(view) {
  if (view.foodMesh && view.foodMesh.count === P.FOOD_COUNT) return
  if (view.foodMesh) {
    view.scene.remove(view.foodMesh)
    view.foodMesh.dispose()
  }
  const mesh = new THREE.InstancedMesh(foodGeo, foodMat, P.FOOD_COUNT)
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  view.scene.add(mesh)
  view.foodMesh = mesh
  // Capacity changed, so every live instance has to be rewritten.
  for (const food of view.sim.foods) food.dirty = true
}

export function syncFood(view) {
  const mesh = view.foodMesh
  if (!mesh) return
  let any = false
  for (const food of view.sim.foods) {
    if (!food.dirty) continue
    food.dirty = false
    const s = food.visible ? food.scale : 0.0001
    view._dummy.position.copy(food.pos)
    view._dummy.scale.set(s, s, s)
    view._dummy.rotation.set(0, 0, 0)
    view._dummy.updateMatrix()
    mesh.setMatrixAt(food.index, view._dummy.matrix)
    any = true
  }
  if (any) mesh.instanceMatrix.needsUpdate = true
}

export function disposeFoodMesh(view) {
  if (!view.foodMesh) return
  view.scene.remove(view.foodMesh)
  view.foodMesh.dispose()
  view.foodMesh = null
}
