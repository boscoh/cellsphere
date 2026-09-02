import * as THREE from 'three'

export const unitOuterGeo = new THREE.SphereGeometry(1, 12, 8)
export const foodGeo = new THREE.SphereGeometry(0.05, 6, 6)
export const tailGeo = new THREE.SphereGeometry(0.004, 4, 4)

export const foodMat = new THREE.MeshStandardMaterial({
  color: 0x9a917e,
  emissive: 0x504b3e,
  emissiveIntensity: 0.3,
  roughness: 0.7,
})

export const tailMat = new THREE.MeshStandardMaterial({
  color: 0x8ae8c0,
  emissive: 0x1f8a5f,
  emissiveIntensity: 0.7,
  roughness: 0.5,
})

export const nucleusMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.3,
  emissive: 0x123c2a,
  emissiveIntensity: 0.4,
})

export function disposeSharedMaterials() {
  unitOuterGeo.dispose()
  foodGeo.dispose()
  tailGeo.dispose()
  foodMat.dispose()
  tailMat.dispose()
  nucleusMat.dispose()
}
