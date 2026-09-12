import * as THREE from 'three'

// A soft additive glow used for cell auras and death bursts. Each instance is a
// camera-facing quad: the vertex shader billboards it in view space, aligns its
// local X axis with the cell's projected body axis, and scales it by the
// per-instance half-length/half-width. The fragment shader turns the quad's
// local coords into an elliptical falloff, so the glow follows the capsule's
// shape and spreads into the space around the cell instead of tracing a rim.
const glowGeo = new THREE.PlaneGeometry(1, 1)

const glowMaterial = new THREE.ShaderMaterial({
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  vertexShader: `
    attribute float aHalfLen;
    attribute float aHalfWidth;
    attribute float aAlpha;
    attribute vec3 aColor;
    attribute vec3 aAxis;
    varying float vAlpha;
    varying vec3 vColor;
    varying vec2 vLocal;
    void main() {
      vAlpha = aAlpha;
      vColor = aColor;
      vec2 local = position.xy * 2.0;
      vLocal = local;
      vec2 ex = (modelViewMatrix * vec4(aAxis, 0.0)).xy;
      ex = dot(ex, ex) < 1e-6 ? vec2(1.0, 0.0) : normalize(ex);
      vec2 ey = vec2(-ex.y, ex.x);
      vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      center.xy += ex * (local.x * aHalfLen) + ey * (local.y * aHalfWidth);
      gl_Position = projectionMatrix * center;
    }
  `,
  fragmentShader: `
    varying float vAlpha;
    varying vec3 vColor;
    varying vec2 vLocal;
    void main() {
      // Full-strength core fading to nothing at the quad edge; the inner core
      // is hidden behind the body, so the visible halo stays bright.
      float falloff = smoothstep(1.0, 0.35, length(vLocal));
      gl_FragColor = vec4(vColor * falloff * vAlpha, 1.0);
      #include <colorspace_fragment>
    }
  `,
})

export function makeGlowMesh(capacity, renderOrder = 3) {
  const geo = glowGeo.clone()
  const halfLen = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity),
    1,
  )
  halfLen.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aHalfLen', halfLen)
  const halfWidth = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity),
    1,
  )
  halfWidth.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aHalfWidth', halfWidth)
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
  alpha.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aAlpha', alpha)
  const color = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3,
  )
  color.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aColor', color)
  const axis = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3,
  )
  axis.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aAxis', axis)
  const mesh = new THREE.InstancedMesh(geo, glowMaterial, capacity)
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.renderOrder = renderOrder
  return { mesh, geo, halfLen, halfWidth, alpha, color, axis }
}

export function disposeGlowMesh(entry) {
  entry.geo.dispose()
  entry.mesh.dispose()
}

export function disposeGlowMaterial() {
  glowGeo.dispose()
  glowMaterial.dispose()
}
