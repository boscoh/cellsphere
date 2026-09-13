import { createServer } from 'vite'

// Split the `tail` perf bucket into its two halves and report the cost of the
// cosmetic spring chain. updateTailPose is the expensive part (~15x control),
// so this exists to catch regressions in the per-joint redundancy work
// (cell-bjm) and to size future changes. Usage: node scripts/bench-tail.mjs
const DT = 1 / 60
const WARM = 400
const ITER = 400

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  const { Simulation } = await server.ssrLoadModule('/src/sim.js')
  const { updateTailControl, updateTailPose } = await server.ssrLoadModule(
    '/src/tail.js',
  )
  const { TAIL_SEGMENTS, TAIL_DYN_SUB } = await server.ssrLoadModule(
    '/src/constants.js',
  )

  const sim = new Simulation()
  sim.buildWorld()
  // Step into a steady state before timing: freshly built cells coast and
  // would flatter the numbers.
  for (let i = 0; i < 600; i++) sim.step(DT)
  const cells = sim.cells

  function time(fn) {
    for (let i = 0; i < WARM; i++) fn()
    const t0 = performance.now()
    for (let i = 0; i < ITER; i++) fn()
    return (performance.now() - t0) / ITER
  }

  const controlMs = time(() => {
    for (const d of cells) updateTailControl(sim, d, DT)
  })
  const poseMs = time(() => {
    for (const d of cells) updateTailPose(sim, d, DT)
  })
  const stepMs = time(() => sim.step(DT))

  console.log(`cells           ${cells.length}`)
  console.log(`TAIL_SEGMENTS   ${TAIL_SEGMENTS}`)
  console.log(`TAIL_DYN_SUB    ${TAIL_DYN_SUB}`)
  console.log(`control         ${controlMs.toFixed(3)} ms`)
  console.log(`pose            ${poseMs.toFixed(3)} ms`)
  console.log(`control+pose    ${(controlMs + poseMs).toFixed(3)} ms`)
  console.log(`sim.step (all)  ${stepMs.toFixed(3)} ms`)
  console.log(`pose share      ${((poseMs / stepMs) * 100).toFixed(1)}% of step`)
} finally {
  await server.close()
}
