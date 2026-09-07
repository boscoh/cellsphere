export const SPHERE_RADIUS = 5
export const SURFACE = SPHERE_RADIUS + 0.06
export const MAX_CELLS = 500
export const GRID = 0.35
export const CELL_GRID = 1.0
export const FIXED_DT = 1 / 60
export const MAX_STEPS = 200

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
  { key: 'PREY_COUNT', group: 'world', label: 'Prey (start)', desc: 'Number of prey (blue) cells spawned when the world is (re)built.', def: 50, min: 0, max: MAX_CELLS, step: 1, rebuild: true },
  { key: 'PRED_COUNT', group: 'world', label: 'Predators (start)', desc: 'Number of predator (red) cells spawned when the world is (re)built.', def: 50, min: 0, max: MAX_CELLS, step: 1, rebuild: true },
  { key: 'SIM_SPEED', group: 'world', label: 'Default speed', desc: 'Simulation speed applied on startup and when Default/Reset is pressed (1x = real time).', def: 1, min: 1, max: 10, step: 1 },
  { key: 'FOOD_COUNT', group: 'world', label: 'Initial food', desc: 'Total food particles spawned when the world is (re)built.', def: 7000, min: 500, max: 40000, step: 500, rebuild: true },
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
  { key: 'GRAZE_RATE', group: 'sensing', label: 'Graze rate', desc: 'Drive factor while well fed (lower = lazier drifting).', def: 0.01, min: 0, max: 1, step: 0.01 },
  { key: 'GRAZE_GAIN', group: 'sensing', label: 'Graze gain', desc: 'How quickly feeding drops drive toward the graze rate.', def: 6, min: 0, max: 40, step: 0.5 },
  { key: 'ENERGY_PER_FOOD', group: 'sensing', label: 'Energy / food', desc: 'Energy gained per food particle absorbed.', def: 0.05, min: 0.005, max: 0.4, step: 0.005 },
  { key: 'ABSORB_RATE', group: 'sensing', label: 'Absorb rate', desc: 'Max energy a cell can absorb per second (absorption is always rate-limited).', def: 0.1, min: 0.005, max: 1, step: 0.005 },
  { key: 'FOOD_RESPAWN', group: 'world', label: 'Food respawn', desc: 'Base seconds before an eaten food particle reappears.', def: 20, min: 0, max: 90, step: 0.5 },

  { key: 'MITO_TIME', group: 'mitosis', label: 'Mito time', desc: 'Duration (sim seconds) of the full division sequence.', def: 5, min: 1, max: 60, step: 1 },
  { key: 'MITO_HOLD', group: 'mitosis', label: 'Mito hold', desc: 'Fraction of mitosis before the parent starts fading.', def: 0.2, min: 0, max: 1, step: 0.05 },
  { key: 'MITO_FADE', group: 'mitosis', label: 'Mito fade', desc: 'Fraction of mitosis over which the parent fades out.', def: 0.4, min: 0.05, max: 1, step: 0.05 },
  { key: 'MITO_NEAR', group: 'mitosis', label: 'Mito near', desc: 'Starting separation (x half child length) as daughters form.', def: 2.1, min: 0.5, max: 6, step: 0.1 },
  { key: 'MITO_SEP', group: 'mitosis', label: 'Mito sep', desc: 'Final separation (x half child length) at division release.', def: 2.8, min: 0.5, max: 8, step: 0.1 },
  { key: 'MITO_REST', group: 'mitosis', label: 'Mito rest', desc: 'Coast (no-drive) seconds for daughters right after division.', def: 4, min: 0, max: 20, step: 0.5 },

  { key: 'METABOLISM', group: 'survival', label: 'Metabolism', desc: 'Energy drained per second while alive (0 = no drain).', def: 0.003, min: 0, max: 0.3, step: 0.0005 },
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

  { key: 'PRED_RANGE', group: 'predator', label: 'Predator range', desc: 'Latch distance to a blue (capsule gap).', def: 0.18, min: 0, max: 1, step: 0.01 },
  { key: 'PRED_BITE', group: 'predator', label: 'Predator bite', desc: 'Distance at which draining proceeds (>= range so a latched prey is bitten).', def: 0.18, min: 0, max: 0.5, step: 0.01 },
  { key: 'PRED_DRAIN', group: 'predator', label: 'Predator drain', desc: 'Blue energy drained per second.', def: 0.05, min: 0, max: 1, step: 0.005 },
  { key: 'PRED_EFF', group: 'predator', label: 'Predator yield', desc: 'Fraction of drained energy red gains.', def: 0.6, min: 0, max: 1, step: 0.05 },
  { key: 'PRED_DRIVE', group: 'predator', label: 'Predator drive', desc: 'Red speed multiplier (<1 = slower).', def: 0.7, min: 0, max: 1, step: 0.05 },
  { key: 'RED_SIZE', group: 'predator', label: 'Red size', desc: 'Red body size as a fraction of blue (0.5 = half size).', def: 0.5, min: 0.2, max: 1, step: 0.05 },
]

export const PARAMS = PARAM_DEFS.map((p) => ({ ...p, value: p.def }))
const byKey = new Map(PARAMS.map((p) => [p.key, p]))

export let SPRING
export let PREY_COUNT
export let PRED_COUNT
export let SIM_SPEED
export let FOOD_COUNT
export let FOOD_CLUMPS
export let FOOD_SCATTER
export let FOOD_CLUMP_WIDE
export let ENERGY_PER_FOOD
export let ABSORB_RATE
export let FOOD_RESPAWN
export let MITO_TIME
export let MITO_HOLD
export let MITO_FADE
export let MITO_NEAR
export let MITO_SEP
export let MITO_SLOW_FRAC
export let MITO_REST
export let METABOLISM
export let STARVE_SLOW
export let TAIL_LINK_FILL
export let TAIL_BODY
export let TAIL_OSC_FREQ
export let TAIL_WAVE
export let TAIL_CARRIER_RATE
export let TAIL_DRAG_K
export let TAIL_BEND_K
export let TAIL_CONTACT_D
export let TAIL_CONTACT_K
export let TAIL_MOTOR_K
export let TAIL_MOTOR_JOINTS
export let TAIL_TRAIL_RATE
export let TAIL_ARC_MAX
export let TAIL_RUDDER_GAIN
export let TAIL_ARC
export let TAIL_HINGE
export let TAIL_TURN
export let TAIL_LEN_K
export let TAIL_LEN_DAMP
export let TAIL_DAMP
export let THRUST
export let DRAG
export let GRAZE_RATE
export let GRAZE_GAIN
export let ANG_DRAG
export let STEER_GAIN
export let COLLISION_KICK
export let MAX_SPIN
export let PEAK_MIN
export let SENSE_BOOST
export let SENSE_PERIOD
export let PRED_RANGE
export let PRED_BITE
export let PRED_DRAIN
export let PRED_EFF
export let PRED_DRIVE
export let RED_SIZE

const setters = {
  SPRING: (v) => { SPRING = v },
  PREY_COUNT: (v) => { PREY_COUNT = v },
  PRED_COUNT: (v) => { PRED_COUNT = v },
  SIM_SPEED: (v) => { SIM_SPEED = v },
  FOOD_COUNT: (v) => { FOOD_COUNT = v },
  FOOD_CLUMPS: (v) => { FOOD_CLUMPS = v },
  FOOD_SCATTER: (v) => { FOOD_SCATTER = v },
  FOOD_CLUMP_WIDE: (v) => { FOOD_CLUMP_WIDE = v },
  ENERGY_PER_FOOD: (v) => { ENERGY_PER_FOOD = v },
  ABSORB_RATE: (v) => { ABSORB_RATE = v },
  FOOD_RESPAWN: (v) => { FOOD_RESPAWN = v },
  MITO_TIME: (v) => { MITO_TIME = v },
  MITO_HOLD: (v) => { MITO_HOLD = v },
  MITO_FADE: (v) => { MITO_FADE = v },
  MITO_NEAR: (v) => { MITO_NEAR = v },
  MITO_SEP: (v) => { MITO_SEP = v },
  MITO_SLOW_FRAC: (v) => { MITO_SLOW_FRAC = v },
  MITO_REST: (v) => { MITO_REST = v },
  METABOLISM: (v) => { METABOLISM = v },
  STARVE_SLOW: (v) => { STARVE_SLOW = v },
  TAIL_LINK_FILL: (v) => { TAIL_LINK_FILL = v },
  TAIL_BODY: (v) => { TAIL_BODY = v },
  TAIL_OSC_FREQ: (v) => { TAIL_OSC_FREQ = v },
  TAIL_WAVE: (v) => { TAIL_WAVE = v },
  TAIL_CARRIER_RATE: (v) => { TAIL_CARRIER_RATE = v },
  TAIL_DRAG_K: (v) => { TAIL_DRAG_K = v },
  TAIL_BEND_K: (v) => { TAIL_BEND_K = v },
  TAIL_CONTACT_D: (v) => { TAIL_CONTACT_D = v },
  TAIL_CONTACT_K: (v) => { TAIL_CONTACT_K = v },
  TAIL_MOTOR_K: (v) => { TAIL_MOTOR_K = v },
  TAIL_MOTOR_JOINTS: (v) => { TAIL_MOTOR_JOINTS = v },
  TAIL_TRAIL_RATE: (v) => { TAIL_TRAIL_RATE = v },
  TAIL_ARC_MAX: (v) => { TAIL_ARC_MAX = v },
  TAIL_RUDDER_GAIN: (v) => { TAIL_RUDDER_GAIN = v },
  TAIL_ARC: (v) => { TAIL_ARC = v },
  TAIL_HINGE: (v) => { TAIL_HINGE = v },
  TAIL_TURN: (v) => { TAIL_TURN = v },
  TAIL_LEN_K: (v) => { TAIL_LEN_K = v },
  TAIL_LEN_DAMP: (v) => { TAIL_LEN_DAMP = v },
  TAIL_DAMP: (v) => { TAIL_DAMP = v },
  THRUST: (v) => { THRUST = v },
  DRAG: (v) => { DRAG = v },
  GRAZE_RATE: (v) => { GRAZE_RATE = v },
  GRAZE_GAIN: (v) => { GRAZE_GAIN = v },
  ANG_DRAG: (v) => { ANG_DRAG = v },
  STEER_GAIN: (v) => { STEER_GAIN = v },
  COLLISION_KICK: (v) => { COLLISION_KICK = v },
  MAX_SPIN: (v) => { MAX_SPIN = v },
  PEAK_MIN: (v) => { PEAK_MIN = v },
  SENSE_BOOST: (v) => { SENSE_BOOST = v },
  SENSE_PERIOD: (v) => { SENSE_PERIOD = v },
  PRED_RANGE: (v) => { PRED_RANGE = v },
  PRED_BITE: (v) => { PRED_BITE = v },
  PRED_DRAIN: (v) => { PRED_DRAIN = v },
  PRED_EFF: (v) => { PRED_EFF = v },
  PRED_DRIVE: (v) => { PRED_DRIVE = v },
  RED_SIZE: (v) => { RED_SIZE = v },
}

for (const [key, set] of Object.entries(setters)) set(byKey.get(key).def)

export function setParam(key, value) {
  const p = byKey.get(key)
  if (!p) return
  const v = clamp(value, p.min, p.max)
  p.value = v
  setters[key](v)
}

export function resetParams() {
  for (const p of PARAMS) {
    p.value = p.def
    setters[p.key](p.def)
  }
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}
