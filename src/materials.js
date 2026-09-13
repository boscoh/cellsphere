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
    'attribute highp float instanceParalysed;\nvarying highp float vInstanceParalysed;\n' +
    shader.vertexShader
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\n\tvInstanceParalysed = instanceParalysed;'
  )
  shader.fragmentShader =
    'varying highp float vInstanceParalysed;\n' +
    shader.fragmentShader
  // Predator-latched ("immobile") prey tints dark red at the rim. Mixing the
  // surface colour (rather than adding emissive) keeps the edge dark instead of
  // washing the green body out toward white.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\n\t{\n\t\tfloat ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);\n\t\tfloat rim = smoothstep(0.95, 0.5, ndv);\n\t\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.89, 0.18, 0.11), vInstanceParalysed * rim);\n\t}'
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

// Procedural tail segment: instead of a 16-float instance matrix per segment,
// the CPU uploads a compact basis (midpoint, axis X, up Y) + scale, and the
// vertex shader builds the transform. Z is derived from X x Y.
tailMat.onBeforeCompile = (shader) => {
  shader.vertexShader =
    'attribute vec3 aSegPos;\nattribute vec3 aSegX;\nattribute vec3 aSegY;\nattribute vec2 aSegScale;\n' +
    shader.vertexShader

  // Normals are in the segment's local (cylinder) frame; apply the inverse
  // scale of the basis. Scale can be 0 for collapsed/hidden segments.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <beginnormal_vertex>',
    `#include <beginnormal_vertex>
	vec3 aSegZ = normalize(cross(aSegX, aSegY));
	float aInvLen = 1.0 / max(aSegScale.x, 1e-5);
	float aInvRad = 1.0 / max(aSegScale.y, 1e-5);
	objectNormal = aSegX * (objectNormal.x * aInvLen)
		+ aSegY * (objectNormal.y * aInvRad)
		+ aSegZ * (objectNormal.z * aInvRad);`,
  )

  // The basis above already replaces the instance matrix, so skip its normal
  // path (which would divide by zero on the unused, all-zero instanceMatrix).
  shader.vertexShader = shader.vertexShader.replace(
    '#include <defaultnormal_vertex>',
    `vec3 transformedNormal = objectNormal;
	transformedNormal = normalMatrix * transformedNormal;
	#ifdef FLIP_SIDED
		transformedNormal = - transformedNormal;
	#endif`,
  )

  const transform =
    'aSegPos + aSegX * (transformed.x * aSegScale.x) + aSegY * (transformed.y * aSegScale.y) + aSegZ * (transformed.z * aSegScale.y)'

  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    `vec4 mvPosition = vec4( transformed, 1.0 );
	mvPosition.xyz = ${transform};
	mvPosition = modelViewMatrix * mvPosition;
	gl_Position = projectionMatrix * mvPosition;`,
  )

  shader.vertexShader = shader.vertexShader.replace(
    '#include <worldpos_vertex>',
    `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	worldPosition.xyz = ${transform};
	worldPosition = modelMatrix * worldPosition;
#endif`,
  )
}

export function disposeSharedMaterials() {
  foodGeo.dispose()
  tailGeo.dispose()
  foodMat.dispose()
  tailMat.dispose()
  bodyMat.dispose()
}
