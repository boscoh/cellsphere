import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SPHERE_RADIUS } from './constants'

export function createScene(container) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0e110b)
  scene.fog = new THREE.Fog(0x0e110b, 18, 34)

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  )
  camera.position.set(0, 5.5, 9)
  camera.lookAt(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  container.appendChild(renderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06

  scene.add(new THREE.AmbientLight(0xffffff, 0.5))

  // Key light hangs top-left and behind the viewer (directional, so zoom and
  // orbit do not change brightness), with a soft opposite fill for shape.
  scene.add(camera)
  const key = new THREE.DirectionalLight(0xe6eeff, 1.2)
  key.position.set(-8, 6, 12)
  camera.add(key)
  const rim = new THREE.DirectionalLight(0xffc6d8, 0.35)
  rim.position.set(7, -5, 10)
  camera.add(rim)

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
