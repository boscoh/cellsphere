# Predator–Prey — Exploration & Balance

> **Status:** exploration + tuning (2026-09). Beads `cell-v9d` (predator energy
> economy, closed) and `cell-dmd` (prey–predator coupling). Companion design doc:
> `docs/PREY_PREDATOR.md`. Function names are cited rather than line numbers,
> which move; food/predator constants are in `src/constants.js`.

The two questions that drove this work:

1. Why do predators (red, breed 1) die so quickly, and why don't they thrive and
   reproduce when they come upon a clump of prey?
2. Can predators eat prey **without wiping them out**, so predator numbers fall
   as prey fall — a self-regulating cycle rather than a boom-bust?

## Headline finding

**Ratio-dependent predation + a prey carrying capacity produces a sustained,
bounded predator–prey cycle.** With `FOOD_COUNT 3000` and `PRED_RATIO 1`, reds
and blues oscillate for hours with no extinction and no artificial population
floor:

| run (3600s) | seed | blue | red |
|---|---|---|---|
| `FOOD_COUNT 3000`, `PRED_RATIO 1` | 1 | 20..91 | 7..48 |
| " | 2 | 28..200 | 7..113 |
| + `PRED_HANDLE 20` | 1 | 19..93 | 8..56 |
| + `PRED_HANDLE 20` | 2 | 22..175 | 6..97 |

Shipped defaults (2026-09): **`FOOD_COUNT = 3000`**, **`PRED_RATIO = 1`**. Reds
lag blues by a quarter-cycle: as prey drop, predators starve and drop; as prey
recover, predators follow. This is the negative feedback the model was missing.

Why it needs **both**: scarce food gives prey a ceiling to cycle against, and
the ratio-dependent attack makes a red's per-capita kill rate fall as predators
come to outnumber prey, so the last few prey get a refuge *emergently*. Neither
mechanism alone is enough (see §4).

## TL;DR

- **Reds have no fallback food** — `eatAndRespawn`/`concentration` skip
  `breed === 1`, so a red's only energy is a blue it drains.
- **Original reds starved** because idle burn (~0.007/s) exceeded realistic
  intake and they were slower than fleeing blues. Fixed by retuning `PRED_DRAIN`,
  `PRED_METABOLISM`, `PRED_DRIVE` (`cell-v9d`).
- **A clump of prey does not raise a red's intake rate** — a red holds exactly
  one target and drains at a fixed `PRED_DRAIN`; a clump only shortens the
  search between kills.
- **Long runs still went extinct** (boom-bust) because intake saturates at one
  target per red, so total kill rate scales with *predator* count — the paradox
  of enrichment.
- **Candidate stabilisers tested:** prey-growth tuning, a global refuge counter
  (rejected as artificial), local Type III threshold, predator interference,
  handling time, crowding cost, ratio-dependent predation.
- **Winner:** ratio-dependent predation (`PRED_RATIO`) + scarce prey
  (`FOOD_COUNT 3000`). The others delay or suppress but do not produce a clean
  bounded cycle.
- `PRED_EFF > 1` (energy creation) is the single most destabilising knob — it
  always ends in prey wipeout.

## 1. Model overview

- **Latch:** a red scans the cell grid for the nearest valid blue within
  `PRED_RANGE`, stores it as `red.target`, and re-latches while within
  `PRED_RANGE × 1.6` (`predation`, `src/predator.js`).
- **Immobilise:** within `PRED_RANGE` the blue is `paralysed`; `sim.advance`
  forces `drive = 0`, zeros the heading rate, and hard-decays velocity. Latched
  prey glow purple (`instanceParalysed`).
- **Drain / gain:** within `PRED_BITE`, `drainEnergy(blue, PRED_DRAIN·dt)` and
  `gainEnergy(red, PRED_DRAIN·dt·PRED_EFF)`.
- **Hold still:** while it has a paralysed target, the red's own drive is 0.
- **Sensing:** `predatorSense` sums proximity-weighted directions to blues
  within `PRED_SENSE` into `preyDir`/`preyAmt`, and stores the raw sum as
  `preyDensity` (used by the Type III option).
- **Energy:** one `d.energy` drives size via `radiusFromEnergy`. Eating prey
  grows the red; at `ENERGY_MAX` it divides; at 0 it fades and dies.
  `updateEnergy` burns `METABOLISM` plus `PRED_METABOLISM` when a red has no
  target, plus locomotion and (optionally) crowding costs.
- **No food:** reds are skipped by both food sensing and eating.

## 2. Finding A — reds starved before they could reproduce (`cell-v9d`)

### 2.1 Energy budget

A red with no target burned `METABOLISM (0.0015) + PRED_METABOLISM (0.005) +
MOVE_COST × drive ≈ 0.007/s`, while it gained only `PRED_DRAIN × PRED_EFF =
0.008/s` while biting. Reds start at only ~0.22–0.34 energy, so an unfed red
starved in ~30–47s. Reaching `ENERGY_MAX` needed ~115s of *continuous* biting.

### 2.2 Small, slow meals and no speed advantage

`PRED_DRAIN = 0.008/s` drained a typical 0.15-energy blue in ~19s and yielded
only ~0.15 energy. And `PRED_DRIVE = 0.7` made reds slower than fleeing blues
(`drive → 1`), so they could only catch blues slowed by grazing.

### 2.3 Baseline evidence

Seeded headless run, 180s: **15 reds → 1**, 0 predator births, 14 starvations,
7 kills; blue **50 → 82**. The last red sat latched among 68–80 blues and still
gained only ~0.003/s, never dividing.

### 2.4 Fix and validation

| key | old | new |
|---|---|---|
| `PRED_DRAIN` | 0.008 | **0.012** |
| `PRED_METABOLISM` | 0.005 | **0.001** |
| `PRED_DRIVE` | 0.7 | **0.9** |
| `PRED_EFF` | 1 | 1 (unchanged) |

600s × 3 seeds: blue 50 → 213/236/256, red 15 → 73/66/53, 48–68 predator
births, 110–140 kills, no NaN. Reds persist and reproduce; blue keeps growing.
Higher `PRED_EFF` or `PRED_DRIVE` overhunts blue (see appendix).

## 3. Finding B — a clump is not a feast

Intake is a fixed `PRED_DRAIN` on **one** latched target. More prey nearby only
reduce search dead-time; they do not raise energy/second. Making clumps
qualitatively rewarding would need multiple simultaneous targets or a
density-scaled drain (not implemented).

## 4. Finding C (biggest) — a self-regulating cycle

### 4.1 The extinction problem

With the §2 defaults, a long run still collapses — both breeds, blue first:

```
food 7000, 1800s: blue 50→223 →0 @ ~860s ; red 15→179 →0 @ ~1160s
```

Reds boom while prey are abundant, overhunt the last blues, then starve. The
feedback exists (`PRED_EFF = 1`; reds gain only what they drain) but arrives too
late. Structural cause: **saturating (Type II) intake** capped at one target, so
once prey are common the total kill rate scales with predator count — the
paradox of enrichment.

### 4.2 Candidate mechanisms and outcomes

| # | mechanism | how it would stabilise | verdict |
|---|---|---|---|
| 1 | prey-growth tuning (scarce food) | slows prey growth | cycles, but still extinct |
| 2 | global prey refuge counter | stop hunting below N prey | works, **rejected (artificial)** |
| 3 | Type III local density threshold | rare prey invisible | narrow window; needs scarcity |
| 4 | predator interference | one red per prey | no help |
| 5 | handling time | cap kill rate per red | delays crash only |
| 6 | crowding cost | crowded reds decline | wrong feedback; over/under-shoots |
| 7 | **ratio-dependent predation** | per-capita kill falls as P > N | **prevents extinction; cycles with scarcity** |

### 4.3 The winner — ratio-dependent predation + scarce prey

Ratio-dependent attack (Arditi–Ginzburg): `attack = ratio / (ratio + K)` where
`ratio = prey / predators`. When predators outnumber prey, `attack → 0` and
reds stop hunting, giving rare prey an emergent refuge.

| case (food 3000) | blue | red | outcome |
|---|---|---|---|
| `S1 base` | 0..66 | 0..45 | extinct (blue 0 @ ~900s) |
| **`ratio1`** | **29..92** | **7..50** | **bounded cycle** |
| `ratio2` | 32..94 | 8..41 | bounded, blue rising |
| `ratio1+handle20` | 38..100 | 10..59 | bounded cycle |
| `compete.0001` | 44..284 | 3..62 | large bounded cycle |
| `interf` | 1..124 | 7..72 | blue nearly wiped (min 1) |
| `handle20` | 0..56 | 1..36 | extinct |

`ratio1` (`blue/red`): blue dips to 34, peaks 91 (t≈720), dips 53 (t≈1080); red
follows (7 → 26 → 48 → 43). 3600s × 2 seeds confirms the cycle (see Headline
table). Shipped defaults: `FOOD_COUNT 3000`, `PRED_RATIO 1`.

## 5. Experiment log

### 5.1 First balance sweep (300s, 3 seeds, averages)

| set | DRAIN | META | DRIVE | EFF | SENSE | blue | red | verdict |
|---|---|---|---|---|---|---|---|---|
| `base` | 0.008 | 0.005 | 0.7 | 1 | 1.5 | 175.7 | 3.7 | reds crash |
| `B` | 0.015 | 0.002 | 0.85 | 2.5 | 1.5 | 50.3 | 78.0 | reds dominate |
| `C` | 0.02 | 0.001 | 0.9 | 3 | 1.5 | 2.7 | 75.0 | blue near wipeout |
| `D` | 0.012 | 0.002 | 0.8 | 2 | 1.5 | 94.0 | 49.7 | plausible |
| `E` | 0.02 | 0.0015 | 0.95 | 3 | 1.5 | 2.7 | 87.3 | blue near wipeout |
| `F` | 0.025 | 0.001 | 0.9 | 4 | 1.5 | 0.0 | 69.0 | blue wiped ~270s |

### 5.2 `D` family, long (600s, 3 seeds)

| set | DRAIN | META | DRIVE | EFF | blue | red | verdict |
|---|---|---|---|---|---|---|---|
| `D` | 0.012 | 0.002 | 0.8 | 2 | 1.7 | 60.7 | blue wiped (2/3 seeds) |
| `D2` | 0.01 | 0.002 | 0.78 | 1.6 | 51.0 | 116.3 | reds dominate |
| `D3` | 0.011 | 0.0025 | 0.8 | 1.8 | 84.7 | 183.0 | reds dominate |
| `D4` | 0.01 | 0.002 | 0.78 | 1.4 | — | — | run timed out |

### 5.3 Conservative `PRED_EFF ≈ 1` (300s, 2 seeds)

| set | DRAIN | META | DRIVE | EFF | blue | red |
|---|---|---|---|---|---|---|
| `base` | 0.008 | 0.005 | 0.7 | 1 | 181.0 | 4.0 |
| `G` | 0.012 | 0.001 | 0.9 | 1 | 125.5 | 19.0 |
| `H` | 0.01 | 0.0015 | 0.85 | 1 | 151.5 | 15.0 |
| `I` | 0.014 | 0.001 | 0.9 | 1.2 | 105.0 | 25.0 |
| `D2` | 0.01 | 0.002 | 0.78 | 1.6 | 103.0 | 28.5 |

All four survive the early dip (red min ~6–11 at t≈90–150s) then recover. `G`
was chosen (most conservative, no energy creation).

### 5.4 Stronger hunting (300s, 2 seeds)

| set | DRAIN | META | DRIVE | EFF | SENSE | blue | red |
|---|---|---|---|---|---|---|---|
| `G` | 0.012 | 0.001 | 0.9 | 1 | 1.5 | 125.5 | 19.0 |
| `J` | 0.012 | 0.001 | 0.95 | 1 | 2.5 | 105.5 | 23.5 |
| `K` | 0.012 | 0.001 | 1.0 | 1 | 2.5 | 126.5 | 20.0 |
| `L` | 0.012 | 0.001 | 0.95 | 1.1 | 3 | 95.0 | 30.0 |

Long (600s): `J`/`K`/`L` all overhunt blue (blue peaks mid-run then declines as
reds keep growing); `G` is the only set where blue keeps rising alongside reds.
This is why `G` was chosen for the first pass.

### 5.5 Food-scarcity screen (600s, 1 seed)

| regime | food | respawn | minB | minR |
|---|---|---|---|---|
| base | 7000 | 40 | 44 | 12 |
| S1 | 3000 | 40 | 30 | 10 |
| S2 | 2000 | 40 | 28 | 3 |
| S3 | 1500 | 60 | 15 | 3 |
| S4 | 1000 | 60 | 17 | 3 |
| S5 | 2000 | 100 | 23 | 7 |
| S6 | 1500 | 40, absorb .05 | 20 | 6 |
| S7 | 2500 | 80, pred 8 | 31 | 7 |

Long (1800s): every scarcity regime produced **real cycles with the right
phase** — red lags blue by 260–380s at cross-correlation 0.94–0.98 — but the
amplitude is unbounded and the system still collapses. Tuning alone is not
enough.

### 5.6 Global prey refuge (`PRED_REFUGE`, rejected)

A hard gate: if `blueCount <= PRED_REFUGE`, predators stop hunting.

| regime | blue | red | outcome |
|---|---|---|---|
| ref20, food 7000 | 19..223 | 12..176 | no extinction |
| ref20, food 3000 | 19..65 | 10..43 | clean cycle (14/10 peaks over 3300s) |

It works but is **artificial** — a magic population floor — so it was removed.

### 5.7 Type III local threshold (`PRED_HALF`)

A red hunts only when its sensed `preyDensity` reaches `PRED_HALF`. Measured
`preyDensity` averages ~2.2–2.7 at food 7000 and ~0.8–1.35 at food 3000.

| food | PRED_HALF | blue | red | outcome |
|---|---|---|---|---|
| 7000 | 0.3 / 0.5 / 0.8 | 0..154 | 0..122 | extinct |
| 7000 | 1.2 | 22..325 | 7..230 | survives, huge swings |
| 3000 | 0.3 | 8..69 | 3..34 | survives |
| 3000 | 0.5 | 0..56 | 0..34 | extinct |
| 3000 | 0.8 | 7..62 | 1..25 | survives, red near zero |
| 3000 | 1.2 | 24..164 | 4..93 | survives, huge swings |

Narrow usable window; not satisfactory alone.

### 5.8 Stabiliser comparison (1200s / 900s, 1 seed)

These mechanisms were implemented behind temporary parameters and tested. Only
ratio-dependent predation was kept; the rest were **removed from the code**
(the rows below are the historical record).

| mechanism | temp param | blue | red | outcome |
|---|---|---|---|---|
| base | — | 0..219 | 0..176 | extinct |
| interference | `PRED_INTERFERE 1` | 0..138 | 0..105 | extinct |
| handling | `PRED_HANDLE 20` | 0..300 | 10..210 | blue 0 @ ~1050s |
| handling | `PRED_HANDLE 60` | 47..469 | 9..276 | survives, reds dominate |
| crowding | `PRED_COMPETE 0.0005` | 50..495 | 1..20 | reds over-suppressed |
| crowding | `PRED_COMPETE 0.001` | 50..496 | 1..15 | reds over-suppressed |
| crowding | `PRED_COMPETE 0.0001` | 47..433 | 7..73 | trends, no cycle |
| ratio | `PRED_RATIO 1` | 46..209 | 11..134 | no extinction, cycle forming |
| ratio | `PRED_RATIO 2` | 45..268 | 11..125 | no extinction, trends |
| ratio | `PRED_RATIO 5` | 50..488 | 1..83 | reds suppressed |

### 5.9 Long-run validation (3600s, 2 seeds)

`FOOD_COUNT 3000`, ratio-dependent:

| case | seed | blue | red | extinction | NaN |
|---|---|---|---|---|---|
| `PRED_RATIO 1` | 1 | 20..91 | 7..48 | none | no |
| `PRED_RATIO 1` | 2 | 28..200 | 7..113 | none | no |
| `+ PRED_HANDLE 20` | 1 | 19..93 | 8..56 | none | no |
| `+ PRED_HANDLE 20` | 2 | 22..175 | 6..97 | none | no |

Shipped-default smoke (1800s): seed 1 final blue 58 / red 53, min 36/6; seed 2
final blue 55 / red 52, min 33/7; no NaN. `npm run build` and `npm run
test:tail` pass.

## 6. Parameters added / changed

| key | group | def | role |
|---|---|---|---|
| `FOOD_COUNT` | world | 7000 → **3000** | prey carrying capacity (rebuilds) |
| `PRED_DRAIN` | predator | 0.008 → **0.012** | prey energy drained/s |
| `PRED_METABOLISM` | predator | 0.005 → **0.001** | idle burn with no prey |
| `PRED_DRIVE` | predator | 0.7 → **0.9** | red speed multiplier |
| `PRED_RATIO` | predator | **1** (new) | ratio-dependent half-saturation; 0 = off |

The other candidate stabilisers (`PRED_HALF`, `PRED_INTERFERE`, `PRED_HANDLE`,
`PRED_COMPETE`) were tested and then removed; only ratio-dependent predation
survived.

## 7. Remaining issues / future options

- **Clumps are still not a feast.** Intake is a fixed single-target rate.
  Multiple simultaneous targets or a density-scaled drain would change that.
- **Red grazing.** Reds cannot eat food at all; letting them graze would give a
  survival floor and decouple persistence from hunting success.
- **Early dip.** Reds still fall 15 → ~6–11 around t=90–150s before blue builds.
- **Ambush behaviour.** `cell-fgh` proposes `PRED_SIGHT`/`PRED_LUNGE` and
  pivoting while resting; not addressed here.
- **Default change caveat.** `FOOD_COUNT 3000` lowers the base world's food from
  7000, changing the non-predator feel; revert if undesired.
- **Related sensing cost.** `concentration`'s hardcoded scan radius and
  `SENSE_BOOST` saturation are documented in `docs/FOOD_SENSING_EXPLORATION.md`;
  `predatorSense` already computes its radius correctly.

## 8. Method

Temporary headless scripts used `vite` `ssrLoadModule('/src/sim.js')`, seeded
`mulberry32` `Math.random`, and `new Simulation(); buildWorld(); step(1/60)`.
Parameters were overridden via `setParam` after `resetParams()`. One discarded
warm-up run preceded each sweep so lazy geometry/pool PRNG draws wouldn't skew
the first set. Candidates were scored on: no extinction over ≥1800s, bounded
amplitude, red lagging blue, and no NaN. Scripts were removed after each pass;
`scripts/tail-equivalence.mjs` shows the reproducible seeded-run pattern.
