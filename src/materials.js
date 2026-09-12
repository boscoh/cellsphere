import * as THREE from 'three'

export const foodGeo = new THREE.SphereGeometry(0.05, 6, 6)
export const tailGeo = (() => {
  // Capless cylinder: neighbouring segments overlap, so the capsule end caps
  // were never visible. Height matches the old capsule's total extent.
  const geo = new THREE.CylinderGeometry(0.014, 0.014, 1, 6, 1, true)
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
    'attribute highp float instanceOpacity;\nattribute highp float instanceParalysed;\nvarying highp float vInstanceOpacity;\nvarying highp float vInstanceParalysed;\n' +
    shader.vertexShader
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\n\tvInstanceOpacity = instanceOpacity;\n\tvInstanceParalysed = instanceParalysed;'
  )
  shader.fragmentShader =
    'varying highp float vInstanceOpacity;\nvarying highp float vInstanceParalysed;\n' +
    shader.fragmentShader
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n\tdiffuseColor.a *= vInstanceOpacity;\n\tif (diffuseColor.a < 0.1) discard;'
  )
  // Predator-latched ("immobile") prey keeps the original purple fresnel rim.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\n\t{\n\t\tfloat rim = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);\n\t\ttotalEmissiveRadiance += vInstanceParalysed * rim * rim * vec3(0.55, 0.30, 0.95) * 1.4;\n\t}'
  )
}

export const foodMat = new THREE.MeshStandardMaterial({
  color: 0x56613c,
  emissive: 0x343d26,
  emissiveIntensity: 0.35,
  roughness: 0.7,
})

export const tailMat = new THREE.MeshLambertMaterial({
  color: 0xffffff,
  emissive: 0x1a1a24,
  emissiveIntensity: 0.6,
})

export function disposeSharedMaterials() {
  foodGeo.dispose()
  tailGeo.dispose()
  foodMat.dispose()
  tailMat.dispose()
}
