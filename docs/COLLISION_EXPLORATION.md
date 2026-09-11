# Cell–Cell Body Collisions — Exploration & Simplifications

> **Status:** exploration (2026-09). Beads `cell-dy6`. No code changed.
> Scope: `src/sim.js`, `src/constants.js`, `src/cells.js`, `src/math.js`.
> Line refs are to the working tree at time of writing.

The questions: are there clever simplifications for body collisions, and what
are the options? All collision code is plain JS on the CPU; there is no physics
engine.

## TL;DR

- The solver is a **correct, single-sweep Gauss-Seidel soft-spring** capsule
  solver on a per-substep uniform `Map` grid. Already reasonably optimized
  (scratch `_col`, bounding early-out, pair dedup, exact capsule math).
- Two real costs: **(a)** broadphase `Map` traffic + per-substep bucket-array
  allocation, amplified linearly by `simRate` (up to 50×); **(b)** `capsuleDist`
  on pairs that pass a **loose** center bound, plus per-contact allocations and
  redundant per-pair `setLength`.
- Highest-value, lowest-risk wins are all trivial and behavior-preserving:
  tighten the bound, hoist `setLength`, de-allocate `signedAngleTo`, incremental
  grid keys, retune `CELL_GRID`. Plausibly **2–3×** with zero behavior change.
- Biggest structural win: dense typed-array grid (2–5× broadphase) and/or
  persistent neighbor lists (5–10×), at complexity cost.

## 1. Current algorithm

### 1.1 Configuration

| Constant | Value | Role | Source |
|---|---|---|---|
| `SURFACE` | 5.06 | positions re-projected onto sphere | `constants.js:1-2` |
| `CELL_GRID` | 1.0 | grid bucket size | `constants.js:5` |
| `SPRING` | 22 | soft-spring stiffness | `constants.js:55` |
| `WIDTH` | 0.085 | base capsule radius | `constants.js:18` |
| `MIN/MAX_RADIUS` | 0.10 / 0.30 | capsule half-length range | `constants.js:15-16` |
| `FIXED_DT` / `MAX_STEPS` | 1/60 / 200 | substep target / ceiling | `constants.js:6-7` |
| `COLLISION_KICK` | 0.5 | heading-deflection gain | `constants.js:51` |
| `MAX_CELLS` | 500 | population ceiling | `constants.js:3` |

Cell = capsule of axial half-length `radius`, cross-section radius `width`.
`makeBodyGeo` builds `CapsuleGeometry(width, 2*(length-width))` (`cells.js:60-65`),
so the collision core-segment half-length is `radius - width`. `mass =
max(radius²·0.25, 0.05)` (`cells.js:475`). Reds scale length+width by
`RED_SIZE` (`cells.js:390-395,407`). `mitoParent` marks the faded dividing
parent kept as an **immovable collision proxy** (`cells.js:585-586`).

### 1.2 Broadphase

- `cellGrid = new Map()` keyed by `cellIndex` (`sim.js:67`, `math.js:36-38`).
- `buildCellGrid()` (`sim.js:284-299`) clears and re-inserts **every
  `advance`**: skips `(mito || splitting) && !mitoParent`; includes normal cells
  and the `mitoParent` proxy; stores the **array index** `i`; bucket =
  `floor(pos / CELL_GRID)`.
- The same grid is reused by `forEachNearbyCell` (`predator.js:12-24`),
  `predatorSense` (`r = ceil(PRED_SENSE/CELL_GRID) = 2`), and `predation`
  (`r = 1`).

### 1.3 Narrowphase

`solveCollisions(simDt)` (`sim.js:301-376`):

1. Outer loop `i`, skip mito/splitting non-parents (`sim.js:305`).
2. Compute `a`'s bucket coords once (`sim.js:306-308`).
3. Triple loop `[-1,1]³` = **27 buckets**, key recomputed each iteration
   (`sim.js:309-314`).
4. `if (j <= i) continue` dedup (`sim.js:318`).
5. Skip mito/splitting `b` (`sim.js:320`).
6. **Bounding-sphere early-out** (`sim.js:321-325`):
   `bound = a.radius + b.radius + a.width + b.width`; reject if
   `|Δ|² >= bound²`.
7. `capsuleDist(a,b)` (`sim.js:327`, defined `sim.js:204-282`): standard
   Ericson closest-points-between-two-segments solve (`s,t ∈ [0,1]`, parallel/
   degenerate branches), returns `dist` and normal `_col` (A→B). No allocation.
8. `contact = a.width + b.width`; skip if `_col.dist >= contact`; else
   `overlap = contact - _col.dist` (`sim.js:328-330`).

### 1.4 Response

Inside the pair loop (`sim.js:334-370`):

- Inverse masses, `mitoParent` → 0 (`sim.js:334-337`).
- **Spring velocity update** (explicit Euler, dt-dependent):
  `impulse = (overlap*SPRING)/invSum`; `a.vel -= n*impulse*invA*simDt`,
  `b.vel += n*impulse*invB*simDt` (`sim.js:339-345`).
- **Heading kick:** `deflectHeading(a, -n, min(overlap*8,1))` and `b` (`sim.js:347-360`);
  `deflectHeading` skips `paralysed`, adds
  `clamp(signedAngleTo(...)·COLLISION_KICK, ±0.4)·intensity` to `headingRate`
  (`sim.js:197-202`).
- **Positional correction:** `corr = (overlap*0.5*simDt)/invSum`; push `a`/`b`
  (`sim.js:362-368`).
- **Per-pair sphere re-projection:** `a.pos.setLength(SURFACE);
  b.pos.setLength(SURFACE)` inside the pair loop (`sim.js:369-370`).

### 1.5 Skips / dedup

- Mito/splitting daughters excluded from grid and solver.
- `mitoParent` included but immovable (`inv=0`).
- `j <= i` makes each unordered pair once; safe because the grid stores global
  array indices and `cells.splice` happens after `solveCollisions`.

### 1.6 Complexity

- Grid rebuild `O(n)`. Broadphase `O(n·27)` `Map.get` + bucket iteration;
  candidate pairs ≈ `n·27·occupancy/2`. Narrowphase `O(1)` per candidate
  (~90–120 flops + 1 `sqrt`). Overall `O(n + candidates)`, with candidates
  growing ~quadratically in surface density at fixed `CELL_GRID`.
- `n=100` → ~420 candidates/substep; `n=500` → ~10,500 candidates and 13,500
  `Map.get` per substep.
- **Substeps multiply everything:** at `simRate=50`, ~50 passes and 50 grid
  rebuilds per rendered frame (≈675k `Map.get`/frame at n=500). This is the
  main scaling wall.

## 2. Correctness / rough edges

**Correct / good:** true capsule–capsule distance (avoids phantom contacts);
conservative center early-out; pair dedup; immovable `mitoParent` proxy;
consistent normal sign; correct `contact = width sum`.

**Rough edges:**

- **Loose bound:** `bound = ra+rb+wa+wb` (`sim.js:324`) over-estimates by
  `wa+wb` (≤0.17). The tight valid bound is `ra+rb` (since
  `(ra−wa)+(rb−wb)+(wa+wb) = ra+rb`). Tightening sends fewer pairs to
  `capsuleDist`.
- **Rate-based, not projected, response:** both terms scale by `simDt`
  (`sim.js:340-345,362-368`); for equal masses at `dt=1/60` each cell moves only
  `~0.00417·overlap` per contact. Overlap is never resolved in one step;
  separation relies on the velocity spring against `DRAG`.
- **Per-pair sphere re-projection** (`sim.js:369-370`) repeats `sqrt`+divisions
  for every contact though corrections are tiny.
- **Single Gauss-Seidel sweep**, order-dependent; piles can remain overlapped.
- **Grid not rebuilt after mid-loop position changes** (`sim.js:306-308`); with
  tiny corrections cells stay in-bucket, but a fast cell could cross a boundary.
- **Degenerate normal:** coincident centers yield a zero normal (`sim.js:274-280`).
- **`deflectHeading` saturates** at `intensity = min(overlap*8,1)` and caps the
  per-contact kick at `0.4·COLLISION_KICK = 0.2 rad/s` (`sim.js:201`).

### 2.1 Allocations

- `capsuleDist` — none (uses `_col`).
- `buildCellGrid` — **allocates bucket arrays every substep** (`clear()` drops
  them; `push`/`[i]` recreates). Up to ~1.5M small arrays/s at n=500, 50
  substeps, 60fps.
- `deflectHeading → signedAngleTo` — **two `Vector3` per call**
  (`target.clone()` `sim.js:187`, `d.heading.clone()` `sim.js:190`), up to 4
  per colliding pair.
- `signedAngleTo` is also called once per cell per substep for
  chemotaxis/flee (`sim.js:435,457,469`).

## 3. Simplifications / options (ranked)

### Tier 1 — trivial, safe, do first

| # | Change | Speedup | Quality | Effort |
|---|---|---|---|---|
| 1 | Hoist `setLength(SURFACE)` out of the pair loop (`sim.js:369-370`) → one pass per cell | ~5–20% collision | identical | trivial |
| 2 | Tighten bound to `a.radius + b.radius` (`sim.js:324`) | 10–40% fewer narrowphase | unchanged | trivial |
| 3 | De-allocate `signedAngleTo` (`sim.js:187,190`) using scratch vectors | removes up to 4 alloc/pair | unchanged | trivial |
| 4 | Incremental grid key: `base + ox·4096² + oy·4096 + oz` (`sim.js:312-314`) | small, free | unchanged | trivial |
| 5 | Skip `deflectHeading` for tiny overlaps (`overlap > ε`) | avoids `atan2`+alloc | negligible | trivial |

Items 1–5 together are plausibly **2–3×** on collisions with no behavior change.

### Tier 2 — moderate effort

6. **Dense typed-array grid instead of `Map`.** Grid coords are bounded
   (`SURFACE/CELL_GRID ≈ ±6`): e.g. 16³ `Int32Array` head + `Int32Array(MAX_CELLS)`
   next-link list, rebuilt each substep. Removes `Map.get` and per-substep
   array allocation → **2–5×** broadphase at n=500 (less at n=100). Also update
   `predator.js` `forEachNearbyCell`.
7. **Tune `CELL_GRID`.** With the tight bound `ra+rb` (max 0.6), `CELL_GRID`
   only needs to exceed 0.6 for a valid ±1 scan; `≈0.7` cuts candidate volume
   ~2×. Caveat: `predatorSense` uses `r = ceil(PRED_SENSE/CELL_GRID)`, so a
   smaller grid increases its scan (27→125) — verify/retune.
8. **Squared-distance gate before full capsule solve.** Use the tightened
   center test as the gate; optionally return squared distance and defer
   `sqrt`/normalize to overlapping pairs. 1.5–3× narrowphase.
9. **Adaptive sphere approximation** for near-parallel headings (or represent
   each capsule as 2–3 endpoint spheres). Sphere–sphere is ~5× cheaper; small
   flank error, slightly different feel.
10. **Persistent neighbor lists / temporal coherence.** Cells move little per
    substep; rebuild neighbor sets every K substeps or on displacement
    threshold. 5–10× broadphase if K≈5–10; complex due to births/deaths/mitosis
    and index instability.
11. **Sweep-and-prune (SAP).** Sort AABBs on one axis; near-linear for sparse
    scenes; may not beat a tuned hash on a sphere shell.

### Tier 3 — bigger changes / tradeoffs

12. **Decouple collision cadence** from substeps (run every 2nd substep, scale
    response dt). ~2× at high `simRate`; softer contacts, retune `SPRING`.
13. **Impulse-only vs position-only (PBD).** Removing positional correction
    saves flops; PBD improves non-overlap robustness but changes the soft feel
    and wants iteration.
14. **Merge cell and food grids.** Different sizes/semantics (`GRID=0.35` vs
    `CELL_GRID=1.0`); only saves a second rebuild — marginal.
15. **Morton/Z-order layout.** Marginal once a dense grid is used.
16. **Cap neighbors per cell / index-window limit.** Large tunable speedup but
    **misses collisions** — not recommended.
17. **Sleep / skip far-from-camera cells.** Breaks the global ecology (far cells
    pass through each other) — not advisable.
18. **Coarse repulsion field / density-based soft repulsion.** `O(n + grid)`,
    loses hard non-overlap and capsule orientation.
19. **Physics engine (Rapier/Cannon) or GPU compute.** Robust but heavy;
    sphere-surface constraint + mitosis proxies need custom integration; likely
    slower at n≤500 due to overhead. GPU compute needs WebGPU/transform
    feedback and readback for the ecology; large rewrite, hard to headless-test.

## 4. Radical rethinks

- **A — Density-field / SPH-style soft repulsion on the sphere.** Splat mass
  into a grid, each cell repelled down `-∇ρ`. `O(n + grid)`, no pair code,
  vectorizable; loses exact non-overlap and capsule orientation (soft pressure
  field). Best if n grows past ~1000.
- **B — GPU spatial hash + compute narrowphase.** Build the hash and resolve
  capsule contacts in a compute pass; thousands of cells at 60fps, no JS GC.
  Needs WebGPU/transform feedback and GPU↔CPU readback for predation/mitosis;
  very high effort; harder to headless-test.
- **C — Analytic no-overlap projection (PBD/packing).** Treat capsules as
  disk-like constraints on the surface; one or a few Jacobi/Gauss-Seidel
  projection passes split overlaps by inverse mass, then reconcile velocities
  (`v = (x − x_prev)/dt`). Guaranteed non-overlap, stable at high `simRate`,
  GPU-friendly; loses the soft squashy feel and needs iteration for piles.

## 5. Recommended next steps

1. Apply the five Tier-1 tweaks (all behavior-preserving).
2. Re-measure with `sim.perf` (`solveCollisions` is already wrapped at
   `sim.js:510-512`) at n=100/500 and `simRate=1/50`.
3. If broadphase still dominates, prototype the dense typed-array grid.
4. Consider `CELL_GRID ≈ 0.7` only after checking the predator scan tradeoff.
