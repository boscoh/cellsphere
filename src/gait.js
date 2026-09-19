import { P, ENERGY_MAX } from './constants.js'

// Opt-in alternating locomotion (cell-d4z). Off when P.GAIT_MODE = 0, in which
// case the caller's drive/steer are left untouched. When on, a cell alternates
// a TURN phase (low forward drive, boosted steering -> a tight pivot) with a
// MOVE phase whose forward speed is set by a forward mode:
//   general - full drive, relaxed steer (go straight)
//   drift   - low drive (satiated coast), relaxed steer
//   eat     - grazed drive, steer unchanged (keep aiming at food)
// This is the windowed-pivot variant left untested in NOTES 1.5D (cell-1eo):
// the pivot is gated by a strong steering demand, not applied permanently.

export const GAIT_MOVE = 0
export const GAIT_TURN = 1

export const MODE_GENERAL = 0
export const MODE_DRIFT = 1
export const MODE_EAT = 2

function clampSteer(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

// Forward mode for the MOVE phase: in food contact -> slow eat; well fed and
// not eating -> drift; otherwise -> general. `d.slow` is set by
// food.concentration() and is < 1 only within the grazing radius.
export function pickGaitMode(d) {
  if (d.slow <= P.GAIT_EAT_SLOW) return MODE_EAT
  if (d.energy / ENERGY_MAX >= P.GAIT_DRIFT_FRAC) return MODE_DRIFT
  return MODE_GENERAL
}

// `d.steer` is the tail steering command already clamped to [-1, 1], so |steer|
// is the turn demand: how far off-target the cell is (chemotaxis or hunting).
export function updateGait(sim, d, dt) {
  if (!P.GAIT_MODE) return
  if (d.breed === 0 ? !P.GAIT_PREY : !P.GAIT_PRED) return
  if (d.paralysed || d.rest > 0 || d.detach) return
  if (d.target && d.target.paralysed) return

  const s = d.steer || 0
  const demand = s < 0 ? -s : s

  if (d.gait === GAIT_TURN) {
    d.gaitT += dt
    if (d.gaitForced) {
      // A random tumble turn runs for its full duration; a chemotactic turn
      // ends as soon as the heading is roughly on-target.
      if (d.gaitT >= P.GAIT_TURN_TIME) {
        d.gait = GAIT_MOVE
        d.gaitT = 0
        d.gaitForced = false
      }
    } else if (demand <= P.GAIT_TURN_OFF || d.gaitT >= P.GAIT_TURN_TIME) {
      d.gait = GAIT_MOVE
      d.gaitT = 0
    }
  } else {
    // Hold MOVE for a straight run, then re-align. A cell with no steering
    // demand (no target) never leaves MOVE, so it does not stutter — unless the
    // run-and-tumble timer is on, which tumbles a target-less cell to re-search.
    d.gaitT += dt
    const timedRealign = d.gaitT >= P.GAIT_MOVE_TIME && demand > P.GAIT_TURN_OFF
    const tumble =
      P.GAIT_TUMBLE > 0 && demand <= P.GAIT_TURN_OFF && d.gaitT >= P.GAIT_TUMBLE
    if (demand >= P.GAIT_TURN_ON || timedRealign || tumble) {
      d.gait = GAIT_TURN
      d.gaitT = 0
      if (tumble) {
        d.gaitForced = true
        d.gaitTurnDir = Math.random() < 0.5 ? -1 : 1
      }
    }
  }

  if (d.gait === GAIT_TURN) {
    d.gaitMode = MODE_GENERAL
    d.drive *= P.GAIT_TURN_DRIVE
    const cmd = d.gaitForced ? d.gaitTurnDir * P.GAIT_TUMBLE_STEER : s
    d.steer = clampSteer(cmd * P.GAIT_TURN_STEER)
    return
  }

  const mode = pickGaitMode(d)
  d.gaitMode = mode
  if (mode === MODE_EAT) {
    d.drive *= P.GAIT_EAT_DRIVE
  } else if (mode === MODE_DRIFT) {
    d.drive *= P.GAIT_DRIFT_DRIVE
    d.steer = clampSteer(s * P.GAIT_MOVE_STEER)
  } else {
    d.steer = clampSteer(s * P.GAIT_MOVE_STEER)
  }
}
