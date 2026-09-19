// Gap between the collision surface (`SURFACE`) and the sphere shell mesh.
export const SHELL_GAP = 0.06
export const MAX_CELLS = 500
export const GRID = 0.35
// Per-particle food radius range; the max feeds the sense-scan radius so the
// bucket cube always covers a cell's full reach (cell-qjo.1).
export const FOOD_RADIUS_MIN = 0.016
export const FOOD_RADIUS_MAX = 0.04
export const CELL_GRID = 1.0
export const FIXED_DT = 1 / 60
export const MAX_STEPS = 200

// Host/UI limits: the HUD speed slider cap and the population chart history.
export const MAX_SIM_RATE = 50
export const POP_SAMPLES = 1200
// Sim-time spacing between population-history samples. Fixed regardless of
// simRate so the charts span a constant sim-time window and the finite-
// difference rates stay smooth when running fast.
export const SAMPLE_DT = 0.5

// Pools grow on demand in fixed-size chunks rather than sizing every buffer to
// MAX_CELLS up-front, so memory/upload scale with the high-water mark of
// concurrent cells, not the ceiling (cell-8jl).
export const TAIL_CHUNK_CELLS = 64
export const BODY_CHUNK_CELLS = 64

export const MIN_RADIUS = 0.10
export const MAX_RADIUS = 0.30
export const START_RADIUS = 0.13
export const WIDTH = 0.085
export const ENERGY_MAX = 1.0

export const TAIL_LINK = 0.05
export const TAIL_SEGMENTS = Math.round((1.5 * MAX_RADIUS) / TAIL_LINK)
export const TAIL_MOTOR_AMP = Math.PI * (40 / 360)
export const TAIL_DYN_SUB = 4
export const CULL_COS = 0

export const GROUPS = [
  { key: 'world', label: 'World' },
  { key: 'movement', label: 'Movement' },
  { key: 'collision', label: 'Collision' },
  { key: 'sensing', label: 'Sensing & Feeding' },
  { key: 'mitosis', label: 'Mitosis' },
  { key: 'survival', label: 'Survival' },
  { key: 'tail', label: 'Tail' },
  { key: 'predator', label: 'Predator' },
]

export const PARAM_DEFS = [
  { key: 'SPHERE_RADIUS', group: 'world', label: 'Sphere radius', desc: 'Radius of the sphere cells live on (rebuilds). Larger = more surface area, so a fixed-size cell looks smaller relative to the world.', def: 5, min: 3, max: 12, step: 0.5, rebuild: true },
  { key: 'PREY_COUNT', group: 'world', label: 'Prey (start)', desc: 'Number of prey (blue) cells spawned when the world is (re)built.', def: 50, min: 0, max: MAX_CELLS, step: 1, rebuild: true },
  { key: 'PRED_COUNT', group: 'world', label: 'Predators (start)', desc: 'Number of predator (red) cells spawned when the world is (re)built.', def: 15, min: 0, max: MAX_CELLS, step: 1, rebuild: true },
  { key: 'SIM_SPEED', group: 'world', label: 'Default speed', desc: 'Simulation speed applied on startup and when Default/Reset is pressed (1x = real time).', def: 1, min: 1, max: MAX_SIM_RATE, step: 1 },
  { key: 'FOOD_COUNT', group: 'world', label: 'Initial food', desc: 'Total food particles spawned when the world is (re)built.', def: 3000, min: 500, max: 40000, step: 500, rebuild: true },
  { key: 'FOOD_CLUMPS', group: 'world', label: 'Food clumps', desc: 'Number of food clusters (0 = none; rebuilds).', def: 12, min: 0, max: 80, step: 1, rebuild: true },
  { key: 'FOOD_SCATTER', group: 'world', label: 'Food scatter', desc: 'Share of food placed uniformly instead of in clumps (rebuilds).', def: 0.15, min: 0, max: 1, step: 0.05, rebuild: true },
  { key: 'FOOD_CLUMP_WIDE', group: 'world', label: 'Clump spread', desc: 'Angular spread of each clump (rebuilds).', def: 1, min: 0.2, max: 4, step: 0.1, rebuild: true },
  { key: 'THRUST', group: 'movement', label: 'Thrust', desc: 'Forward acceleration along the heading, scaled by drive (0..1).', def: 12, min: 0, max: 40, step: 0.5 },
  { key: 'DRAG', group: 'movement', label: 'Drag', desc: 'Velocity damping rate (1/s) resisting cell motion.', def: 22, min: 0, max: 60, step: 0.5 },
  { key: 'ANG_DRAG', group: 'movement', label: 'Angular drag', desc: 'Heading-rate damping (1/s); matches linear DRAG so turns stop as fast as translation.', def: 22, min: 0, max: 60, step: 0.5 },
  { key: 'MAX_SPIN', group: 'movement', label: 'Max spin', desc: 'Hard cap on turning rate (rad/s).', def: 2, min: 0, max: 12, step: 0.1 },
  { key: 'STEER_GAIN', group: 'movement', label: 'Steer gain', desc: 'Maps the food-gradient angle into a tail steering command (-1..1).', def: 0.5, min: 0, max: 3, step: 0.05 },
  { key: 'COLLISION_KICK', group: 'movement', label: 'Collision kick', desc: 'Strength of the heading deflection when cells collide.', def: 0.5, min: 0, max: 2, step: 0.05 },
  { key: 'MITO_SLOW_FRAC', group: 'movement', label: 'Mito slow frac', desc: 'Energy fraction above which a cell begins coasting toward mitosis (keeps seeking food until just before dividing).', def: 0.9, min: 0.05, max: 0.99, step: 0.01 },
  { key: 'PEAK_MIN', group: 'movement', label: 'Steer peak min', desc: 'Minimum gradient sharpness required before chemotaxis steers.', def: 0.18, min: 0, max: 1, step: 0.01 },

  { key: 'SPRING', group: 'collision', label: 'Spring', desc: 'Stiffness of the soft cell-cell collision response.', def: 22, min: 0, max: 100, step: 1 },

  { key: 'SENSE_BOOST', group: 'sensing', label: 'Sense boost', desc: 'Extra sensing reach added to the body radius.', def: 0.25, min: 0, max: 2, step: 0.05 },
  { key: 'SENSE_PERIOD', group: 'sensing', label: 'Sense period', desc: 'Seconds between chemotaxis sampling passes.', def: 0.05, min: 0.01, max: 1, step: 0.01 },
  { key: 'SENSE_MODE', group: 'sensing', label: 'Sense mode', desc: '0 = per-spec food scan, 1 = clump-attractor sensing (Tier-2 prototype, cell-qjo.5).', def: 0, min: 0, max: 1, step: 1 },
  { key: 'GRAZE_RATE', group: 'sensing', label: 'Graze rate', desc: 'Drive factor while well fed (lower = lazier drifting).', def: 0.01, min: 0, max: 1, step: 0.01 },
  { key: 'GRAZE_GAIN', group: 'sensing', label: 'Graze gain', desc: 'How quickly feeding drops drive toward the graze rate.', def: 6, min: 0, max: 40, step: 0.5 },
  { key: 'GRAZE_RADIUS', group: 'sensing', label: 'Graze radius', desc: 'Extra radius beyond body width within which food slows the cell (drive); the wider SENSE_BOOST range only steers. At SENSE_BOOST this reproduces the original all-range slowdown; lowering it keeps speed until closer to food, but speeds up the whole ecology and increases predator/prey oscillation (cell-11i).', def: 0.25, min: 0, max: 0.5, step: 0.01 },
  { key: 'FORAGE_TURN', group: 'sensing', label: 'Forage turn', desc: 'Extra heading-rate gain toward the food gradient during the post-division forage window (cell-x93).', def: 20, min: 0, max: 60, step: 1 },
  { key: 'ENERGY_PER_FOOD', group: 'sensing', label: 'Energy / food', desc: 'Energy gained per food particle absorbed.', def: 0.05, min: 0.005, max: 0.4, step: 0.005 },
  { key: 'ABSORB_RATE', group: 'sensing', label: 'Absorb rate', desc: 'Max energy a cell can absorb per second (absorption is always rate-limited).', def: 0.1, min: 0.005, max: 1, step: 0.005 },
  { key: 'FOOD_RESPAWN', group: 'world', label: 'Food respawn', desc: 'Base seconds before an eaten food particle reappears.', def: 40, min: 0, max: 180, step: 0.5 },

  { key: 'MITO_TIME', group: 'mitosis', label: 'Mito time', desc: 'Duration (sim seconds) of the full division sequence.', def: 5, min: 1, max: 60, step: 1 },
  { key: 'MITO_HOLD', group: 'mitosis', label: 'Mito hold', desc: 'Fraction of mitosis before the parent starts fading.', def: 0.2, min: 0, max: 1, step: 0.05 },
  { key: 'MITO_FADE', group: 'mitosis', label: 'Mito fade', desc: 'Fraction of mitosis over which the parent fades out.', def: 0.4, min: 0.05, max: 1, step: 0.05 },
  { key: 'MITO_NEAR', group: 'mitosis', label: 'Mito near', desc: 'Starting separation (x half child length) as daughters form.', def: 2.1, min: 0.5, max: 6, step: 0.1 },
  { key: 'MITO_SEP', group: 'mitosis', label: 'Mito sep', desc: 'Final separation (x half child length) at division release.', def: 2.8, min: 0.5, max: 8, step: 0.1 },
  { key: 'MITO_DETACH', group: 'mitosis', label: 'Mito detach', desc: 'Seconds a feeding predator spends separating from its prey before it can divide.', def: 0.8, min: 0, max: 10, step: 0.1 },
  { key: 'MITO_REST', group: 'mitosis', label: 'Mito rest', desc: 'Coast (no-drive) seconds for daughters right after division.', def: 4, min: 0, max: 20, step: 0.5 },
  { key: 'MITO_FORAGE', group: 'mitosis', label: 'Mito forage', desc: 'Seconds after division during which a daughter ignores the grazing slowdown and turns hard toward sensed food, so it can leave the parent spot on its own heading (cell-x93).', def: 6, min: 0, max: 20, step: 0.5 },

  { key: 'METABOLISM', group: 'survival', label: 'Metabolism', desc: 'Energy drained per second while alive (0 = no drain).', def: 0.0015, min: 0, max: 0.3, step: 0.0005 },
  { key: 'MOVE_COST', group: 'survival', label: 'Move cost', desc: 'Extra energy drained per second at full drive (scales with swimming effort).', def: 0.001, min: 0, max: 0.1, step: 0.0005 },
  { key: 'TURN_COST', group: 'survival', label: 'Turn cost', desc: 'Extra energy drained per second at full spin (scales with turning effort).', def: 0.001, min: 0, max: 0.1, step: 0.0005 },
  { key: 'STARVE_SLOW', group: 'survival', label: 'Starve slow frac', desc: 'Energy fraction below which a starving cell progressively slows (0 = no slowdown).', def: 0.3, min: 0, max: 1, step: 0.05 },

  { key: 'TAIL_OSC_FREQ', group: 'tail', label: 'Osc freq', desc: 'Tail wave frequency (Hz) while driving or turning.', def: 4, min: 0, max: 20, step: 0.5 },
  { key: 'TAIL_WAVE', group: 'tail', label: 'Wave shift', desc: 'Phase shift per joint (rad). Positive travels base->tip, negative travels tip->base.', def: 0.35, min: -2, max: 2, step: 0.05 },
  { key: 'TAIL_CARRIER_RATE', group: 'tail', label: 'Carrier rate', desc: 'Rate the tail axis re-aims toward the body heading.', def: 2, min: 0.1, max: 10, step: 0.1 },
  { key: 'TAIL_DRAG_K', group: 'tail', label: 'Drag K', desc: 'Guide-spring stiffness along the tail (higher = the whole chain follows the wave, less drag lag).', def: 25, min: 0, max: 60, step: 1 },
  { key: 'TAIL_MOTOR_K', group: 'tail', label: 'Motor K', desc: 'Guide stiffness at the root motor joints (whip).', def: 2200, min: 0, max: 8000, step: 100 },
  { key: 'TAIL_MOTOR_JOINTS', group: 'tail', label: 'Motor joints', desc: 'Number of root joints driven by the head motor.', def: 3, min: 0, max: 10, step: 1 },
  { key: 'TAIL_BEND_K', group: 'tail', label: 'Bend K', desc: 'Local beam stiffness resisting tail curvature.', def: 900, min: 0, max: 5000, step: 50 },
  { key: 'TAIL_LEN_K', group: 'tail', label: 'Length K', desc: 'Spring keeping adjacent joints at the link spacing.', def: 4000, min: 0, max: 12000, step: 200 },
  { key: 'TAIL_LEN_DAMP', group: 'tail', label: 'Length damp', desc: 'Damping of the tail length-spring oscillation.', def: 90, min: 0, max: 500, step: 10 },
  { key: 'TAIL_DAMP', group: 'tail', label: 'Joint damp', desc: 'Velocity damping applied to tail joints per substep.', def: 1.2, min: 0.1, max: 5, step: 0.05 },
  { key: 'TAIL_CONTACT_D', group: 'tail', label: 'Contact dist', desc: 'Contact distance for tail self-avoidance.', def: 0.04, min: 0, max: 0.2, step: 0.005 },
  { key: 'TAIL_CONTACT_K', group: 'tail', label: 'Contact K', desc: 'Self-avoidance push strength on contact.', def: 400, min: 0, max: 3000, step: 50 },
  { key: 'TAIL_TRAIL_RATE', group: 'tail', label: 'Trail rate', desc: 'How fast tail-lag memory decays after turns.', def: 1, min: 0.1, max: 5, step: 0.1 },
  { key: 'TAIL_ARC_MAX', group: 'tail', label: 'Arc max', desc: 'Hard cap (rad) on the trailing arc bend.', def: 2, min: 0, max: 4, step: 0.1 },
  { key: 'TAIL_RUDDER_GAIN', group: 'tail', label: 'Rudder gain', desc: 'Maps accumulated heading turn into the arc bend.', def: 1, min: 0, max: 4, step: 0.1 },
  { key: 'TAIL_ARC', group: 'tail', label: 'Trailing arc', desc: '0 = no trailing arc (pure travelling wave), 1 = arc on.', def: 1, min: 0, max: 1, step: 1 },
  { key: 'TAIL_HINGE', group: 'tail', label: 'Hinge', desc: 'How far the tail hinge tucks into the body (fraction of body width; 0 = rear tip, 1 = deepest).', def: 0.5, min: 0, max: 1, step: 0.05 },
  { key: 'TAIL_TURN', group: 'tail', label: 'Tail turn', desc: 'Heading-rate gain from the tail steering bend (tail drives the turn).', def: 2.5, min: 0, max: 10, step: 0.25 },
  { key: 'TAIL_LINK_FILL', group: 'tail', label: 'Link fill', desc: 'Fraction of link spacing covered by each segment mesh.', def: 0.95, min: 0.1, max: 1.5, step: 0.05 },
  { key: 'TAIL_BODY', group: 'tail', label: 'Tail length', desc: 'Total tail length as a multiple of body length.', def: 2, min: 1, max: 6, step: 0.25 },
  { key: 'TAIL_MODE', group: 'tail', label: 'Kinematic mode', desc: '0 = spring-chain tail, 1 = force-rotated rigid root + kinematic follow.', def: 0, min: 0, max: 1, step: 1 },
  { key: 'TAIL_FOLLOW_RATE', group: 'tail', label: 'Kinematic follow', desc: 'Kinematic mode: rate each free joint aligns to the segment ahead (higher = stiffer/rod-like).', def: 15, min: 2, max: 80, step: 1 },

  { key: 'PRED_RANGE', group: 'predator', label: 'Predator range', desc: 'Latch distance to a blue (capsule gap).', def: 0.18, min: 0, max: 1, step: 0.01 },
  { key: 'PRED_SENSE', group: 'predator', label: 'Predator sense', desc: 'Distance over which a red smells prey; nearby blues are weighted into a gradient direction.', def: 1.5, min: 0, max: 5, step: 0.1 },
  { key: 'PRED_BITE', group: 'predator', label: 'Predator bite', desc: 'Distance at which draining proceeds (>= range so a latched prey is bitten).', def: 0.18, min: 0, max: 0.5, step: 0.01 },
  { key: 'PRED_OVERLAP', group: 'predator', label: 'Predator overlap', desc: 'How far a feeding predator sinks into its latched prey (contact distance minus this).', def: 0.03, min: 0, max: 0.12, step: 0.005 },
  { key: 'PRED_DRAIN', group: 'predator', label: 'Predator drain', desc: 'Blue energy drained per second. Raised from 0.012 so a red eats faster and the red curve briefly overshoots the blue curve (NOTES 1.5C).', def: 0.02, min: 0, max: 1, step: 0.001 },
  { key: 'PRED_EFF', group: 'predator', label: 'Predator growth', desc: 'Energy red gains per second as a multiple of the drain (1 = matches the drain); also sets how fast reds divide.', def: 1, min: 0, max: 4, step: 0.1 },
  { key: 'PRED_METABOLISM', group: 'predator', label: 'Predator metabolism', desc: 'Extra energy per second a red burns while it has no prey latched, so unfed predators die quickly.', def: 0.001, min: 0, max: 0.3, step: 0.001 },
  { key: 'PRED_DRIVE', group: 'predator', label: 'Predator drive', desc: 'Red speed multiplier (<1 = slower).', def: 0.9, min: 0, max: 1, step: 0.05 },
  { key: 'PRED_LUNGE', group: 'predator', label: 'Predator lunge', desc: 'Distance (capsule gap) within which a red bursts forward; farther out it coasts (ambush).', def: 0.6, min: 0, max: 3, step: 0.05 },
  { key: 'PRED_COAST', group: 'predator', label: 'Predator coast', desc: 'Drive multiplier while no prey is within PRED_LUNGE (1 = no ambush, 0 = full stop).', def: 0.35, min: 0, max: 1, step: 0.05 },
  { key: 'PRED_FOCUS', group: 'predator', label: 'Prey focus', desc: 'Exponent on the prey-proximity weight (1 = linear; higher focuses the gradient on the nearest prey).', def: 1, min: 0.5, max: 4, step: 0.5 },
  { key: 'PRED_REORIENT', group: 'predator', label: 'Reorient time', desc: 'Seconds after finishing a meal that a red steers at the nearest prey and ignores both the ambush coast and the energy coast (0 = off).', def: 1.5, min: 0, max: 2, step: 0.05 },
  { key: 'REORIENT_TURN', group: 'predator', label: 'Reorient turn', desc: 'Extra heading-rate gain toward the nearest prey during the post-meal reorient window (cell-700).', def: 20, min: 0, max: 60, step: 1 },
  { key: 'PRED_HUNT', group: 'predator', label: 'Hunt window', desc: 'Seconds after a red newly smells prey that it turns hard at the nearest blue. Event-limited like the post-meal window, so it re-aims instead of arcing without making reds permanently agile (cell-zby).', def: 1, min: 0, max: 5, step: 0.1 },
  { key: 'PRED_TURN_SLOW', group: 'predator', label: 'Turn-phase throttle', desc: 'How much a red throttles back while its heading is off the nearest prey: drive *= 1 - PRED_TURN_SLOW*(1-cos(error))/2. Higher = tighter pivot turns but slower hunting (cell-1eo).', def: 0, min: 0, max: 1, step: 0.05 },
  { key: 'PRED_RATIO', group: 'predator', label: 'Ratio half-saturation', desc: 'Prey-per-predator ratio at which a red hunts at half strength (ratio-dependent response); lower = weaker suppression so reds can overshoot blue before starving; 0 = off (overshoot then collapse). Lowered 1 to 0.75 so a transient red > blue overshoot appears while 1800 s runs still survive.', def: 0.75, min: 0, max: 20, step: 0.25 },
  { key: 'PRED_CROWD', group: 'predator', label: 'Clump feast', desc: 'Extra drain per additional prey packed within PRED_SENSE: rate *= 1 + PRED_CROWD*(nearby-1). 0 = a clump is not a feast; higher = a shoal feeds a red faster (cell-3bz).', def: 0, min: 0, max: 3, step: 0.1 },
  { key: 'PRED_T3_HALF', group: 'predator', label: 'Type III half-density', desc: 'Prey visible within PRED_SENSE at which a red bites at half its full rate. The bite scales as a smooth sigmoid (Hill, exponent 2) in local prey count, so one lone blue is hard to catch while a shoal is easy: a continuous rare-prey refuge that can stand in for the hard stop-hunting gate. 0 = off (Type II, density-independent bite).', def: 0, min: 0, max: 20, step: 0.5 },
  { key: 'RED_SIZE', group: 'predator', label: 'Red size', desc: 'Red body size as a fraction of blue (0.5 = half size).', def: 0.5, min: 0.2, max: 1, step: 0.01 },
]

// Every parameter value lives in this one mutable record. There is deliberately
// no parallel list of exported bindings and setters: consumers read `P.THRUST`
// and the Tuner writes through `setParam`, so adding a parameter means editing
// PARAM_DEFS alone.
export const P = {}
for (const p of PARAM_DEFS) P[p.key] = p.def

// Derived from `P.SPHERE_RADIUS` and kept in sync by `setParam`/`resetParams`,
// so the many physics modules can keep importing `SURFACE` as a live binding.
export let SURFACE = P.SPHERE_RADIUS + SHELL_GAP

const byKey = new Map(PARAM_DEFS.map((p) => [p.key, p]))

export function setParam(key, value) {
  const p = byKey.get(key)
  if (!p) return
  P[key] = clamp(value, p.min, p.max)
  if (key === 'SPHERE_RADIUS') SURFACE = P.SPHERE_RADIUS + SHELL_GAP
}

export function resetParams() {
  for (const p of PARAM_DEFS) P[p.key] = p.def
  SURFACE = P.SPHERE_RADIUS + SHELL_GAP
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}
