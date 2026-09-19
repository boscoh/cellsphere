# CellSphere — Consolidated Notes (explorations, experiments, history)

`docs/DESIGN.md` is the authoritative reference for the current architecture,
tuning values, and gotchas. This file is the consolidated record behind that
design: subsystem models, balance experiments, measured results, rejected
options, and the decisions that produced the code. It replaces the former
`PREY_PREDATOR.md`, `PREDATOR_EXPLORATION.md`, `COLLISION_EXPLORATION.md`,
`FOOD_SENSING_EXPLORATION.md`, `TAIL_EXPLORATION.md`, and
`RENDER_BUG_POSTMORTEM.md`.

1. [Predator–prey](#1-predatorprey)
2. [Cell–cell collision](#2-cellcell-collision)
3. [Food sensing](#3-food-sensing)
4. [Tail](#4-tail)
5. [Render bug post-mortem](#5-render-bug-post-mortem)
6. [Appendix — experiment method](#appendix--experiment-method)

References are by symbol rather than line number, which drifts.

---

## 1. Predator–prey

> **Status:** implemented. Beads `cell-k2g` (+ subtasks `.1`–`.5`), `cell-v9d`
> (energy economy), `cell-dmd` (coupling), `cell-erd` (re-acquisition).

### 1.1 Model

- **Breeds.** Blue (breed `0`) grazes food and divides as usual. Red (breed `1`)
  hunts blue. Reds are skipped by `eatAndRespawn`/`concentration`, so a red's
  only energy is a blue it drains.
- **Latch.** A red scans the cell grid for the nearest valid blue within
  `PRED_RANGE` (capsule gap), stores it as `red.target`, and re-latches while
  within `PRED_RANGE × 1.6`. One target per red; multiple reds may drain the
  same blue. `buildCellGrid` is rebuilt fresh at the top of `advance`.
- **Immobilise.** Within `PRED_RANGE` the blue is `paralysed`: `sim.advance`
  forces `drive = 0`, zeros `headingRate`, hard-decays velocity, and skips
  chemotaxis. A latched prey glows purple (`instanceParalysed`). While it has a
  paralysed target a red's own drive is 0, so the latch holds.
- **Drain / gain.** Within `PRED_BITE` (≥ `PRED_RANGE`, so a latch is bitten),
  `drainEnergy(blue, PRED_DRAIN·dt)` and
  `gainEnergy(red, PRED_DRAIN·dt·PRED_EFF)`. The blue shrinks because size is
  linear in energy and dies at `energy <= 0` (`killedByPred`). `gainEnergy`
  caps at `ENERGY_MAX`, so a well-fed red divides.
- **Sensing.** `predatorSense()` sums proximity-weighted directions to every
  valid blue within `PRED_SENSE` into `preyDir`/`preyAmt`; reds steer up that
  gradient. It also records `preyNear` (nearest capsule gap) for the ambush.
- **Ambush.** While no prey is within `PRED_LUNGE`, red `drive` is scaled by
  `PRED_COAST`; inside the lunge it bursts at full drive. Steering is unaffected,
  so a coasting red still turns onto prey.
- **Re-acquisition.** After a meal the shoal gradient can point ~40° off the
  nearest blue, so a red swims past close prey. `PRED_REORIENT` (default 0.3s)
  steers at the nearest prey and suppresses the ambush coast for that window;
  `PRED_FOCUS` steepens the proximity weight (default 1 = linear).
- **Ratio-dependent predation.** `PRED_RATIO` (`0` = off) implements an
  Arditi–Ginzburg response: `attack = ratio / (ratio + K)` with
  `ratio = prey / predators`. As predators outnumber prey the per-capita attack
  falls, giving rare prey an emergent refuge.

### 1.2 Balance history and findings

**A. Reds starved before they could reproduce (`cell-v9d`).** An unfed red burned
`METABOLISM + PRED_METABOLISM + MOVE_COST·drive ≈ 0.007/s` but gained only
`PRED_DRAIN × PRED_EFF = 0.008/s` while biting, and `PRED_DRIVE = 0.7` made reds
slower than fleeing blues. Seeded 180s run: 15 reds → 1, 0 births, blue 50 → 82.
Fix (600s × 3 seeds → blue 50→213/236/256, red 15→73/66/53, 48–68 births,
110–140 kills, no NaN):

| key | old | new |
|---|---|---|
| `PRED_DRAIN` | 0.008 | **0.012** |
| `PRED_METABOLISM` | 0.005 | **0.001** |
| `PRED_DRIVE` | 0.7 | **0.9** |
| `PRED_EFF` | 1 | 1 (unchanged) |

**B. A clump is not a feast.** Intake is a fixed `PRED_DRAIN` on **one** latched
target. More prey nearby only shorten search dead-time; they do not raise
energy/second. A density-scaled drain or multiple simultaneous targets would
change this (not implemented).

**C. Long runs still went extinct.** With the §1.2 defaults, a 1800s run showed
blue 50→223→0 (~860s), then red 15→179→0 (~1160s): reds boom, overhunt the last
blues, then starve. Structural cause is the saturating (Type II) one-target
intake — once prey are common the total kill rate scales with *predator* count
(the paradox of enrichment).

**D. Winner: ratio-dependent predation + scarce prey (`cell-dmd`).** Ratio
dependence makes per-capita kill fall as predators outnumber prey; lowering
`FOOD_COUNT` 7000 → 3000 gives prey a carrying capacity to cycle against.
Together they produce a sustained bounded cycle:

| run (3600s) | seed | blue | red |
|---|---|---|---|
| `FOOD_COUNT 3000`, `PRED_RATIO 1` | 1 | 20..91 | 7..48 |
| " | 2 | 28..200 | 7..113 |
| + `PRED_HANDLE 20` (test only) | 1 | 19..93 | 8..56 |
| + `PRED_HANDLE 20` (test only) | 2 | 22..175 | 6..97 |

Reds lag blues by a quarter-cycle: as prey drop, predators starve and drop; as
prey recover, predators follow. Shipped defaults: `FOOD_COUNT = 3000`,
`PRED_RATIO = 1`. `PRED_EFF > 1` (energy creation) is the single most
destabilising knob — it always ends in prey wipeout.

**E. Re-acquisition A/B (`cell-erd`).** Seeded A/B (relatch within 2s): baseline
14/15%, `PRED_FOCUS=2` 24/19%, `PRED_REORIENT=0.3` 23/20%; mean nearest-blue
distance at meal end 1.52 → 1.36 with `PRED_REORIENT=0.3`. **Adopted
`PRED_REORIENT = 0.3`**; `PRED_FOCUS` stays 1. Disabling the ambush
(`PRED_COAST=1`) crashes blue (64→27), so the ambush is load-bearing.

### 1.3 Rejected stabilisers

Implemented behind temporary parameters, tested, then **removed from the code**;
only ratio-dependent predation survived.

| mechanism | temp param | verdict |
|---|---|---|
| global prey refuge | `PRED_REFUGE` | works but a magic population floor → **rejected as artificial** |
| predator interference | `PRED_INTERFERE` | no help; still extinct |
| handling time | `PRED_HANDLE` | delays the crash only (or reds dominate) |
| crowding cost | `PRED_COMPETE` | wrong feedback; over/under-shoots |
| Type III local threshold | `PRED_HALF` | narrow usable window; not satisfactory alone |
| ratio-dependent | `PRED_RATIO` | **kept** (bounded cycles with scarcity) |

### 1.4 Open follow-ups

- Clumps are still not a feast (fixed single-target intake); see §1.5 for the
  measured eating-speed options and the division-orientation bug.
- Reds cannot graze food at all; grazing would give a survival floor.
- Early dip: reds fall 15 → ~6–11 around t=90–150s before blue builds.
- Ambush refinement (`cell-fgh`: `PRED_SIGHT`/`PRED_LUNGE`, pivoting while
  resting) — not addressed here.
- `FOOD_COUNT 3000` changes the non-predator base feel; revert if undesired.

The full `predator` parameter table is generated into `DESIGN.md`.

### 1.5 Clump camping, division orientation, eating speed

> **Status:** investigation only (2026-09). No default changed. Seeded headless
> runs (`ssrLoadModule('/src/sim.js')`, `mulberry32` from `src/util.js`), 600–
> 3600 s, seeds 1–3, PRED_* overridden directly on `P`.

**A. Daughters face each other by design; the defect is post-division
food-seeking.** Facing each other is *deliberate, not a bug*: each daughter's
tail must stream **outward**, away from its sibling, and since the tail trails
`-heading` the body heading must point inward. `mitose()` places the `back` cell
at `startPos + headBack·(-half·MITO_NEAR)` with heading `headBack` (backward) and
mirrors `front`, which is exactly what keeps the two tails outside — correct.

The real problem is what happens next: a freshly divided cell is bad at finding
the food right beside it, so a blue that divides on a clump often leaves it.

- `concentration()` and `eatAndRespawn()` skip cells while `d.mito || d.splitting`,
  so daughters are **food-blind for the whole `MITO_TIME` (5 s)**.
- `finalizeMito` then gives each daughter `rest = MITO_REST` (4 s) with
  `drive = 0`: it coasts in place and may only turn. Steering is live after one
  sense pass (`foodPeak ≈ 0.46`, `|steer| ≈ 0.44`), but the tail-driven
  `headingRate` is drag-limited (`≈ TAIL_TURN·tailBend/ANG_DRAG`), so the body
  swings only ≈13° during the 4 s rest.
- The outward-facing tails also mean the birth heading points at the sibling —
  ~90° off the nearest food on average — and when drive resumes the near-food
  `slow` (grazing) term keeps the daughter crawling, so it mills/drifts instead
  of closing.

Measured over 516 divisions (seed 1, 1200 s): nearest-food distance at release
0.166–0.211; by 16 s it is essentially unchanged (0.172–0.195) and system-wide
mean `|headingRate|` is 0.036 rad/s (≈0.07 for daughters). So the failure is an
**actuation/re-aim problem in the division aftermath** — an inward birth heading
plus a ~9 s blind/coast window the cell cannot turn through — not the facing
itself. Candidate fixes: let daughters sense during `MITO_REST` (or during
mitosis), shorten `MITO_REST`, seed a stronger initial turn toward the sensed
gradient at release, or raise steering authority for the re-aim window.

**B. Why a red does not camp a clump.** Measured (600 s, seeds 1–2): reds are
latched ~40–50 % of their lives, mean kill gap ~65–71 s, mean re-latch ~30 s, and
only ~40–50 % of meals are followed by a fresh latch within 2 s. Causes, in order:

1. **Single-target, fixed-rate intake.** `PRED_DRAIN` on one latched blue; a
   clump only shortens search dead-time (§1.2.B). This caps throughput hardest.
2. **Short re-orient window.** `PRED_REORIENT` is 0.3 s; after it the red reverts
   to the shoal gradient (`preyDir`), a proximity-weighted average that can point
   off the nearest blue, and re-enables the ambush coast (`PRED_COAST`) so it
   closes on the next blue at 0.35 drive while beyond `PRED_LUNGE`.
3. **Energy coast band.** Above `MITO_SLOW_FRAC = 0.9` drive ramps to 0, so the
   best-fed red — the one that just ate — is the least inclined to chase again.
4. **Ratio gate.** `PRED_RATIO = 1` stops hunting entirely once `prey/pred < 1`.
   That is what protects prey at the crossover, but it also truncates camping.

Multi-red competition and the shared ratio throttle amplify all four.

**C. Eating faster with a transient red > blue, without a prey wipeout.** Keeping
`PRED_EFF = 1`, `PRED_COAST`, `PRED_LUNGE`, `PRED_METABOLISM` and `PRED_RATIO`
unchanged, raise `PRED_DRAIN` alone. 3600 s, seeds 1/2/3 (`red>blue` = max
red−blue; `×` = red/blue curve crossings):

| `PRED_DRAIN` | blue min..max | red min..max | red>blue | crossings | extinct? |
|---|---|---|---|---|---|
| 0.02 | 15/15/12..158/76/141 | 5/6/2..84/39/79 | 7/3/2 | 4/4/10 | no |
| 0.025 | 19/24/21..59/62/85 | 7/5/7..30/34/53 | 1/3/2 | 2/6/2 | no |
| 0.03 | 18/9/22..72/70/126 | 6/1/6..43/32/71 | 2/1/3 | 4/4/10 | no |

Baseline `PRED_DRAIN = 0.012` (1800 s, seeds 1–2) never crosses: blue 26..92,
red 9..55, `red>blue = 0`, 0 crossings. So the crossover comes entirely from a
faster bite.

**Rejected in the same sweep.** `PRED_EFF = 0.5` (drain 0.03): reds convert too
little, prey bloom to 191–300, crossover becomes seed-dependent (4/0) — reject.
`PRED_RATIO = 2–3`: suppresses the crossover entirely and lets prey bloom to 343.
`PRED_METABOLISM = 0.002` (drain 0.03): seed 2 starved all reds (blue 500,
red 0) — reject. Raising `PRED_REORIENT` to 2 s gave a small kill-gap gain
(60–63 s vs 65–71 s) but nothing else, because intake is intake-limited.

**Recommendation.** `PRED_DRAIN` 0.012 → **0.02** (1.67×): shortest change that
shortens time-on-prey, produces repeated transient red > blue overshoots (up to
+7 cells), and kept both populations alive in all six long runs. `0.025` is the
conservative alternative; `0.03` also survived these seeds but seed 2 dropped to
a single red, so treat it as riskier. If a stronger, more visible boom is wanted,
the structural move is the §1.4 **clump feast** — scale drain with local prey
density (`rate *= 1 + c·(nearby−1)`) or allow N simultaneous latches — so a red
eats fast inside a clump while isolated blues survive as refuge; that needs its
own A/B.

---

## 2. Cell–cell collision

> **Status:** exploration (`cell-dy6`, `cell-b0t`). **No Tier-1 change was
> shipped** — the bound tightening measured neutral and was reverted.

Scope: `src/collision.js`, `src/constants.js`, `src/cells.js`. All collision code
is plain JS on the CPU; there is no physics engine.

### 2.1 Current algorithm

A cell is a capsule of axial half-length `radius` and cross-section radius
`width`; the collision core-segment half-length is `radius − width`
(`makeBodyGeo` builds `CapsuleGeometry(width, 2·(length−width))`). `mass =
max(radius²·0.25, 0.05)`; reds scale length+width by `RED_SIZE`. `mitoParent`
marks the faded dividing parent kept as an **immovable collision proxy**.

- `buildCellGrid()` clears and re-inserts every `advance`, skipping
  `(mito || splitting) && !mitoParent`, storing the array index. The same grid is
  reused by `forEachNearbyCell`, `predatorSense` (`r=2`), and `predation` (`r=1`).
- `solveCollisions(simDt)` runs a **single-sweep Gauss–Seidel soft spring**:
  27-bucket scan with a bounding-sphere early-out
  (`bound = ra + rb + wa + wb`), then `capsuleDist` (Ericson closest-points
  between two segments, returns `dist` + normal `_col`, no allocation), then
  skip unless `dist < wa + wb`.
- Response per contact: inverse masses (`mitoParent` → 0), spring velocity
  update `(overlap·SPRING)/invSum` scaled by `simDt`, heading kick
  `deflectHeading` (skips `paralysed`, caps at `0.4·COLLISION_KICK`), positional
  correction, and a per-pair `setLength(SURFACE)` re-projection.
- `j <= i` dedups unordered pairs; grid stores global indices, and
  `cells.splice` runs after `solveCollisions`.
- Complexity `O(n + candidates)`, candidates grow ~quadratically in surface
  density at fixed `CELL_GRID`. At `simRate = 50` the whole pass (and grid
  rebuild) runs ~50×/frame — the main scaling wall.

### 2.2 Correctness and rough edges

Correct: true capsule–capsule distance (avoids phantom contacts), conservative
center early-out, pair dedup, immovable `mitoParent` proxy, consistent normal
sign, correct `contact = width sum`.

Rough edges: the center bound is loose (`ra+rb+wa+wb`; the tight valid bound is
`ra+rb`) but tightening measured neutral; the response is rate-based, not
projected (overlap is never resolved in one step); per-pair sphere re-projection
repeats `sqrt`; single order-dependent sweep; grid is not rebuilt after mid-loop
moves; coincident centers yield a zero normal; `deflectHeading` saturates.

Allocations: `buildCellGrid` allocates bucket arrays every substep (reusing them
measured **slower**, so `clear()` is kept); `capsuleDist` and
`deflectHeading → signedAngleTo` are allocation-free via `_col`/scratch vectors.

### 2.3 Options (ranked)

**Tier 1 — trivial, behavior-preserving.** Hoist `setLength(SURFACE)` out of the
pair loop; tighten the bound to `ra + rb`; de-allocate `signedAngleTo` (already
fixed); incremental grid key (n/a — cells move); skip `deflectHeading` for tiny
overlaps (negligible). **Measured (`cell-b0t`):** the bound tightening was
bit-identical in a seeded fingerprint and cut `capsuleDist` calls, but `collide`
stayed within noise at n≈78 (0.100 vs 0.100 ms/step) and was reverted. The
expected 2–3× does not hold for Tier-1.

**Tier 2 — moderate effort.**

- Dense typed-array grid instead of `Map` (16³ `Int32Array` head + next-link
  list): 2–5× broadphase at n=500; also update `predator.js`.
- Tune `CELL_GRID` (with the tight bound `CELL_GRID ≈ 0.7` cuts candidate volume
  ~2×; caveat: `predatorSense` uses `ceil(PRED_SENSE/CELL_GRID)`, so a smaller
  grid enlarges its scan — retune).
- Squared-distance gate before the full capsule solve (1.5–3× narrowphase).
- Adaptive sphere approximation for near-parallel headings (~5× cheaper,
  slightly different feel).
- Persistent neighbor lists / temporal coherence (5–10× broadphase if rebuilt
  every K substeps; complex with births/deaths/mitosis).
- Sweep-and-prune on one axis; may not beat a tuned hash on a shell.

**Tier 3 — bigger tradeoffs.** Decouple collision cadence from substeps (~2× at
high `simRate`, softer contacts); impulse-only vs position-only PBD; merge cell
and food grids (marginal); Morton/Z-order layout (marginal); cap neighbors or
index-window limits (**misses collisions — not recommended**); sleep far cells
(breaks the global ecology); coarse repulsion field (loses hard non-overlap and
orientation); physics engine / GPU compute (heavy at n≤500, hard to
headless-test).

**Radical rethinks.** (A) SPH-style density-field soft repulsion: `O(n+grid)`,
loses exact non-overlap and capsule orientation; best past n≈1000. (B) GPU
spatial hash + compute narrowphase: thousands of cells, needs WebGPU + readback,
very high effort. (C) Analytic no-overlap PBD projection: guaranteed non-overlap,
GPU-friendly, loses the soft squashy feel.

### 2.4 Recommended next steps

1. No Tier-1 tweak was worth shipping (`cell-b0t`).
2. Re-measure with `sim.perf` (`collide` bucket) at n=100/500 and `simRate=1/50`.
3. If broadphase dominates, prototype the dense typed-array grid.
4. Consider `CELL_GRID ≈ 0.7` only after checking the predator scan tradeoff.

---

## 3. Food sensing

> **Status:** exploration. Tier-1 items 1–3 shipped as `cell-qjo.1`–`.3`;
> clump-attractor prototype evaluated under `cell-qjo.5`.

Scope: `src/food.js`, `src/grid.js`, `src/constants.js`, `src/sim.js`,
`src/predator.js`.

### 3.1 Structure

- Food uses a **`Map` spatial hash** keyed by an integer `gridKey`
  (`src/grid.js`: base-`SPAN = 4096`, `OFFSET = 2048` bias for negatives; fast
  Number key, no string GC). It is built **once**
  (`buildWorld → buildFoodGrid`) and mutated **incrementally** on eat/respawn, so
  membership always matches `food.visible`. Bucket size `GRID = 0.35`.
- The **cell grid** is separate (`CELL_GRID = 1.0`) and rebuilt every substep,
  because cells move.
- `forEachNearby(grid, cx, cy, cz, r, cb)` walks a solid cube of `(2r+1)³`
  buckets and honours an early-out no caller uses. `scanRadius(reach, bucket) =
  1 + floor(reach/bucket)` guarantees coverage for a point anywhere in the
  center bucket.
- `concentration()` derives `r = scanRadius(sense + halfLen + FOOD_RADIUS_MAX,
  GRID)` (default `r = 2`); `eatAndRespawn` uses `r = 1`; `predatorSense` uses
  `ceil(PRED_SENSE / CELL_GRID)`. `sense = width + SENSE_BOOST`.
- `foodDist` returns the raw offset, so `foodDir` grows with distance;
  `signedAngleTo` projects it into the tangent plane for steering, but `foodPeak`
  mixes distance with coherence.

### 3.2 Cost

Per blue cell, `concentration` is `O(buckets)` `Map.get` + `O(candidates)`
`foodDist`. At `FOOD_COUNT = 3000` on area ~322, occupancy is ~1 visible
food/bucket, so the `r = 2` cube visits 125 buckets and ~10² candidates, skewed
by clumping (85% in ~12 clumps). `SENSE_PERIOD = 0.05` is ~3 substeps ≈ 20
passes/sim-second, multiplied ~linearly by `simRate` (≈1000 passes/s at 50×).
The hot path is allocation-free.

**`SENSE_BOOST` saturation bug (fixed).** `r = 2` guaranteed coverage only to
`3·GRID ≈ 1.05` (worst case 0.70); the default requirement
(`sense + halfLen + maxFoodR ≈ 0.46`) fit, but the slider became a no-op above
roughly `SENSE_BOOST ≈ 0.5–0.6` (`SENSE_BOOST` ranges 0–2). Deriving `r` from
`sense` removed the clip without changing defaults (verified bit-exact).

### 3.3 Shipped Tier-1 (`cell-qjo.1`–`.3`)

1. Right-size the concentration radius from `sense` (bug fix, no default win).
2. Squared-distance early reject in `foodDist` (exact via triangle inequality).
3. Swap-remove in `removeFoodFromGrid` (backfill with last entry + `pop`, plus a
   dev stale-`gridKey` warning; bucket order changes, semantically irrelevant).

Measured after 1–3 (65 cells / 3000 food): `sense` −35% (0.191 → 0.124 ms),
`eat` −52% (0.134 → 0.065 ms).

### 3.4 Clump attractors rejected (`cell-qjo.5`)

Prototyped behind `SENSE_MODE = 1` (sense each clump centre, weight
`1 − dist/reach`, `reach = sense + theta·SURFACE`). The `sense` bucket is **4×
cheaper** (0.125 → 0.030 ms at ~50–65 cells), but chemotaxis collapses: mean
cosine between `foodDir` and the direction to the nearest visible food falls from
**0.64 to −0.10**, and blues over-graze (seeded 90s: blue 46 → 64). A clump
centre is a poor stand-in for the local spec field, especially inside a clump.
**Keep the per-spec scan; do not default clump sensing.** `SENSE_MODE` stays 0.

### 3.5 Remaining options

- **Coarsen / stagger sensing** (open): raise `SENSE_PERIOD` (0.05 → 0.15) and/or
  round-robin cells; up to ~3× with light smoothing. Also consider
  `senseAccum -= SENSE_PERIOD` instead of `= 0` (currently quantizes the period
  to substep-dt multiples; low priority at the default `simRate`).
- **Coarse density/potential field:** splat a kernel on eat/respawn, sample
  density + gradient with bilinear interpolation; `O(N)` independent of
  `FOOD_COUNT`. Only worth it above the current `FOOD_COUNT`.
- Monte-Carlo subsampling (cap candidates K≈12–24, ~2.5×, noisy); cone/vision
  sensing (~50–70% fewer candidates, more biological); scatter/batched sensing
  (`O(food)`); 2D shell grid (the 3D cube's interior is empty, ~2–4× traversal);
  GPU density texture (overkill at 3000, hard to headless-test).

---

## 4. Tail

> **Status:** current. The tail is a **damped spring chain** whose `O(1)` control
> runs every sim step and whose `O(S²)` pose integrates only while tails are
> drawn. Rendering epic `cell-5tt`: **`.1`–`.5` shipped**. An experimental
> **kinematic mode** (`TAIL_MODE`, `cell-h2o`) swaps the chain for a
> force-rotated rigid root plus positional follow. See `DESIGN.md` for the
> generated tail parameter table.

### 4.1 Model

`sim.advance` splits the tail into two passes:

- **`updateTailControl`** — `O(1)`, runs for **every** cell on **every** step,
  even while tails are hidden. It re-aims `tailCarrier` toward behind-heading at
  `TAIL_CARRIER_RATE`; advances `tailPhase += dt·TAIL_OSC_FREQ` when
  `drive > 0.02` or `|headingRate| > 0.05`; integrates `tailLag` from
  `steer + headingRate` (decaying at `TAIL_TRAIL_RATE`); and sets
  `tailBend = clamp(TAIL_RUDDER_GAIN·tailLag, ±TAIL_ARC_MAX)`. This is the
  physical actuator the body reads.
- **`updateTailPose`** — `O(S²·TAIL_DYN_SUB)`, runs only while tails are visible.
  It builds the analytic guide spine `q[j]` from the root at the body rear
  (`TAIL_HINGE` tuck): each step is the carrier rotated by
  `TAIL_MOTOR_AMP·whip·sin(tailPhase − TAIL_WAVE·j) − TAIL_ARC·bend·j·ramp`,
  `whip = max(drive, |bend|·1.5)`, then integrates `tailPts`/`tailVel` toward `q`
  over `TAIL_DYN_SUB` substeps.

The body consumes only `tailBend`, in the movement block:

```js
d.headingRate += TAIL_TURN * (d.tailBend || 0) * dt
```

```text
updateTailControl(sim, d, dt):        # always, even while hidden
  n0     = normalize(d.pos)
  behind = tangent-project(-d.heading, n0)
  pitch  = TAIL_BODY * 2 * d.radius / S * d.tailGrow
  tailCarrier -> behind          at TAIL_CARRIER_RATE
  if drive > 0.02 or |headingRate| > 0.05:
      tailPhase += dt * TAIL_OSC_FREQ
  tailLag += (steer + headingRate) * dt;  tailLag -= TAIL_TRAIL_RATE * tailLag
  tailBend = clamp(TAIL_RUDDER_GAIN * tailLag, ±TAIL_ARC_MAX)

updateTailPose(sim, d, dt):           # only while tails are visible
  build guide spine q[0..S] from root (wave + trailing arc)
  repeat TAIL_DYN_SUB times:
      gather guide + length + beam forces -> acc[j]
      add self-avoidance contacts         -> acc[]
      integrate v[j] then p[j]            # damp, tangent-project, clamp VMAX
  for i in 0..S: tailDirs[i] = normalize(pts[i+1] - pts[i])
```

Each pose substep runs three passes — gather accelerations, add self-avoidance
contacts, then integrate — so pair forces act symmetrically. Forces: **guide
spring** toward `q[j]` (stiff `TAIL_MOTOR_K` at the root motor joints
`j <= TAIL_MOTOR_JOINTS`, weak `TAIL_DRAG_K` elsewhere); **length springs** to
`j±1` at `pitch` (`TAIL_LEN_K`, damped by `TAIL_LEN_DAMP`); **local beam**
`TAIL_BEND_K·(pₗ + pᵣ − 2pⱼ)` resisting curvature; **self-avoidance** for
non-adjacent joints closer than `TAIL_CONTACT_D` (`TAIL_CONTACT_K`). Integration
is `v = (v + a·h)·e^(−TAIL_DAMP·h)` with `h = dt/TAIL_DYN_SUB`, projected to the
tangent plane and clamped to `VMAX = 40`; positions are re-projected to
`SURFACE`. The loop is allocation-free (per-cell arrays + shared `sim._vN`
scratch; self-avoidance normals come from a module-level `_norm` array, fixing
the old `sim._v1` aliasing bug, `cell-bjm`).

### 4.2 Data structures

**Per-cell CPU chain** (`S = TAIL_SEGMENTS = 9` joints, `S+1 = 10` points):

| Field | Type | Pass | Role |
|---|---|---|---|
| `tailPts` | `Vector3[]` | pose | joint positions; `[0]` = root at body rear |
| `tailVel` | `Vector3[]` | pose | joint velocities, tangent to the sphere |
| `tailVT` | `Vector3[]` | pose | per-substep acceleration accumulator |
| `tailQ` | `Vector3[]` | pose | analytic guide targets `q[j]` |
| `tailDirs` | `Vector3[]` | pose | unit segment tangents (render input) |
| `tailCarrier` | `Vector3` | control | drag axis / orientation memory |
| `tailPhase` | number | control | traveling-wave phase (rad) |
| `tailLag` | number | control | turn-lag memory |
| `tailBend` | number | control | clamped arc bend — the only field the body reads |
| `tailGrow` | number | shared | 0..1 tail-length scale |

Control fields survive a hidden-tail step; pose fields are frozen while hidden
and re-aimed by `warmTail`. The arrays are allocated once at birth and mutated in
place — `updateTailPose` allocates nothing per step.

**GPU representation** (`sim.tailChunks`): `tailGeo` is a capless cylinder
(radius 0.014, 6 radial segments, local X = segment direction); `tailMat` is
`MeshLambertMaterial`. Each segment is one instance but there is **no
`instanceMatrix`**: a chunk carries four compact `InstancedBufferAttribute`s
(`aSegPos`, `aSegX`, `aSegY`, `aSegScale`), and the vertex shader builds the
transform (`z = x × y`) — 11 floats/segment instead of 16. A chunk is
`{ mesh, live, owners, attrs, attrList }` with
`TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS · S = 576`, `frustumCulled = false`,
`DynamicDrawUsage`, and a per-chunk geometry clone. Cell slots are packed
`0..live-1` (`claimTailSlot`/`freeTailSlot` swap-remove), so
`mesh.count = live·S`; `owners[slot]` maps back to the cell. `placeTail` writes
the attributes and adds per-slot update ranges; one `needsUpdate` per attribute
per dirty chunk per frame.

### 4.3 Decoupling invariant

Only `tailBend` feeds motion, and `tailPts`/`tailDirs`/`tailPhase` are cosmetic,
so **toggling the tail display must not change `pos`/`vel`/`heading`/
`headingRate`**. Structurally: `advance` always runs `updateTailControl` (which
alone sets `tailBend`); only `updateTailPose` and `renderTails` are gated on
`tailsHidden`. Guarded by `npm run test:tail`
(`scripts/tail-equivalence.mjs`), which checks identical seeded state checksums
for tails on/off, that `warmTail` never touches `tailLag`/`tailBend`/`tailPhase`,
that `tailPhase` advances by `dt·TAIL_OSC_FREQ` only while driving, that joints
stay on the surface, and that the pose stays finite after a long run.
`updateTailState` remains a thin `control + pose` wrapper for tests. The harness
needs two discarded warm-up runs because lazily created module-level THREE
geometry/pool UUIDs consume `Math.random` and shift the seeded stream.

The one-substep feedback lag (the body consumes the previous substep's
`tailBend`) is deliberate; removing it ("Stage B") changes loop gain and was
dropped.

### 4.4 What steers vs what is cosmetic

- **The traveling wave is cosmetic.** It shapes `q[j] → tailPts`, read only by
  `placeTail`; it never touches motion and costs no energy.
- **The arc (`bend`) is the actuator.** A symmetric sine has ~zero mean lateral
  impulse; the `−TAIL_ARC·bend·j` mean-curvature term produces yaw via
  `TAIL_TURN·tailBend`.
- A whip can only turn the body if it is time-asymmetric. This sim computes no
  reaction from tail momentum, so a whip has no mechanical path to the body
  today. Options: (1) pulse / C-start whip deriving body torque from
  `Σ m·v·lever` (most physical, most work); (2) traveling bend envelope
  (cheap, mostly visual); (3) asymmetric wave with a net-curvature/DC term.
- Phase advances in the sim step, so wave frequency scales with `simRate`
  automatically — the old render-time `TAIL_WAVE_MAX_HZ` Nyquist cap is gone.

### 4.5 Kinematic mode (`TAIL_MODE = 1`, `cell-h2o`)

Replaces the `O(S²)` spring chain in `updateTailPose` with a positional model.
The guide spine `q[j]` is still built exactly as above; root paddle joints
`j = 1..TAIL_MOTOR_JOINTS` are force-rotated straight onto `q[j]` with velocities
zeroed; each remaining joint follows the segment ahead with a first-order
direction lag
`dir_j ← normalize(lerp(dir_j, dir_{j−1}, 1 − e^{−TAIL_FOLLOW_RATE·dt}))`,
placed at `pts[j−1] + dir_j·pitch` and re-projected to `SURFACE`.
`TAIL_FOLLOW_RATE` sets the response: high = rigid rod, low = floppy, laggy.
There is no self-avoidance, so a very low rate can fold the tail. The mode is
**pose-only** and ~3× cheaper; `test:tail` verifies both modes produce identical
motion checksums.

### 4.6 Cost

- **Sim:** control is `O(1)` per cell per step and always runs; chain integration
  is `O(S²·TAIL_DYN_SUB)` and is paid only while visible (the hidden case costs
  just the control pass).
- **Render:** `renderTails` clears each chunk's update ranges, calls `placeTail`
  per cell, and issues one `needsUpdate` per attribute per dirty chunk per frame.
  `placeTail` writes 9 segments/cell straight into typed arrays (no matrix build,
  no cross product) and adds update ranges when `sim.renderer` is set. Only
  `live·S` instances are submitted per chunk; zeroed far-side and reserved slots
  are excluded from `count`. At ~65 cells → 2 chunks → 585 instances submitted
  (was 1152, ~half degenerate). CPU is still `O(cells·S)`; true `O(cells)` needs
  a GPU chain.

`cell-5tt` shipping history: `.1` chunk-local packed slots with exact
`mesh.count` + swap-remove compaction; `.2` per-slot partial uploads (one
`needsUpdate` per chunk per frame); `.3` direct basis build + sphere-normal up
vector; `.4` capless-cylinder `MeshLambertMaterial` segment; `.5` per-segment
transform moved to the vertex shader via four compact instanced attributes.

### 4.7 Alternative designs considered

Analytic traveling-wave ribbon (the model the restore replaced — cheap and
deterministic, loses emergent drag/whip); position-history trail (zero dynamics,
speed-dependent length); bone/IK tail (O(1)–O(3), trivial LOD, keeps the
`tailBend` actuator); GPU population chain (highest ceiling, hard to
headless-test).

### 4.8 History and open follow-ups

- The chain was briefly replaced by an analytic pose + one lag filter (epic
  `cell-asu`) and **restored** because the chain looks better (emergent drag lag,
  whip, self-avoidance). The physical coupling (`tailBend → headingRate`) never
  changed. Restoring the chain also brought back the sim-step phase advance.
- **GPU spring chain (`cell-igf`) closed, won't do.** Headless measurement showed
  the tail pose (`0.27` ms spring / `0.16` ms kinematic at 77 cells) and
  `renderTails` (`~0.05` ms) are negligible against the 16.7 ms frame budget;
  reopen only with a browser frame profile showing the tail as the top cost.
- Kinematic vs spring-chain (`cell-owg`) is the open decision — compare in the
  Tuner and keep, retune (`TAIL_FOLLOW_RATE`) or drop `TAIL_MODE`.
- Optional momentum-driven "C-start" whip (§4.4).

---

## 5. Render bug post-mortem

Two rendering bugs, both resolved by auditing the render path numerically rather
than tweaking materials. Only the conclusions that carry forward are kept.

### 5.1 "Cell goes black / body vanishes, tail remains"

A far-side cell lost its body but kept its tail: far-side culling only hid
`cos ≤ −0.06`, while the opaque shell eclipses bodies in a wider limb band
(~`cos ∈ [−0.06, 0.2)`). `polygonOffset` couldn't help — those bodies are
genuinely behind the shell. A second artifact was an opaque **emissive nucleus**
`InstancedMesh` that glowed irrespective of lighting; it was removed and
re-adding it was reverted.

**Fix:** **never cull bodies** (the opaque shell depth-occludes them naturally)
and **cull tails at the horizon** (`sideHidden = cosFace <= 0`; `placeTail`
clears a hidden cell's tail, `renderBodies` ignores `sideHidden`).

### 5.2 "Bodies blink on scroll-zoom" (`cell-6uj`)

Pooled `InstancedMesh`es were `frustumCulled` against a `boundingSphere` cached
on first render. A body pool born with one cell froze its sphere at ~one capsule
radius, so zooming in dropped whole buckets at random. The wide default framing
hid it.

**Fix:** `frustumCulled = false` on every shell-spanning pool — `createBodyChunk`
and `ensureTailChunk` (`src/cells.js`), `foodMesh` (`src/sim.js`), and each tail
chunk.

### 5.3 Lessons

- Two independent culling layers exist: cell-level `sideHidden` (per-cell,
  recomputed each frame) and mesh-level `frustumCulled` (three.js, per pool,
  one-shot cached sphere). A pool spanning more space than its sphere **must**
  set `frustumCulled = false`.
- With an opaque occluder, cull conservatively (hide only the far side) and let
  the shell do real occlusion; a clever "behind the shell" test over-hides the rim
  because the near cap sticks out.
- A separate emissive mesh is lighting-independent and must stay in sync.
- Re-test under the narrowest view (zoom all the way in) before declaring a
  render bug fixed; don't trust comments over behavior (`grep frustumCulled src/`).
- Code pointers: `src/render.js` `renderView`, `src/math.js` `cosFace`,
  `src/cells.js` `renderBodies`/`placeTail`/chunk pools, `src/sceneSetup.js`
  shell + lighting, `src/constants.js` `CULL_COS`.

---

## Appendix — experiment method

Balance/exploration harnesses used Vite `ssrLoadModule('/src/sim.js')`, seeded
`mulberry32` `Math.random`, and `new Simulation(); buildWorld(); step(1/60)` with
no WebGL. Parameters were overridden via `setParam` after `resetParams()`. A
discarded warm-up run preceded each sweep so lazy geometry/pool PRNG draws
wouldn't skew the first set. Candidates were scored on: no extinction over
≥1800s, bounded amplitude, red lagging blue, and no NaN. Temporary scripts were
removed after each pass; `scripts/tail-equivalence.mjs` shows the reproducible
seeded-run pattern.
