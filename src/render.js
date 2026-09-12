import { CULL_COS } from './constants'
import { renderBodies, warmTail } from './cells'
import { renderAura } from './aura'
import { updatePops } from './pops'
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

export function renderView(sim, tailScale, dt) {
  sim.tailScale = tailScale
  const hidden = tailScale < 0.5
  // The pose was frozen while hidden; re-aim the chain before it is drawn again.
  if (sim.tailsHidden && !hidden) {
    for (const cell of sim.cells) warmTail(sim, cell)
  }
  sim.tailsHidden = hidden
  for (const chunk of sim.tailChunks) {
    chunk.mesh.visible = !sim.tailsHidden && chunk.live > 0
  }
  sim.perf.begin('vis')
  updateVisibility(sim)
  sim.perf.end('vis')

  sim.perf.begin('bodies')
  renderBodies(sim)
  sim.perf.end('bodies')

  sim.perf.begin('aura')
  renderAura(sim)
  sim.perf.end('aura')

  sim.perf.begin('pops')
  updatePops(sim, dt)
  sim.perf.end('pops')

  sim.perf.begin('tails')
  sim.renderTails()
  sim.perf.end('tails')

  if (sim.controls) sim.controls.update()
  sim.perf.begin('draw')
  if (sim.renderer) sim.renderer.render(sim.scene, sim.camera)
  sim.perf.end('draw')
}
