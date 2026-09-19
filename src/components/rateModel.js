import { P, ENERGY_MAX } from '../constants.js'

// Indicative Lotka-Volterra rate analogs for the current tuning knobs, all in
// 1/s. CellSphere is not closed LV (food is an explicit third variable and the
// functional response is ratio-dependent), so these are estimates derived from
// the shared energy currency ENERGY_MAX, not fitted values:
//
//   alpha  prey per-capita growth   (ABSORB_RATE - METABOLISM) / ENERGY_MAX
//   beta   effective attack         PRED_DRAIN * attack / ENERGY_MAX
//   delta  predator growth          PRED_DRAIN * PRED_EFF * attack / ENERGY_MAX
//   gamma  predator per-capita death (METABOLISM + PRED_METABOLISM) / ENERGY_MAX
//
// `attack` is the ratio-dependent response PRED_RATIO applies to a hunt, built
// from the live blue/red counts, so beta and delta fall when predators outnumber
// prey. PRED_RATIO = 0 disables it (attack = 1).
export function computeRates(blue = 0, red = 0) {
  const ratio = red > 0 ? blue / red : 0
  const attack = P.PRED_RATIO > 0 ? ratio / (ratio + P.PRED_RATIO) : 1
  return {
    attack,
    alpha: Math.max(0, P.ABSORB_RATE - P.METABOLISM) / ENERGY_MAX,
    beta: (P.PRED_DRAIN * attack) / ENERGY_MAX,
    delta: (P.PRED_DRAIN * P.PRED_EFF * attack) / ENERGY_MAX,
    gamma: (P.METABOLISM + P.PRED_METABOLISM) / ENERGY_MAX,
  }
}

// Small-oscillation period of the LV pair: T = 2*pi / sqrt(alpha*gamma), the part
// of the cycle timing that depends only on prey growth and predator death.
export function lvPeriod(alpha, gamma) {
  if (!(alpha > 0) || !(gamma > 0)) return null
  return (2 * Math.PI) / Math.sqrt(alpha * gamma)
}
