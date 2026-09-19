import * as THREE from 'three'
import { P } from './constants.js'
import {
  createSceneCore,
  attachGraphics,
  resizeSphereShell,
  scaleSphereFraming,
} from './sceneSetup.js'
import { initBodyPools, disposeBodyPools, disposeBodyGeos } from './bodyPool.js'
import { disposeTailPool } from './tailPool.js'
import { ensureFoodMesh, disposeFoodMesh } from './foodRender.js'
import { initPops, disposePops } from './pops.js'
import { disposeGlowMaterial } from './glow.js'
import { disposeSharedMaterials } from './materials.js'
import { renderView, renderTails } from './render.js'

// The View owns everything the renderer needs: scene, camera, renderer,
// controls, lights and shell (via sceneSetup), the pooled body/tail meshes, the
// food and death-burst meshes, and the render-only scratch vectors. The
// Simulation owns only cell/food/pop data and the physics loop, so a headless
// Simulation can build and step with no View at all.
//
// A View can be constructed without a container (scene + meshes, no WebGL):
// `attach(container)` adds the camera/renderer/controls used by the browser.
export class View {
  constructor(sim) {
    this.sim = sim
    const { scene, sphereShell } = createSceneCore()
    this.scene = scene
    this.sphereShell = sphereShell
    this.camera = null
    this.renderer = null
    this.controls = null
    this._shellRadius = P.SPHERE_RADIUS
    this.tailScale = 1
    this.tailsHidden = false

    this.tailChunks = []
    this.foodMesh = null
    this.popGlow = null
    this._tailDirty = new Set()

    // Render-only scratch. Deliberately separate from the physics scratch on the
    // Simulation so the two phases can never alias.
    this._v1 = new THREE.Vector3()
    this._v2 = new THREE.Vector3()
    this._v3 = new THREE.Vector3()
    this._v4 = new THREE.Vector3()
    this._v5 = new THREE.Vector3()
    this._v9 = new THREE.Vector3()
    this._one = new THREE.Vector3(1, 1, 1)
    this._camDir = new THREE.Vector3()
    this._m = new THREE.Matrix4()
    this._dummy = new THREE.Object3D()

    initBodyPools(this)
    ensureFoodMesh(this)
    initPops(this)
  }

  attach(container) {
    const { camera, renderer, controls } = attachGraphics(this.scene, container)
    this.camera = camera
    this.renderer = renderer
    this.controls = controls
  }

  render(tailScale, dt) {
    renderView(this, tailScale, dt)
  }

  renderTails() {
    renderTails(this)
  }

  onResize() {
    if (!this.camera || !this.renderer) return
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  resizeShell() {
    if (P.SPHERE_RADIUS === this._shellRadius) return
    const ratio = P.SPHERE_RADIUS / this._shellRadius
    resizeSphereShell(this.sphereShell)
    if (this.camera && this.controls) {
      scaleSphereFraming(this.camera, this.controls, this.scene.fog, ratio)
    }
    this._shellRadius = P.SPHERE_RADIUS
  }

  // Tear down and re-create the pooled meshes for a world rebuild, keeping the
  // scene/renderer/camera (and so the canvas) alive.
  resetResources() {
    disposeBodyPools(this)
    disposeTailPool(this)
    disposeFoodMesh(this)
    disposePops(this)
    this._tailDirty.clear()
    initBodyPools(this)
    ensureFoodMesh(this)
    initPops(this)
  }

  dispose() {
    if (this.controls) this.controls.dispose()
    if (this.renderer) this.renderer.dispose()
    // Meshes and pooled geometry first, then the shared templates/materials they
    // reference, so nothing is disposed out from under a live draw call.
    disposeBodyPools(this)
    disposeTailPool(this)
    disposePops(this)
    disposeFoodMesh(this)
    if (this.sphereShell) {
      this.sphereShell.geometry.dispose()
      this.sphereShell.material.dispose()
    }
    disposeBodyGeos()
    disposeSharedMaterials()
    disposeGlowMaterial()
    if (this.renderer) this.renderer.domElement.remove()
  }
}
