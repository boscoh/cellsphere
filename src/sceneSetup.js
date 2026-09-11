import * as THREE from 'three'
import { ArcballControls } from 'three/addons/controls/ArcballControls.js'
import { SPHERE_RADIUS } from './constants'

export function createScene(container) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0e110b)
  scene.fog = new THREE.Fog(0x0e110b, 18, 34)

  // Frame the shell in the viewport area below the HUD bar: pull back far
  // enough that the whole sphere fits, and pivot slightly above its centre so
  // the silhouette sits below the top strip instead of under the HUD.
  const CAM_DIST = 14
  const CAM_ELEV = 0.55
  const PIVOT_Y = 0.7

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
  controls.minDistance = 7
  controls.maxDistance = 28
  // Re-aim at the pivot now that the target is set (the constructor aims at the
  // origin), then seed the interaction state.
  controls.setCamera(camera)
  controls.update()

  scene.add(new THREE.AmbientLight(0xffffff, 0.55))

  // Key light hangs top-left and behind the viewer (directional, so zoom and
  // orbit do not change brightness), with a soft opposite fill for shape. A
  // low hemisphere light lifts the sheltered side so capsule bodies never go
  // near-black.
  scene.add(camera)
  const key = new THREE.DirectionalLight(0xe6eeff, 1.1)
  key.position.set(-8, 6, 12)
  camera.add(key)
  const rim = new THREE.DirectionalLight(0xffc6d8, 0.4)
  rim.position.set(7, -5, 10)
  camera.add(rim)
  scene.add(new THREE.HemisphereLight(0xbfd0e2, 0x1a1e18, 0.45))

  const sphereShell = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({
      color: 0x1c2316,
      side: THREE.FrontSide,
    }),
  )
  scene.add(sphereShell)

  return { scene, camera, renderer, controls, sphereShell }
}
