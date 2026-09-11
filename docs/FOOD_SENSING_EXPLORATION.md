# Food Sensing — Exploration & Efficiency

> **Status:** exploration (2026-09). Beads `cell-wsk`. No code changed.
> Scope: `src/food.js`, `src/math.js`, `src/constants.js`, `src/sim.js`,
> `src/predator.js`. Line refs are to the working tree at time of writing.

The questions: is food sensing using spatial hashing, and are there more
efficient ways to do it?

## TL;DR

- **Yes — a `Map`-based spatial hash** keyed by an integer `cellIndex`, built
  **once** and maintained **incrementally** on eat/respawn (unlike the cell
  grid, which is rebuilt every substep).
- The hot spot is `concentration()`: **125 hardcoded bucket lookups per cell**
  (`food.js:241`) with ~40 `foodDist` evaluations, every `SENSE_PERIOD = 0.05`
  sim-seconds.
- The hardcoded `r = 2` both **over-scans at defaults** (r=1 suffices) and
  **silently clips high `SENSE_BOOST`** (real bug).
- Cheapest wins: right-size the scan radius, squared-distance rejects, stagger/
  coarsen the sense period. Largest architectural win: a precomputed density /
  potential field sampled in O(1) (or sensing the clumps, not the specks).

## 1. Spatial hashing

### 1.1 Data structure

- `Map` keyed by a single integer, buckets are arrays of food indices:
  `sim.foodGrid = new Map()` (`sim.js:66`, recreated on `reset()` `sim.js:144`).
- Bucket size `GRID = 0.35` (`constants.js:4`). Keys are
  `floor(pos / GRID)` per axis (`food.js:79-83`) hashed by `cellIndex`.
- Each food caches `food.gridKey` (`food.js:70,84,98`) for O(1) removal.
- A **separate** cell grid `cellGrid` (`sim.js:67`) uses `CELL_GRID = 1.0`.

### 1.2 Build & mutation

- **Built once** in `buildWorld()` → `buildFoodGrid(this)` (`sim.js:131`),
  which clears and inserts every visible food (`food.js:101-106`).
- **Mutated incrementally**: on eat, `visible=false` then
  `removeFoodFromGrid` (`food.js:210-211`); on respawn, `removeFoodFromGrid`,
  reposition, `addFoodToGrid`, `placeFood` (`food.js:176-180`).
- No full rebuild after world build. Membership always matches `food.visible`.

### 1.3 Key function

```js
// src/math.js:36-38
export function cellIndex(cx, cy, cz) {
  return ((cx + 2048) * 4096 + (cy + 2048)) * 4096 + (cz + 2048)
}
```

Base-4096 positional encoding with +2048 bias for negative coords; returns a
Number (fast Map key, no string GC). Shared by food, cell, and predator grids.
With `GRID=0.35` and surface radius ~5.06, coords are ~±15 → safely inside the
4096 stride.

### 1.4 Neighbour scan

`forEachNearbyFood` (`food.js:125-140`) walks a **solid cube** of
`(2r+1)³` buckets, skipping missing/invisible entries. It honors an early-out
if `cb` returns `false` (`food.js:135`), but **no caller uses it**.

The radius is a **hardcoded literal**, not derived from `SENSE_BOOST`:

| Caller | `r` | buckets | source |
|---|---|---|---|
| `concentration` | 2 | 125 | `food.js:241` |
| `eatAndRespawn` | 1 | 27 | `food.js:202` |

Contrast `forEachNearbyCell`, which is fed a computed radius in
`predatorSense` (`r = ceil(sense / CELL_GRID)`, `predator.js:43`).

### 1.5 Contrast with the cell grid

| | Food grid | Cell grid |
|---|---|---|
| Bucket | `GRID=0.35` | `CELL_GRID=1.0` |
| Build | once (`sim.js:131`) | rebuilt every `advance` (`sim.js:284-299,383`) |
| Mutation | incremental add/remove | full clear + reinsert |
| Reason | food static between events | cells move every substep |
| Scan radius | hardcoded 1 or 2 | computed or 1 |

## 2. Cost of sensing

`concentration()` (`food.js:227-257`), per blue cell (skips mito/splitting and
reds):

- `halfLen = max(radius − width, 0)`, `sense = width + SENSE_BOOST` (default
  `0.085 + 0.25 = 0.335`).
- Scans **125 buckets** (`r=2`), then for each candidate `foodDist`
  (`food.js:108-123`: point-to-capsule projection + `sqrt`) and if
  `dd < sense` accumulates `w = 1 − dd/sense` and `w · (food − cell)`.
- Finalize: `slow`, `foodAmt = min(sum,1)`, `foodPeak = |f|/sum/sense`,
  `foodDir.set(f)` (`food.js:251-255`).

**Note:** `_fd` stores the **raw offset** (`food.js:119-121`), not a unit
direction, so `foodDir` grows with distance; `signedAngleTo` projects it into
the tangent plane so steering is fine, but `foodPeak` mixes distance with
coherence.

**Cost:** per cell `O(125 Map.get)` + `O(candidates)` `foodDist`. With
`FOOD_COUNT=7000` on area ~322, occupancy ≈ 2.7/bucket, but only shell-adjacent
buckets are occupied → ~35–55 candidates/cell at defaults (skewed higher inside
clumps, since 85% of food is clumped into 12 clumps).

**Frequency:** `senseAccum += dt` per substep; when `≥ SENSE_PERIOD` run
`concentration` + `predatorSense`, then reset to 0 (`sim.js:522-529`) ≈ every
3rd substep ≈ 20 passes/sim-second. `SENSE_PERIOD` is sim time, so `simRate`
up to 50 multiplies passes per real second ~linearly (≈1000 passes/s at 50×).

**Allocations:** hot path is allocation-free (`_fd` scratch, in-place
`foodDir.set`). The respawn path allocates (`foodInClump` quaternions,
`randomUnitVector`, `overlapsAnyCell` object literals `food.js:147`), and
`sim.advance` allocates `d.heading.clone()` (`sim.js:496`) and
`signedAngleTo` clones (`sim.js:187`) per substep.

### 2.1 Real bug: `SENSE_BOOST` saturation

`concentration` hardcodes `r = 2` (`food.js:241`), which reaches only ~`3·GRID
= 1.05`. `SENSE_BOOST` ranges 0–2 (`constants.js:57`), so the upper half of the
slider is a no-op: food farther than ~1.05 is invisible regardless of `sense`.
At the default `SENSE_BOOST=0.25`, `r=1` (27 buckets) already suffices, so the
`r=2` scan is also ~4.6× wasted `Map.get`. Computing the radius from
`sense`/`halfLen`/food radius fixes both.

## 3. Efficiency options (ranked)

### Tier 1 — low risk, do first

1. **Right-size the concentration radius.** Replace the literal `2`
   (`food.js:241`) with
   `r = ceil((sense + halfLen + FOOD_R_MAX) / GRID)` (clamp ≥1). Defaults →
   `r=1`: **~4.6× fewer bucket lookups**, and fixes the `SENSE_BOOST`
   saturation bug. Effort: trivial.
2. **Squared-distance / bounding-sphere early reject.** Reject
   `|food−cell|² > (sense+halfLen+r)²` before the projection/`sqrt` in
   `foodDist`; or return squared distance and defer `sqrt`. ~1.5–2×.
   Effort: low.
3. **O(1) swap-remove in the grid.** `removeFoodFromGrid` uses
   `indexOf`+`splice` (`food.js:90-99`); swap-with-last + `pop` (order is
   irrelevant). Free. Effort: trivial.
4. **Coarsen / stagger sensing.** Raise `SENSE_PERIOD` (0.05 → 0.15) and/or
   round-robin cells; `foodDir`/`foodAmt` are already held between passes.
   Up to ~3× with light smoothing. Effort: low.

Combined, items 1+2+3+4 plausibly give **5–10×** on the sense/eat path with no
visible quality change.

### Tier 2 — medium effort

5. **Sense the clumps, not the specks.** `generateClumps` already stores
   `{center, radius, theta}` (`food.js:28-38`) and each food knows its clump
   (`food.js:62-64`). 12 attractor tests/cell replace 125 lookups + ~40
   `foodDist` → **~5–15×**, less variance. Scattered food (15%) needs a
   fallback; behavioral change. Effort: low–medium.
6. **Precomputed coarse density/potential field.** Maintain a scalar density
   grid updated only on eat/respawn by splatting a kernel; sample density +
   gradient with bilinear interpolation. O(N), independent of `FOOD_COUNT`;
   **~10–50×**. Effort: medium–high.
7. **Monte-Carlo subsampling.** Cap candidates per cell (K≈12–24), scale the
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
11. **Remove per-substep `Vector3` allocations** (`sim.js:496`, `sim.js:187`).
    Reduces GC at high `simRate`. Effort: low.

### Tier 3 — high effort

12. **Octree/Morton hierarchy** — marginal over a tuned shell grid.
13. **GPU density texture** — rasterize food density additively, sample in
    shader / read back a coarse field. Scales to 10⁵–10⁶ food; overkill at 7000
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

- **Unused early-out:** `forEachNearbyFood` honors `cb === false`
  (`food.js:135`), but no caller returns `false`.
- **`removeFoodFromGrid` fragility:** relies on `food.gridKey` being current
  (`food.js:92-98`); a stale key silently leaves a dangling index. A swap-remove
  plus assertion would harden it.
- **Accumulator reset:** `senseAccum = 0` rather than `-= SENSE_PERIOD`
  (`sim.js:527`) quantizes the period to `FIXED_DT` multiples and drifts with
  substep subdivision at high `simRate`.
- **Predator sense is already radius-correct** (`predator.js:43`); copy that
  pattern into `concentration`.

## 6. Recommended next steps

1. Compute the `concentration` scan radius from `sense` (fixes bug + 4.6×).
2. Add a squared-distance early reject in `foodDist`.
3. Swap-remove in `removeFoodFromGrid`.
4. Prototype a coarse density/potential field behind a flag and compare
   chemotaxis quality and perf.
