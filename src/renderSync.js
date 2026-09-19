import {
  addBody,
  removeBody,
  rehomeBody,
  setInstanceColor,
  bodyBucket,
} from './bodyPool.js'
import {
  claimTailSlot,
  inheritTailSlot,
  releaseTail,
  setTailColor,
} from './tailPool.js'

// Render-owned slot lifecycle. Physics creates and destroys cells; this pass
// reconciles the pooled InstancedMeshes with the current cell list, so no
// physics module has to import a pool.
//
//   new cell (no body handle)            -> allocate body + tail
//   radius changed bucket                -> rehome body, refresh colours
//   `tailHeir` set (mitosis)              -> hand the parent's slot to the daughter
//   cell missing from `sim.cells`         -> free its handles (queued on sim.removed)
//
// The handle fields (`bodyBucket/bodyChunk/bodySlot`, `tailChunk/tailSlot`) are
// written here and read only by the render passes; physics never reads them.
export function syncCells(view) {
  const sim = view.sim
  const removed = sim.removed
  for (let i = 0; i < removed.length; i++) {
    removeBody(view, removed[i])
    releaseTail(view, removed[i])
  }
  removed.length = 0

  for (const d of sim.cells) {
    if (d.tailHeir) {
      inheritTailSlot(view, d.tailHeir, d)
      d.tailHeir = null
    }
    if (d.bodyBucket == null) {
      addBody(view, d, d.radius)
    } else if (bodyBucket(d.radius, d.width) !== d.bodyBucket) {
      rehomeBody(view, d, d.radius)
      setInstanceColor(view, d)
      setTailColor(view, d)
    }
    if (!d.noTail && d.tailChunk == null) claimTailSlot(view, d)
  }
}
