import * as THREE from 'three'

export const foodGeo = new THREE.SphereGeometry(0.05, 6, 6)
export const tailGeo = (() => {
  const geo = new THREE.CapsuleGeometry(0.014, 0.972, 2, 6)
  geo.rotateZ(Math.PI / 2)
  return geo
})()

export const bodyMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 1,
  metalness: 0,
  transparent: true,
  opacity: 0.9,
})

bodyMat.onBeforeCompile = (shader) => {
  shader.vertexShader =
    'attribute highp float instanceOpacity;\nvarying highp float vInstanceOpacity;\n' +
    shader.vertexShader
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\n\tvInstanceOpacity = instanceOpacity;'
  )
  shader.fragmentShader =
    'varying highp float vInstanceOpacity;\n' + shader.fragmentShader
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n\tdiffuseColor.a *= vInstanceOpacity;\n\tif (diffuseColor.a < 0.1) discard;'
  )
}

export const foodMat = new THREE.MeshStandardMaterial({
  color: 0x56613c,
  emissive: 0x343d26,
  emissiveIntensity: 0.35,
  roughness: 0.7,
})

export const tailMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  emissive: 0x1a1a24,
  emissiveIntensity: 0.6,
  roughness: 0.5,
})

export function disposeSharedMaterials() {
  foodGeo.dispose()
  tailGeo.dispose()
  foodMat.dispose()
  tailMat.dispose()
}
