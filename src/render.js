import { CULL_COS } from './constants'
import { renderBodies } from './cells'
import { cosFace } from './math'

function updateVisibility(sim) {
  if (!sim.camera) return
  const cam = sim.camera.position
  const camDir = sim._camDir.set(cam.x, cam.y, cam.z).normalize()
  for (const cell of sim.cells) {
    // Hide a cell's TAIL once its surface stops facing the camera (far side):
    // its body is behind the opaque shell anyway, but the tail would poke past
    // the silhouette and read as an orphan "tail with no body". Bodies are never
    // culled — the shell occludes far ones on its own, and the pooled body
    // InstancedMeshes have frustumCulled disabled so a zoom-in can't drop them.
    cell.sideHidden = cosFace(cell.pos, camDir) <= CULL_COS
  }
}

export function renderView(sim, tailScale) {
  sim.tailScale = tailScale
  sim.tailsHidden = tailScale < 0.5
  if (sim.tailMesh) sim.tailMesh.visible = !sim.tailsHidden
  updateVisibility(sim)

  renderBodies(sim)
  sim.renderTails()

  if (sim.controls) sim.controls.update()
  if (sim.renderer) sim.renderer.render(sim.scene, sim.camera)
}
