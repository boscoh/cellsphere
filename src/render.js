import { CULL_COS } from './constants'
import { renderBodies } from './cells'
import { bodyMat } from './materials'
import { cosFace } from './math'

// View-layer options. Every branch is a conscious, reversible toggle so the
// pipeline can be bisected live and audited headlessly.
export const defaultRenderOptions = {
  drawShell: true,
  drawFood: true,
  drawTails: true,
  drawBodies: true,
  cull: true, // hides far-side TAILS at the horizon (bodies are never culled)
  bodyDepthWrite: true, // bodies are transparent; depthWrite inherits this
  forceOpaqueBodies: false, // diagnostic: join the opaque pass (no sorting)
}

function updateVisibility(sim) {
  if (!sim.camera) return
  const cam = sim.camera.position
  const camDir = sim._camDir.set(cam.x, cam.y, cam.z).normalize()
  for (const cell of sim.cells) {
    // Hide a cell's TAIL once its surface stops facing the camera (far side):
    // its body is behind the opaque shell anyway, but the tail would poke past
    // the silhouette and read as an orphan "tail with no body". Bodies are
    // never culled — the shell occludes far ones on its own.
    cell.sideHidden = sim.renderOptions.cull && cosFace(cell.pos, camDir) <= CULL_COS
  }
}

export function renderView(sim, tailScale) {
  const o = sim.renderOptions
  sim.tailScale = tailScale
  sim.tailsHidden = tailScale < 0.5
  if (sim.tailMesh) sim.tailMesh.visible = !sim.tailsHidden
  updateVisibility(sim)

  if (sim.sphereShell) sim.sphereShell.visible = o.drawShell
  if (sim.foodMesh) sim.foodMesh.visible = o.drawFood

  if (o.forceOpaqueBodies) {
    bodyMat.transparent = false
    bodyMat.depthWrite = true
  } else {
    bodyMat.transparent = true
    bodyMat.depthWrite = o.bodyDepthWrite
  }

  if (o.drawBodies) renderBodies(sim)

  if (o.drawTails) sim.renderTails()

  if (sim.controls) sim.controls.update()
  if (sim.renderer) sim.renderer.render(sim.scene, sim.camera)
}
