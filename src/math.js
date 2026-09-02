import * as THREE from 'three'
import { SURFACE } from './constants'

export function randomUnitVector() {
  let v = new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
  )
  while (v.lengthSq() < 1e-6) {
    v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
  }
  return v.normalize()
}

export function randomSurfacePoint() {
  return randomUnitVector().multiplyScalar(SURFACE)
}

export function randomTangent(normal) {
  const v = randomUnitVector()
  const t = new THREE.Vector3().crossVectors(normal, v)
  if (t.lengthSq() < 1e-6) t.set(0, 1, 0)
  return t.normalize()
}

export function smoothstep(x) {
  x = THREE.MathUtils.clamp(x, 0, 1)
  return x * x * (3 - 2 * x)
}

export function cellIndex(cx, cy, cz) {
  return ((cx + 2048) * 4096 + (cy + 2048)) * 4096 + (cz + 2048)
}
