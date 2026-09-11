# Tail Dynamics — Exploration & Efficiency

> **Status:** exploration (2026-09). Beads `cell-wbw`. No code changed.
> Scope: `src/cells.js`, `src/sim.js`, `src/constants.js`, `src/render.js`,
> `src/materials.js`. Line refs are to the working tree at time of writing.

The goal of this doc is to (1) confirm whether the tail is decoupled from the
physics simulation, and (2) enumerate ways to make it cheaper, including
options that would replace the implementation outright.

## TL;DR

- The tail is **visually decoupled** but **control-coupled by exactly one
  scalar**: `d.tailBend → d.headingRate` (`sim.js:477`). That is the only
  feedback path into motion. There is no tail momentum or energy exchange.
- The chain is a real, separately integrated, **allocation-free** damped
  spring chain with its own substeps (`TAIL_DYN_SUB = 4`, `cells.js:769-893`).
- Dominant cost multiplier is **substeps per rendered frame at high `simRate`**
  (up to ~50 `advance` calls/frame), not just per-`advance` complexity.
- Cheapest wins: `TAIL_DYN_SUB`, `TAIL_SEGMENTS`, horizon-LOD via the existing
  `sideHidden` flag.
- Biggest algorithmic opening: the chain already chases a fully **analytic
  target spine** (`q[j]`, `cells.js:745-759`); it can be replaced by that
  analytic spine or a shader wave.

## 1. Current model

A cell's tail is a chain of `S = TAIL_SEGMENTS = round(1.5*MAX_RADIUS/TAIL_LINK)
= 9` segments (10 joints), stored per-cell in `tailPts`/`tailVel`/`tailVT`/
`tailQ` plus cached `tailDirs` (`cells.js:415-421`, `makeTailChain`
`cells.js:368-388`). Each `advance` ends with a tail pass (`sim.js:555-561`)
that runs either the full chain integration (`updateTailState`) or, when tails
are hidden, only the scalar bend (`updateTailBend`). Rendering emits one
instanced capsule per segment (`placeTail`, `cells.js:611-646`).

## 2. Decoupling from physics

### 2.1 Is it independent?

Mostly yes for geometry, **no for one scalar**:

- Body → tail inputs: `pos`, `heading`, `radius`, `width`, `drive`, `steer`,
  `headingRate`, `tailGrow`, `tailPhase`, `sideHidden`.
- Tail → body output: `tailBend → headingRate` (`sim.js:477`).

### 2.2 Every feedback path into motion/energy

1. **Intended actuator:** `d.headingRate += TAIL_TURN * (d.tailBend || 0) * dt`
   (`sim.js:477`), then damped/clamped (`sim.js:478-479`), applied to heading
   (`sim.js:480-484`), then thrust along heading (`sim.js:486`). Genuine loop:
   `headingRate → updateTailBend → tailLag → tailBend → headingRate`
   (`cells.js:648-661`), bounded by `TAIL_TRAIL_RATE` and `ANG_DRAG`.
2. **Indirect energy:** `updateEnergy` charges `TURN_COST * |headingRate|/MAX_SPIN`
   (`cells.js:513,518`); because the tail generates heading rate, tail bending
   indirectly drains energy. No direct tail-motion energy cost.
3. **Internal:** `tailBend` sets `whip` (`cells.js:739-743`) which changes the
   guide target `q[j]`, and gates `tailPhase` advance (`cells.js:649`).
4. **No force/momentum coupling.** The tail never writes `pos`, `vel`, `energy`,
   `drive`, or `heading`. `placeTail` writes only instance matrices
   (`cells.js:642,645`); `updateVisibility` writes `sideHidden` (render-only).
5. **One-substep lag:** the body loop that consumes `tailBend` (`sim.js:387-508`)
   runs before the tail pass that produces it (`sim.js:555-561`).
6. **Steering survives hidden tails:** `advance` still calls `updateTailBend`
   when `tailsHidden` (`sim.js:557`), so the control loop is preserved while
   the chain integration is skipped.

### 2.3 Conclusion

Geometry is decoupled / purely visual. Control is coupled by one scalar. The
intended design (per comments `sim.js:430-432`, `475-476`) is: the tail is the
turn actuator; the chain is its visible implementation. There is no intended
momentum/energy exchange and no tail-collision effect on the body.

### 2.4 Task — decouple body motion from tail animation

**Goal.** Toggling the tail display (`tailsHidden`) must not change the
simulation: with tails off, every cell's `pos`/`vel`/`heading`/`headingRate`
must evolve identically (bit-for-bit, modulo float determinism) to tails on.
The body-motion driver must be computed **before** the tail animation, and the
tail animation must be a pure downstream function of body state.

**Why it matters.** Display is currently a simulation input. A hidden tail
should cost CPU, not change behaviour. It also removes the confusing situation
where a "visual" toggle changes the ecology (predation, mitosis timing).

**Current status — mostly decoupled, but not guaranteed.** The tail pass runs
the steering scalar in both modes:

```js
// sim.js:556-560
if (this.tailsHidden) {
  for (const cell of this.cells) updateTailBend(this, cell, dt)   // scalar only
} else {
  for (const cell of this.cells) updateTailState(this, cell, dt)  // scalar + chain
}
```

`updateTailState` calls `updateTailBend` internally (`cells.js:722`), and
`updateTailBend` is a pure function of `steer`/`headingRate`/`dt`
(`cells.js:648-661`), so in the common case the two paths produce the same
`tailBend` and motion matches. **But `updateTailState` has two early returns
that happen *before* the `updateTailBend` call:**

- `if (behind.lengthSq() < 1e-8) return` — `cells.js:702`
- `if (pitch < 1e-6 || dt <= 0) return` — `cells.js:707`

`pitch` includes `d.tailGrow` (`cells.js:706`), and `tailGrow` reaches `0` in
two windows: the **back daughter at the start of mitosis** (`createCell` gives
`tailGrow = 1`; `mitose` sets `back.tailGrow = 0` at `cells.js:571`, then
`updateMito` ramps it via `fadeK` at `cells.js:923` — note the **front**
daughter is *not* ramped and stays at 1), and a **starving cell as `tailGrow`
decays to 0** (`updateStarvation`, `cells.js:531`). So in those windows the
visible path **skips** `updateTailBend` (freezing `tailPhase`/`tailLag`/
`tailBend`) while the hidden path still updates them — i.e. **tails on vs off
can diverge** exactly when cells divide or starve.

Severity is subtle: `mito`/`splitting` cells are skipped in the body loop
(`sim.js:375-378`), so the divergence does not hit their motion directly — it
shows up as accumulated `tailLag`/`tailPhase` at division release, and directly
for dying cells (which still consume `tailBend`).

There is also a one-substep feedback lag: the body loop consumes the previous
substep's `tailBend` (`sim.js:477`) because the tail pass runs afterwards
(`sim.js:555-561`).

**This is two separable tasks.**

- **Task A — equivalence bugfix (behavior-preserving, P2).** Run the scalar
  exactly once per cell per `advance` in *both* modes, before any geometry:
  `if (tailsHidden) for cells updateTailBend; else { for cells updateTailBend;
  for cells updateTailState }`, and delete the internal `updateTailBend` call at
  `cells.js:722`. Make `updateTailState`'s early returns skip **geometry only**.
  Keep `updateTailState` strictly read-only w.r.t. `pos/vel/heading/headingRate/
  drive/steer` (it already is). No retune, no feel change.
- **Task B — reorder driver ahead of animation (behavior-changing, P3).**
  Compute the body-turn driver in the body phase (from `steer` + `headingRate`)
  and make the tail purely downstream; this removes the one-substep lag
  (`sim.js:477`) but changes loop gain, so it needs retune/validation. Only do
  this if the "tail is a pure visualization" model is actually wanted; the
  current design intentionally makes the tail the turn actuator (`sim.js:475-476`).

**Acceptance test.** A "same seed, two worlds" test is **not currently
possible**: there is no seeded RNG (`Math.random()` is used in `createCell`/
`makeCell`, clump/food placement, and respawn). Use one of:

- Instrument `updateTailBend` with a call counter and assert exactly one call
  per live cell per `advance` in both modes; or
- Build a fixed hand-authored world (explicit positions/headings) and assert the
  per-cell `tailBend`/`tailPhase` sequences are identical with tails on vs off;
  or
- Add a seeded RNG first, then run two worlds and compare positions/headings.

Today the first two should fail in the `tailGrow = 0` windows.

## 3. Cost analysis

| Quantity | Value | Source |
|---|---|---|
| `TAIL_SEGMENTS` (S) | 9 | `constants.js:15-16,21-22` |
| joints `n = S+1` | 10 | `cells.js:369` |
| `TAIL_DYN_SUB` | 4 | `constants.js:24` |
| `TAIL_MOTOR_JOINTS` | 3 | `constants.js:82` |
| `TAIL_CHUNK_CELLS` | 64 → 576 instances/chunk | `constants.js:12`, `cells.js:53` |

Per `advance`, per cell (approx): ~`4 × (9+18+9+9) ≈ 180` normalize/neighbour
ops plus `4 × 36 = 144` self-avoidance distance `sqrt`s → **~325 sqrt-class
ops/cell/advance** upper bound. Complexity:

- typical (straight tail): `O(C · S · TAIL_DYN_SUB)`
- worst case (folded tail): `O(C · S² · TAIL_DYN_SUB)` from the all-pairs
  self-avoidance loop (`cells.js:828-866`).

Multiplied by `advance` substeps: `step` subdivides `simDt` up to
`MAX_STEPS = 200` (`sim.js:569-575`); at `simRate = 50` the backlog cap is
`MAX_BACKLOG ≈ 0.833 s` (`App.vue:23-24`), i.e. **up to ~50 tail passes per
rendered frame**. This is the biggest tail cost multiplier.

**Allocations:** the tail hot path is allocation-free (uses `sim._v1.._v8`
scratch and mutates tail state in place). Allocations happen only at
creation/rehome (`makeTailChain`, `ensureTailChunk`).

**Rendering:** `placeTail` does a matrix→quaternion→matrix round-trip per
segment (`cells.js:636-641`), and sets `instanceMatrix.needsUpdate = true`
inside the per-cell loop (`cells.js:645`) — redundant per chunk, and no
`updateRange`, so any one moving cell re-uploads the whole 576-instance chunk.
`frustumCulled = false` on every chunk (`cells.js:331`).

### 3.1 Latent bug: scratch-vector aliasing

`ni` and `nk` alias the same scratch vector `sim._v1`:

- `const ni = sim._v1.copy(pi).normalize()` — `cells.js:830`
- `const nk = sim._v1.copy(pk).normalize()` — `cells.js:853`

Once a contact is processed, `_v1` is overwritten with `pk`, so on the next `k`
iteration `ni` (used at `cells.js:840-843`) refers to the previous joint. The
contact test runs before `ni` is used, so the bug only bites when a joint has
two or more contacts in one substep. Effect is visual (wrong push directions),
but it is a real defect in the most expensive loop. Fix: use `sim._v3` (or a
dedicated vector) for `nk`.

## 4. Efficiency options (ranked)

### Tier 1 — trivial, high ROI

| # | Change | Speedup | Risk | Effort |
|---|---|---|---|---|
| 1 | `TAIL_DYN_SUB` 4→2 (or 1) `constants.js:24` | 2–4× tail pass | integration stability (`SUB=2` safe at `dt≤1/60`) | 1 line |
| 2 | Reduce `TAIL_SEGMENTS` (raise `TAIL_LINK`) 9→6 | ~1.5–2.4× | chunkier tail | 1 line |
| 3 | Per-chunk `needsUpdate`, not per-cell `cells.js:645` | removes flag churn | none | small |
| 4 | Drop matrix→quat→matrix round-trip in `placeTail` | minor CPU | none | small |
| 5 | Fix `_v1` aliasing bug (`cells.js:853`) | correctness | none | 1 line |

### Tier 2 — LOD, sleeping, decoupling

6. **Skip full integration for `sideHidden` cells.** `updateVisibility` already
   sets `sideHidden` (`render.js:15`); run `updateTailState` only when
   `!sideHidden`, else `updateTailBend` (needed for steering). ~2× (half the
   sphere faces away). `warmTail` already handles re-entry (`render.js:27-29`).
7. **Sleep idle tails.** If `drive < ε && |tailBend| < ε` and velocities small,
   keep last pose and run only `updateTailBend`. Big win in mature worlds.
8. **Frame-rate decoupling.** Integrate the chain every Nth `advance` and
   interpolate; keep `updateTailBend` full-rate. 2×+ at high `simRate`.
9. **Size/distance LOD.** Reds are half-size (`RED_SIZE=0.5`); use fewer
   substeps/segments for small or far cells.

### Tier 3 — algorithmic replacement

10. **Use the analytic guide directly.** `updateTailState` already builds a
    fully analytic target spine `q[j]` from a phase-shifted sine + trailing arc
    (`cells.js:745-759`). Replacing the chain with `q` + a short temporal
    low-pass removes O(S²) self-avoidance and all substeps. ~5–10×.
11. **PBD/Verlet constraints.** Position-based distance/bend constraints are
    unconditionally stable, allowing `TAIL_DYN_SUB = 1`. ~3–4×.
12. **Spline tail.** Simulate 3–4 control joints, tessellate to S render
    segments. ~2–3× sim.
13. **Spatial pruning of self-avoidance.** Fold/curvature gate or arc-length
    index window instead of all-pairs. Removes worst-case O(S²).

### Tier 4 — GPU / instancing

14. **Vertex-shader tail deformation.** Pass per-instance root/heading/phase/
    segment index; compute the wave in the shader. CPU cost → O(C) writes; no
    chain, no per-segment matrices. Near-eliminates CPU tail sim.
15. **Upload ranges / partial instancing.** `instanceMatrix.addUpdateRange` to
    upload only active slots; merge chunks.
16. **GPU compute/transform-feedback chain.** Integrate all joints on GPU.
    Highest ceiling, WebGL2/WebGPU constraints, hard to headless-test.

## 5. Radical rethinks

- **A — Procedural traveling-wave ribbon (no CPU chain).** Compute lateral
  offset analytically in a vertex shader:
  `offset(s,t) = A(drive)·sin(2πft − ks) + rudderBias(steer)·s`. CPU writes a
  handful of floats per cell. Gains: O(1) per cell, scales past `MAX_CELLS`;
  loses emergent folding/self-avoidance. The existing `q[j]` is a CPU prototype.
- **B — Position-history trail (dragged rope).** Ring-buffer recent
  surface positions/headings and render a curve through history. Zero dynamics,
  natural turn lag; tail length becomes speed-dependent, needs extrapolation.
- **C — GPU population chain.** One compute/transform-feedback pass over a
  joint buffer for all cells. Removes CPU tail cost, allows more segments;
  large complexity and readback/headless costs.
- **D — Bone/IK tail.** 2–3 bones + analytic Bezier bend, skinned tube. O(1)–O(3)
  per cell, trivial LOD, keeps the `tailBend` actuator.

## 6. Recommended next steps

1. **Decouple body motion from tail display** (§2.4): make the turn driver run
   unconditionally before the tail animation, and add the headless
   tails-on/tails-off equivalence test.
2. Fix the `_v1` aliasing bug (correctness, one line).
3. `TAIL_DYN_SUB = 2`; re-measure with `sim.perf`.
4. Horizon-LOD using the existing `sideHidden` flag.
5. Prototype replacing the chain with the analytic `q[j]` spine behind a flag
   and compare feel + perf.

## 7. Design note — bend vs whip: what steers, what is cosmetic

### 7.1 The guide spine is a wave plus an arc

`updateTailState` builds each guide target `q[j]` by rotating a step `pitch`
about the drag axis by an angle (`cells.js:751-753`):

```
ang(j) = TAIL_MOTOR_AMP · whip · sin(tailPhase − TAIL_WAVE·j)   ← traveling wave (whip)
       − TAIL_ARC · bend · j · ramp                             ← circular arc (bend)
```

- `sin(tailPhase − TAIL_WAVE·j)` with `TAIL_WAVE > 0` is a wave that travels
  base→tip; `tailPhase` advances while driving/turning (`cells.js:649`). So the
  propagating whip already exists.
- `− TAIL_ARC·bend·j` is a **mean curvature** (a C-shaped arc), not decoration.

### 7.2 The whip is purely cosmetic; the arc is the actuator

- The wave only shapes `q[j]`, which drives the spring chain into
  `d.tailPts`/`d.tailDirs`. Those are read **only** by `placeTail` for rendering
  (`cells.js:609-646`). Nothing in `sim.js` reads `tailPts`/`tailDirs`, and
  `tailPhase` is written at `cells.js:649` and read only at `cells.js:752`. The
  whip therefore never touches `pos`/`vel`/`heading`/`energy`.
- The physical coupling is the separate scalar `d.tailBend` (from the arc),
  consumed as `headingRate += TAIL_TURN · tailBend` (`sim.js:477`). It runs even
  when the chain is never integrated: `tailsHidden` still calls `updateTailBend`
  (`sim.js:557`).
- `whip = max(drive, |bend|·1.5)` (`cells.js:739-743`) makes the animation
  *react* to body state, but it is a visualization, not a source of motion.
- Energy: the whip costs nothing; `TURN_COST` is charged on `headingRate`
  (`cells.js:513,518`), which only the arc influences.

**Summary: symmetric whip = animation; arc bias = steering.**

### 7.3 Can a whip "transfer to the end" and turn instead?

Only if the whip is **time-asymmetric**. A continuous symmetric sine has ~zero
mean over a cycle, so its lateral impulse cancels: in a real swimmer it makes
forward thrust, not net yaw. A real fish turn (C-start) is a single large bend
that propagates head→tail; the traveling pulse has a nonzero time-integral of
lateral momentum, and the reaction/recoil rotates the body.

But this sim computes **no reaction from tail momentum**. Body thrust is
`THRUST·drive` along heading and turn is `TAIL_TURN·tailBend`; the chain is a
visual reconstruction. So a whip that transfers to the end currently has no
mechanical path to the body. To get one, either:

1. **Pulse / C-start whip** — drive the motor with an amplitude envelope that
   sweeps base→tip (a single traveling bend), and derive the body torque from
   the tail's lateral momentum (`Σ m·v_lateral·lever`) instead of
   `TAIL_TURN·tailBend`. Most physical, most work, needs retune.
2. **Traveling bend envelope** — keep the arc but make it propagate and relax,
   e.g. `−TAIL_ARC · bend(t) · f(j − phase)`, so the bend whips down the tail
   rather than the whole tail holding a static C. Cheap, mostly visual, keeps
   the existing actuator.
3. **Asymmetric wave** — add a net-curvature/DC term to the wave itself
   (equivalent to the arc, expressed as wave asymmetry).

The current design is a deliberate simplification: symmetric whip for looks plus
a static arc as a cheap, always-on steering proxy. Making the whip *do* the
turning is a real model change (option 1), not a tweak.

## 8. Proposed refactor — control/pose split (staged)

> **Status:** implemented (2026-09); epic `cell-asu` closed. The line refs below
> describe the pre-refactor code and are kept for the rationale/history.

**Rationale.** The spring chain (`updateTailState`, `cells.js:691-901`) only
smooths/chases an analytic spine `q[j]` that is already fully computed
(`cells.js:744-759`), and the sole physical coupling is the scalar `tailBend`
(`updateTailBend`, `cells.js:648-661`). So the chain, its self-avoidance, and
its 4 substeps are visual overhead that can be replaced by the analytic pose.

**Target API** (two clearly separated layers):

- `tailControl(sim, d, dt)` — physics. Advances `tailPhase`, `tailLag`,
  `tailBend` and `whip` from body state. Called once per cell per `advance`,
  unconditionally, before any geometry. This is the only thing the body reads.
- `tailPose(sim, d)` — visual. Derives the `S+1` points directly from `q[j]`
  (carrier + wave + arc) plus one cheap lag filter, with no integration.

**Stages** (epic `cell-asu`; each ships independently):

| Stage | Task | Change | Risk |
|---|---|---|---|
| 1 | `cell-31u` | Run `tailControl` once per cell per `advance` in both modes; remove the internal call in `updateTailState`; early-returns skip geometry only. Behavior-preserving. | low |
| 2 | `cell-asu.1` | Replace the chain with `tailPose` derived from `q[j]`; one lag filter (exponential smoother or short history) + preserved carrier orientation memory. Delete `tailVel/tailVT/tailQ` and the spring tunables. | medium (visual) |
| 3 | `cell-asu.2` | Move `tailPose` into `renderTails` (visible cells only); keep `tailControl` in `advance`. Handle `warmTail`/first-frame on re-entry. | low |
| ~~B~~ | ~~`cell-asu.3`~~ | **Dropped.** Compute the turn driver in the body phase (remove the one-substep lag). Once the tail is visual-only the lag is harmless and removing it changes loop gain. | — |
| — | `cell-asu.5` | Headless tails-on/off equivalence harness (regression guard for Stages 1-3). | low |
| — | `cell-asu.6` | Update the stale `DESIGN.md` tail section. | low |

**Deleted by Stage 2:** the force accumulation, length springs, beam,
self-avoidance, and `TAIL_DYN_SUB` loop; per-cell `tailVel`/`tailVT`/`tailQ`;
and the tunables `TAIL_DYN_SUB`, `TAIL_LEN_K`, `TAIL_LEN_DAMP`, `TAIL_BEND_K`,
`TAIL_CONTACT_D/K`, `TAIL_MOTOR_K`, `TAIL_MOTOR_JOINTS`, `TAIL_DRAG_K`,
`TAIL_CARRIER_RATE` (the panel collapses to ~4 tail params). The `_v1`
aliasing bug (§3.1) goes with the loop.

**Cost:** O(S²·SUB) → O(S) per visible cell, zero when hidden.

**Decisions.**

- **Stage 1 kept separate** from Stage 2 (ship the correctness fix immediately;
  `.5` is its regression guard), accepting that Stage 2 will rewrite the same
  code and discard the Stage 1 edit.
- **Stage B dropped** (see table): the lag is harmless once the tail is
  visual-only.
- **Lag filter resolved:** exponential smoother toward `q[j]`, rate
  `TAIL_POSE_RATE` (default 20/s); the carrier re-aim (`TAIL_CARRIER_RATE`) keeps
  the drag/orientation memory.

**Acceptance / budget.** Build passes; no NaN over 120s mitosis churn; per-cell
`tailBend`/`tailPhase` sequences identical with tails on vs off; tail pass
measured with `sim.perf` against a budget (e.g. ≤ X ms at 200 cells); pose
sanity (no root-to-tip collapse, tip trails a turn).

## 9. Rendering cost & options

After the control/pose split (§8), the pose is analytic and computed in the
render path; **rendering** is now the separate cost. Tracked as epic
`cell-5tt` ("Tail rendering efficiency").

### 9.1 Current render path

- `renderTails(dt)` (`sim.js`): for each visible (`!sideHidden`) cell →
  `updateTailState` (pose) → `placeTail`; `sideHidden` cells still call
  `placeTail`, which zeroes their matrices (`clearTail`).
- `placeTail` (`cells.js:600-632`): 9 segment transforms per cell, each doing
  `addScaledVector`/`setLength`/`subVectors`/`normalize`/`crossVectors`/
  `makeBasis`/`setFromRotationMatrix`/`updateMatrix`/`setMatrixAt`; sets
  `instanceMatrix.needsUpdate = true` **inside the per-cell loop**.
- Chunks: `InstancedMesh` of `TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS·TAIL_SEGMENTS
  = 576` instances. `ensureTailChunk` (`cells.js:316-331`) sets
  `frustumCulled = false` and **never sets `mesh.count`**, so all 576 instances
  of every chunk are submitted; `DynamicDrawUsage`, no update range.
- Geometry/material: `tailGeo = CapsuleGeometry(0.014, 0.972, 2, 6)`
  (`materials.js:4-8`, caps hidden by overlapping segments); `tailMat` is a
  `MeshStandardMaterial` (`materials.js:48-53`).

### 9.2 What costs

- **CPU** `placeTail`: 9 segment transforms per visible cell.
- **Bandwidth:** the whole 576-instance (~36 KB) chunk buffer is re-uploaded
  every frame because there is no `updateRange`, even if only a few cells moved.
- **Draw:** every chunk submits all 576 instances — including zeroed far-side
  cells (roughly half at any camera angle) and reserved slots.
- At default 65 cells → 2 chunks → 1152 instances submitted (~half degenerate)
  and ~72 KB/frame uploaded. At `MAX_CELLS = 500` → 8 chunks.

### 9.3 Options (ranked)

**Quick wins** (epic `cell-5tt`):

| # | Task | Change | Impact |
|---|---|---|---|
| 1 | `cell-5tt.1` | Track live local slots and set `mesh.count`; compact visible segments so zeroed far-side/reserved instances aren't submitted (body chunks already set `chunk.mesh.count`, `cells.js:192`) | up to ~2× fewer instances at default pop |
| 2 | `cell-5tt.2` | Partial `instanceMatrix` upload via `addUpdateRange`/`clearUpdateRanges` | upload only changed slots vs 36 KB/chunk/frame |
| 3 | `cell-5tt.3` | `placeTail` micro-opts: one `needsUpdate` per chunk; build the matrix directly (skip quat round-trip); derive the up-vector from the sphere normal | CPU in the `tails` timer |
| 4 | `cell-5tt.4` | Capless cylinder / fewer radial segments; lighter material than `MeshStandardMaterial` | fewer triangles + cheaper shading |

**Medium:** fewer segments (S 9→6) and/or size/distance LOD (reds are
half-size); update tails at 30 Hz; merge each cell's 9 capsules into one tube
(or skinned tube) → 1 instance per cell instead of 9.

**Biggest win — `cell-5tt.5` vertex-shader/procedural tail.** The pose is now a
handful of per-cell scalars (root, heading, carrier, `tailPhase`, `drive`,
`bend`, `radius`). Upload those as per-cell instanced attributes and compute
each segment transform in the vertex shader (or drive a skinned tube): CPU
becomes O(cells) attribute writes, with no per-segment matrices and no large
uploads; `tailPts`/`placeTail` can be dropped. This is the natural end-state of
the control/pose refactor.

**Not useful:** per-chunk `frustumCulled` (chunks span the sphere, so it can't
cull); per-cell `sideHidden` culling already exists but doesn't save GPU until
those instances stop being submitted (options 1 / the shader).
