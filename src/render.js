import { CULL_COS } from './constants.js'
import { renderBodies } from './bodyPool.js'
import { warmTail } from './tail.js'
import { initPops, updatePops } from './pops.js'
import { ensureFoodMesh, syncFood } from './foodRender.js'
import { placeTail } from './tailPool.js'
import { syncCells } from './renderSync.js'
import { cosFace } from './math.js'

// Render passes. All view resources (scene, pools, meshes, scratch) live on the
// View; cell/food/pop data lives on `view.sim`.

function updateVisibility(view) {
  if (!view.camera) return
  const cam = view.camera.position
  const camDir = view._camDir.set(cam.x, cam.y, cam.z).normalize()
  for (const cell of view.sim.cells) {
    // Hide a cell's TAIL once its surface stops facing the camera (far side):
    // its body is behind the opaque shell anyway, but the tail would poke past
    // the silhouette and read as an orphan "tail with no body". Bodies are never
    // culled — the shell occludes far ones on its own, and the pooled body
    // InstancedMeshes have frustumCulled disabled so a zoom-in can't drop them.
    cell.sideHidden = cosFace(cell.pos, camDir) <= CULL_COS
  }
}

export function renderTails(view) {
  const sim = view.sim
  const dirty = view._tailDirty
  dirty.clear()
  // Ranges only ever describe this frame's writes, so drop any left over from
  // advance-time clears (or from a frame where tails were hidden).
  for (const chunk of view.tailChunks) {
    for (const a of chunk.attrList) a.clearUpdateRanges()
  }
  if (view.tailsHidden) return
  for (const cell of sim.cells) {
    const chunk = placeTail(view, cell)
    if (chunk) dirty.add(chunk)
  }
  // One needsUpdate per attribute per touched chunk instead of per cell.
  for (const chunk of dirty) {
    for (const a of chunk.attrList) a.needsUpdate = true
  }
}

export function renderView(view, tailScale, dt) {
  const sim = view.sim
  // View resources are created lazily so a headless build stays render-free and
  // a reset/rebuild re-creates them on the next frame.
  ensureFoodMesh(view)
  syncFood(view)
  initPops(view)
  syncCells(view)
  view.tailScale = tailScale
  const hidden = tailScale < 0.5
  // The pose was frozen while hidden; re-aim the chain before it is drawn again.
  if (view.tailsHidden && !hidden) {
    for (const cell of sim.cells) warmTail(sim, cell)
  }
  view.tailsHidden = hidden
  for (const chunk of view.tailChunks) {
    chunk.mesh.visible = !view.tailsHidden && chunk.live > 0
  }
  sim.perf.begin('vis')
  updateVisibility(view)
  sim.perf.end('vis')

  sim.perf.begin('bodies')
  renderBodies(view)
  sim.perf.end('bodies')

  sim.perf.begin('pops')
  updatePops(view, dt)
  sim.perf.end('pops')

  sim.perf.begin('tails')
  renderTails(view)
  sim.perf.end('tails')

  if (view.controls) view.controls.update()
  sim.perf.begin('draw')
  if (view.renderer) view.renderer.render(view.scene, view.camera)
  sim.perf.end('draw')
}
