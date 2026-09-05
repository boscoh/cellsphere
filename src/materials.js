import * as THREE from 'three'

export const foodGeo = new THREE.SphereGeometry(0.05, 6, 6)
export const tailGeo = (() => {
  const geo = new THREE.CapsuleGeometry(0.014, 0.972, 2, 6)
  geo.rotateZ(Math.PI / 2)
  return geo
})()
export const nucleusGeo = new THREE.SphereGeometry(1, 12, 8)

export const bodyMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 1,
  metalness: 0,
  transparent: true,
  opacity: 0.9,
})

bodyMat.onBeforeCompile = (shader) => {
  shader.vertexShader =
    'attribute highp float instanceOpacity;\nattribute highp float instanceMito;\nvarying highp float vInstanceOpacity;\nvarying highp float vInstanceMito;\n' +
    shader.vertexShader
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\n\tvInstanceOpacity = instanceOpacity;\n\tvInstanceMito = instanceMito;'
  )
  shader.fragmentShader =
    'varying highp float vInstanceOpacity;\nvarying highp float vInstanceMito;\n' +
    shader.fragmentShader
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n\tdiffuseColor.a *= vInstanceOpacity;\n\tif (diffuseColor.a < 0.1) discard;'
  )
  // Mitosis aura: an emissive fresnel rim, stronger toward the silhouette,
  // scaled by the per-instance "ready to divide" value.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\n\t{\n\t\tfloat auraRim = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);\n\t\ttotalEmissiveRadiance += vInstanceMito * auraRim * auraRim * diffuseColor.rgb * 1.25;\n\t}'
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

export const nucleusMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 1,
  metalness: 0,
  emissive: 0x57c98c,
  emissiveIntensity: 0.6,
})

export function disposeSharedMaterials() {
  foodGeo.dispose()
  tailGeo.dispose()
  nucleusGeo.dispose()
  foodMat.dispose()
  tailMat.dispose()
  nucleusMat.dispose()
}
