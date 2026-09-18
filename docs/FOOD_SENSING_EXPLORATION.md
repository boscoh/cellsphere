# Food Sensing — Exploration & Efficiency

> **Status:** exploration (2026-09); refreshed 2026-09-18 against the
> post-refactor tree. Beads: `cell-wsk` (exploration) and `cell-qjo`
> (follow-ups). Tier-1 items 1–3 shipped as `cell-qjo.1`–`.3`.
> Scope: `src/food.js`, `src/grid.js`, `src/constants.js`, `src/sim.js`,
> `src/predator.js`. References are by symbol; line numbers drift.

The questions: is food sensing using spatial hashing, and are there more
efficient ways to do it?

## TL;DR

- **Yes — a `Map`-based spatial hash** keyed by an integer `gridKey`
  (`src/grid.js`), built **once** and maintained **incrementally** on
  eat/respawn (unlike the cell grid, which is rebuilt every substep).
- The hot spot is `concentration()`: it scans a **hardcoded `r = 2` cube** of
  125 buckets per cell, plus a `foodDist` per candidate, every
  `SENSE_PERIOD = 0.05` sim-seconds.
- The hardcoded radius **was a real bug**, but only near the top of the
  `SENSE_BOOST` slider, not at default. `r = 2` guarantees coverage to
  `r·GRID = 0.70`, while the default requirement
  (`sense + halfLen + maxFoodR ≈ 0.46`) is well inside it. The earlier claim
  that `r = 1` suffices and `r = 2` is 4.6× waste was **wrong for capsule
  geometry**: a food whose capsule distance is `< sense` can sit up to
  `sense + halfLen` from `d.pos`, so `r = 1` (0.35) would miss contributors.
- **Shipped (2026-09-18):** radius derived from `sense` (`cell-qjo.1`),
  squared-distance early reject in `foodDist` (`cell-qjo.2`), swap-remove in
  `removeFoodFromGrid` (`cell-qjo.3`). Measured at 65 cells / 3000 food:
  `sense` bucket −35%, `eat` bucket −52%.
- **Still open:** coarsen/stagger the sense period, and the larger
  architectural options (clump attractors, coarse density/potential field).

## 1. Spatial hashing

### 1.1 Data structure

- `Map` keyed by a single integer, buckets are arrays of food indices:
  `sim.foodGrid = new Map()`, recreated on `reset()`.
- Bucket size `GRID = 0.35` (`constants.js:4`); keys are `floor(pos / GRID)`
  per axis in `addFoodToGrid`/`removeFoodFromGrid`, hashed by `gridKey`
  (`src/grid.js`).
- Each food caches `food.gridKey` for removal.
- A **separate** cell grid `cellGrid` uses `CELL_GRID = 1.0`.

### 1.2 Build & mutation

- **Built once** in `buildWorld()` → `buildFoodGrid(sim)`, which clears and
  inserts every visible food.
- **Mutated incrementally**: on eat, `visible = false` then
  `removeFoodFromGrid`; on respawn, `removeFoodFromGrid`, reposition,
  `addFoodToGrid`, `placeFood`.
- No full rebuild after world build. Membership always matches `food.visible`.

### 1.3 Key function

```js
// src/grid.js
export function gridKey(cx, cy, cz) {
  return ((cx + OFFSET) * SPAN + (cy + OFFSET)) * SPAN + (cz + OFFSET)
}
```

Base-`SPAN = 4096` positional encoding with `OFFSET = 2048` bias for negative
coords; returns a Number (fast Map key, no string GC). Shared by food, cell, and
predator grids. With `GRID = 0.35` and `SURFACE ≈ 5.06`, coords are ~±15, safely
inside the 4096 stride.

### 1.4 Neighbour scan

`forEachNearby(grid, cx, cy, cz, r, cb)` (`src/grid.js`) walks a **solid cube**
of `(2r+1)³` buckets, skipping missing ones. It honours an early-out if `cb`
returns `false`, but **no caller uses it**.

The radius is a computed value:

| Caller | `r` | buckets |
|---|---|---|
| `concentration` | `scanRadius(sense + halfLen + FOOD_RADIUS_MAX, GRID)` | ~27–125 |
| `eatAndRespawn` | 1 | 27 |
| `predatorSense` | `ceil(PRED_SENSE / CELL_GRID)` | depends |

`scanRadius(reach, bucketSize) = 1 + floor(reach / bucketSize)` (`src/grid.js`)
guarantees coverage of every entry within `reach` of a point anywhere inside the
centre bucket; the `+1` (rather than `ceil`) pays for a point sitting on the far
edge of its own bucket. `FOOD_RADIUS_MAX = 0.04` (`constants.js`; food radius is
`FOOD_RADIUS_MIN + rand·span`, i.e. 0.016–0.04). `predatorSense` uses the
slightly optimistic `ceil(sense / CELL_GRID)`.

### 1.5 Contrast with the cell grid

| | Food grid | Cell grid |
|---|---|---|
| Bucket | `GRID = 0.35` | `CELL_GRID = 1.0` |
| Build | once (`buildFoodGrid`) | rebuilt every `advance` (`buildCellGrid`) |
| Mutation | incremental add/remove | full clear + reinsert |
| Reason | food static between events | cells move every substep |
| Scan radius | computed from `sense` | computed or 1 |

## 2. Cost of sensing

`concentration()` (`src/food.js`), per blue cell (skips mito/splitting and reds):

- `halfLen = max(radius − width, 0)`, `sense = width + SENSE_BOOST` (default
  `0.085 + 0.25 = 0.335`).
- Derives `r = scanRadius(sense + halfLen + FOOD_RADIUS_MAX, GRID)` (default
  `r = 2`), then for each candidate `foodDist` (point-to-capsule projection +
  `sqrt`, with a squared-distance reject) and if `dd < sense` accumulates
  `w = 1 − dd/sense` and `w · (food − cell)`.
- Finalize: `slow`, `foodAmt = min(sum, 1)`, `foodPeak = |f|/sum/sense`,
  `foodDir.set(f)`.

**Note:** `_fd` stores the **raw offset**, not a unit direction, so `foodDir`
grows with distance; `signedAngleTo` projects it into the tangent plane so
steering is fine, but `foodPeak` mixes distance with coherence.

**Cost:** per cell `O(buckets)` `Map.get` + `O(candidates)` `foodDist`. With
`FOOD_COUNT = 3000` on area ~322, occupancy is ~1 visible food/bucket, so the
default `r = 2` cube visits 125 buckets and on the order of 10² candidate
entries, skewed by clumping (85% of food is placed in ~12 clumps). The
squared-distance reject now skips the projection/`sqrt` for the many candidates
outside `sense`.

**Frequency:** `senseAccum += dt` per substep; when `≥ SENSE_PERIOD` run
`concentration` + `predatorSense`, then reset to 0 (`sim.js`). At `FIXED_DT =
1/60`, `SENSE_PERIOD = 0.05` is 3 substeps ≈ 20 passes/sim-second. `SENSE_PERIOD`
is sim time, so `simRate` up to 50 multiplies passes per real second ~linearly
(≈1000 passes/s at 50×).

**Allocations:** the hot path is allocation-free (`_fd` scratch, in-place
`foodDir.set`). The respawn path allocates (`foodInClump` quaternions,
`randomUnitVector`, `overlapsAnyCell` object literal). The per-substep
`d.heading.clone()` and `signedAngleTo` clones flagged here previously are
**already fixed** — both use shared scratch vectors (`src/collision.js`).

### 2.1 The `SENSE_BOOST` saturation bug (fixed)

`concentration` used to hardcode `r = 2`, which reaches ~`3·GRID = 1.05` at most
(and `2·GRID = 0.70` worst case). At the default `SENSE_BOOST = 0.25`
(`sense + halfLen + maxFoodR ≈ 0.46`) this was **fine** — the scan covered the
full reach. The slider only became a no-op above roughly `SENSE_BOOST ≈ 0.5–0.6`
(`SENSE_BOOST` ranges 0–2), where food beyond ~0.70 was invisible regardless of
`sense`. Deriving `r` from `sense` (`cell-qjo.1`) removes the clip without
changing defaults (verified bit-exact in a seeded headless run).

## 3. Efficiency options (ranked)

### Tier 1 — low risk

1. **Right-size the concentration radius.** ✅ **Shipped (`cell-qjo.1`).**
   `r = scanRadius(sense + halfLen + FOOD_RADIUS_MAX, GRID)`. Defaults still
   `r = 2`; high `SENSE_BOOST` now extends reach. No default perf win (see
   §2.1) — this is a bug fix.
2. **Squared-distance early reject.** ✅ **Shipped (`cell-qjo.2`).**
   `foodDist(sim, d, food, halfLen, maxDist)` rejects
   `|food − cell|² > (maxDist + halfLen)²` before the projection/`sqrt`. Exact
   (triangle inequality), so default behaviour is unchanged.
3. **Swap-remove in the grid.** ✅ **Shipped (`cell-qjo.3`).**
   `removeFoodFromGrid` backfills the hole with the last bucket entry and
   `pop()`s instead of `splice`, plus a dev-only stale-`gridKey` warning. Bucket
   order changes, which perturbs bit-level trajectories (FP/RNG order) but is
   semantically irrelevant.
4. **Coarsen / stagger sensing.** Raise `SENSE_PERIOD` (0.05 → 0.15) and/or
   round-robin cells; `foodDir`/`foodAmt` are already held between passes.
   Up to ~3× with light smoothing. Effort: low. **Open.** Also consider
   `senseAccum -= SENSE_PERIOD` instead of `= 0` (see §5).

Measured after items 1–3 (65 cells / 3000 food, `sim.step` buckets):
`sense` −35% (0.191 → 0.124 ms), `eat` −52% (0.134 → 0.065 ms).

### Tier 2 — medium effort

5. **Sense the clumps, not the specks.** `generateClumps` stores
   `{center, radius, theta}` and each food knows its clump. ~12 attractor tests
   per cell replace the cube scan. Scattered food (`FOOD_SCATTER = 0.15`) needs
   a fallback; behavioural change. Effort: low–medium. Tracked as `cell-qjo.5`.

   **Measured (`cell-qjo.5`, 2026-09-18):** prototyped behind `SENSE_MODE = 1`
   (sense each clump centre, weight `1 − dist/reach` with
   `reach = sense + theta·SURFACE`). The `sense` bucket is **4× cheaper**
   (0.125 → 0.030 ms at ~50–65 cells), but the chemotaxis direction collapses:
   the mean cosine between `foodDir` and the direction to the *nearest visible
   food* falls from **0.64 to −0.10** (uncorrelated / anti-aligned), and blues
   over-graze (seeded 90s run: blue 46 → 64). A clump centre is a poor stand-in
   for the local spec field, especially once a cell is inside a clump.
   **Recommendation: keep the per-spec scan; do not default clump sensing.**
   `SENSE_MODE` is left at 0; revisit the coarse density/potential field (item 6)
   only at much higher `FOOD_COUNT`, where the O(N) scan stops being viable.
6. **Precomputed coarse density/potential field.** Maintain a scalar density
   grid updated only on eat/respawn by splatting a kernel; sample density +
   gradient with bilinear interpolation. O(N), independent of `FOOD_COUNT`.
   Effort: medium–high. Tracked as `cell-qjo.5`.
7. **Monte-Carlo subsampling.** Cap candidates per cell (K ≈ 12–24), scale the
   result. ~2.5×, noisy. Effort: low.
8. **Cone/vision sensing.** Only accumulate food within a forward cone (plus a
   short omnidirectional grazing term). ~50–70% fewer candidates, reads more
   biological. Effort: low–medium.
9. **Scatter/batched sensing.** One pass over `sim.foods`, look up nearby cells
   via `cellGrid`, splat into per-cell accumulators; finalize after. Cost
   `O(food)` instead of `O(N × buckets)`; better when cells are sparse relative
   to food. Effort: medium.
10. **2D shell grid (lat-long / cube-map).** Food lies on a 2D shell but the
    code scans a 3D cube whose interior is empty. ~2–4× traversal. Effort:
    medium.
11. ~~Remove per-substep `Vector3` allocations.~~ **Already fixed** (scratch
    vectors in `src/collision.js`).

### Tier 3 — high effort

12. **Octree/Morton hierarchy** — marginal over a tuned shell grid.
13. **GPU density texture** — rasterize food density additively, sample in
    shader / read back a coarse field. Scales to 10⁵–10⁶ food; overkill at 3000
    and hard to headless-test. Effort: high.

## 4. Radical rethinks

- **A — Density/potential field.** Food as a continuous scalar field `D(x)`
  with stored gradient; one bilinear sample per cell for concentration and
  steering. O(N) sensing, smooth gradients, huge food counts; loses per-spec
  granularity and exact `sense` cutoff.
- **B — Flow / steering vector field.** Store a normalized food-gradient vector
  per coarse voxel; cells do one lookup. Cache-friendly and batchable; coarse
  resolution limits fine steering.
- **C — Clump-attractor architecture.** Promote the existing clumps to the
  primary sensed field; individual food remains only for contact eating. Near
  constant sensing cost regardless of `FOOD_COUNT`, very little new code.
- **D — GPU particles + density texture.** Simulate/render food on GPU, sample
  density/gradient; CPU needs a coarse parallel field for steering. Significant
  complexity and WebGL coupling.
- **E — SoA / data-oriented refactor.** Move sensing state into typed arrays and
  process all cells in tight loops. Large constant-factor win, invasive.

## 5. Other findings

- **Unused early-out:** `forEachNearby` honors `cb === false`, but no caller
  returns `false`.
- **`removeFoodFromGrid` fragility:** relied on `food.gridKey` being current; a
  stale key silently left a dangling index. Now swap-removes and warns in dev
  (`cell-qjo.3`).
- **Accumulator reset:** `senseAccum = 0` rather than `-= SENSE_PERIOD`
  quantizes the period to substep-dt multiples and drifts with substep
  subdivision at high `simRate`. At the default `simRate` (`dt = FIXED_DT`)
  `SENSE_PERIOD` is an exact 3×, so there is no drift; low priority.
- **Predator sense is radius-correct** (`predatorSense` computes
  `ceil(sense / CELL_GRID)`); the sense-scan helper is now shared with
  `concentration`.

## 6. Recommended next steps

1. ✅ Compute the `concentration` scan radius from `sense` (`cell-qjo.1`).
2. ✅ Add a squared-distance early reject in `foodDist` (`cell-qjo.2`).
3. ✅ Swap-remove in `removeFoodFromGrid` (`cell-qjo.3`).
4. Prototype a coarse density/potential field behind a flag and compare
   chemotaxis quality and perf (`cell-qjo.5`).
   **Done for clump attractors:** 4× cheaper sense, but nearest-food alignment
   collapses (0.64 → −0.10) ⇒ not recommended as a default. The density field
   remains open and is only worth it above the current `FOOD_COUNT`.
