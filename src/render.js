import * as THREE from 'three'
import { SURFACE, CULL_COS, SPHERE_RADIUS, WIDTH } from './constants'
import { renderBodies, renderNuclei } from './cells'
import { bodyMat } from './materials'
import { cosFace, raySphereNear } from './math'

// View-layer options. Every branch is a conscious, reversible toggle so the
// pipeline can be bisected live and audited headlessly.
export const defaultRenderOptions = {
  drawShell: true,
  drawFood: true,
  drawTails: true,
  drawBodies: true,
  drawNuclei: true,
  cull: true, // far-side face culling (sideHidden)
  bodyDepthWrite: true, // bodies are transparent; depthWrite inherits this
  forceOpaqueBodies: false, // diagnostic: join the opaque pass (no sorting)
}

// signed distance (world units) from a cell's near surface to the shell's
// front surface along the camera ray to the cell centre. >0 means the cell
// is closer than the shell (visible); <0 means the shell occludes it; ~0 is
// the z-fighting band where bodies vanish near the limb. null = ray misses
// the shell (cell is on the near side, outside the silhouette).
export function bodyShellGap(pos, camPos, shellRadius, bodyRadius) {
  const dir = new THREE.Vector3(pos.x - camPos.x, pos.y - camPos.y, pos.z - camPos.z)
  const cellDist = dir.length()
  if (cellDist < 1e-6) return null
  dir.multiplyScalar(1 / cellDist)
  const shellNear = raySphereNear(camPos, dir, shellRadius)
  if (shellNear == null) return null
  return (cellDist - bodyRadius) - shellNear
}

function updateVisibility(sim) {
  if (!sim.camera) return
  const cam = sim.camera.position
  const camDir = sim._camDir.set(cam.x, cam.y, cam.z).normalize()
  for (const cell of sim.cells) {
    // Hide body + tail together whenever the opaque shell would eclipse the
    // body along the camera ray. A dot/CULL threshold culls only the far
    // hemisphere, leaving a band near the silhouette where the shell hides the
    // body but the tail still draws (the "tail with no body" artifact).
    let hidden = false
    if (sim.renderOptions.cull) {
      const gap = bodyShellGap(cell.pos, cam, SPHERE_RADIUS, WIDTH)
      hidden = gap != null && gap > 0
      if (!hidden && cosFace(cell.pos, camDir) <= CULL_COS) hidden = true
    }
    cell.sideHidden = hidden
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

  if (o.drawNuclei) renderNuclei(sim)

  if (o.drawTails) sim.renderTails()

  if (sim.controls) sim.controls.update()
  if (sim.renderer) sim.renderer.render(sim.scene, sim.camera)
}

// Headless audit: count cells in the z-fighting band vs occluded vs clear,
// for a camera at `dist` along direction `dir`.
export function auditShell(sim, camDir, dist = 14) {
  const o = sim.renderOptions
  const cam = new THREE.Vector3().copy(camDir).normalize().multiplyScalar(dist)
  let fight = 0
  let occluded = 0
  let clear = 0
  let inBand = 0
  for (const d of sim.cells) {
    const cos = cosFace(d.pos, camDir)
    if (cos <= CULL_COS) continue // culled either way
    const gap = bodyShellGap(d.pos, cam, SPHERE_RADIUS, 0.085)
    if (gap == null) {
      clear++
    } else if (gap < 0) {
      occluded++
    } else if (gap < 0.05) {
      fight++
    } else {
      clear++
    }
    if (cos < 0.25) inBand++
  }
  return { fight, occluded, clear, inBand, total: sim.cells.length }
}
