import * as THREE from 'three'
import { ArcballControls } from 'three/addons/controls/ArcballControls.js'
import { P } from './constants.js'

// Scene graph and lighting are split so a headless View can build the scene,
// shell and lights-free core without a WebGL context; `attachGraphics` adds the
// camera, renderer, controls and lights that need a canvas.

export function createSceneCore() {
  const R = P.SPHERE_RADIUS
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0e110b)
  scene.fog = new THREE.Fog(0x0e110b, R * 3.6, R * 6.8)

  const sphereShell = new THREE.Mesh(
    new THREE.SphereGeometry(R, 32, 16),
    new THREE.MeshBasicMaterial({
      color: 0x1c2316,
      side: THREE.FrontSide,
    }),
  )
  scene.add(sphereShell)

  return { scene, sphereShell }
}

export function attachGraphics(scene, container) {
  const R = P.SPHERE_RADIUS

  // Frame the shell in the viewport area below the HUD bar: pull back far
  // enough that the whole sphere fits, and pivot slightly above its centre so
  // the silhouette sits below the top strip instead of under the HUD. All
  // distances scale with the radius so the framing survives a rebuild.
  const CAM_DIST = R * 2.8
  const CAM_ELEV = 0.55
  const PIVOT_Y = R * 0.14

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  )
  camera.position.set(
    0,
    Math.sin(CAM_ELEV) * CAM_DIST,
    Math.cos(CAM_ELEV) * CAM_DIST,
  )
  camera.lookAt(0, PIVOT_Y, 0)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  container.appendChild(renderer.domElement)

  // ArcballControls rotates by accumulating relative quaternion deltas (a
  // trackball), so unlike a spherical orbit there is no pole singularity to
  // lock at directly above/below the target. It takes the scene so its (hidden)
  // gizmo can be tracked.
  const controls = new ArcballControls(camera, renderer.domElement, scene)
  controls.target.set(0, PIVOT_Y, 0)
  controls.setGizmosVisible(false)
  controls.enableFocus = false
  controls.minDistance = R * 1.4
  controls.maxDistance = R * 5.6
  // Re-aim at the pivot now that the target is set (the constructor aims at the
  // origin), then seed the interaction state.
  controls.setCamera(camera)
  controls.update()

  scene.add(new THREE.AmbientLight(0xffffff, 0.55))

  // Key light hangs top-left and behind the viewer (directional, so zoom and
  // orbit do not change brightness), with a soft opposite fill for shape. A
  // low hemisphere light lifts the sheltered side so capsule bodies never go
  // near-black. Lights are parented to the camera so they follow the view.
  scene.add(camera)
  const key = new THREE.DirectionalLight(0xe6eeff, 1.1)
  key.position.set(-8, 6, 12)
  camera.add(key)
  const rim = new THREE.DirectionalLight(0xffc6d8, 0.4)
  rim.position.set(7, -5, 10)
  camera.add(rim)
  scene.add(new THREE.HemisphereLight(0xbfd0e2, 0x1a1e18, 0.45))

  return { camera, renderer, controls }
}

// Resizes the shell mesh after `P.SPHERE_RADIUS` changes (rebuild).
export function resizeSphereShell(shell) {
  shell.geometry.dispose()
  shell.geometry = new THREE.SphereGeometry(P.SPHERE_RADIUS, 32, 16)
}

// Scales the camera orbit and fog about the origin so the shell stays framed
// after a radius change; `ratio` is newRadius / oldRadius.
export function scaleSphereFraming(camera, controls, fog, ratio) {
  if (ratio === 1) return
  camera.position.multiplyScalar(ratio)
  controls.target.multiplyScalar(ratio)
  controls.minDistance *= ratio
  controls.maxDistance *= ratio
  if (fog) {
    fog.near *= ratio
    fog.far *= ratio
  }
  controls.update()
}
