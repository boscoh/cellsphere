import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SPHERE_RADIUS } from './constants'

export function createScene(container) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a0d14)
  scene.fog = new THREE.Fog(0x0a0d14, 18, 34)

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

  scene.add(new THREE.AmbientLight(0xffffff, 0.45))
  const point = new THREE.PointLight(0x8ab6ff, 30, 40)
  point.position.set(0, 4, 6)
  scene.add(point)
  const rim = new THREE.PointLight(0xff8ab6, 14, 40)
  rim.position.set(-6, -3, -4)
  scene.add(rim)

  const sphereShell = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({
      color: 0x131a2a,
      side: THREE.FrontSide,
    }),
  )
  scene.add(sphereShell)

  return { scene, camera, renderer, controls, sphereShell }
}
