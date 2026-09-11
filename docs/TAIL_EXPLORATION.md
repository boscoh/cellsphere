# Tail — Model, Decoupling, Tuning & Rendering

> **Status:** current (2026-09). The control/pose split is implemented (epic
> `cell-asu`); rendering efficiency is tracked as epic `cell-5tt`. Line refs are
> to the working tree at time of writing.

The tail is a **physical control scalar** plus a **purely visual pose**:

- `updateTailBend` (control) runs every `advance` for every cell and is the only
  tail state the body reads.
- `updateTailState` (pose) is an analytic spine, computed only in the render
  path for visible cells. It never affects motion.

## TL;DR

- **Control/pose split.** `updateTailBend` → `tailBend` → `headingRate` is the
  single physical coupling (`sim.js:480`). Everything else (`tailPts`,
  `tailDirs`, `tailPhase`, the wave) is cosmetic.
- **Toggling tails cannot change the simulation.** `advance` always runs the
  control scalar; the pose runs only in `renderTails` for visible cells.
  Guarded by `npm run test:tail`.
- **Wave frequency scales with sim speed**, clamped to `TAIL_WAVE_MAX_HZ`
  (default 8 Hz) so high `simRate` can't alias/flatten the oscillation.
- **Rendering** (not pose) is the remaining cost: `placeTail` per segment plus
  whole-chunk instance uploads and all-576-instance draws. Options in
  [§7](#7-rendering-cost--options).

## 1. Current model (control/pose split)

### 1.1 Control (physical)

`updateTailBend(sim, d, dt)` (`cells.js:635`) runs in `sim.advance` for **every**
cell, even when tails are hidden (`sim.js:558`):

- advances `tailLag` from `steer + headingRate`, decaying at `TAIL_TRAIL_RATE`;
- `tailBend = clamp(TAIL_RUDDER_GAIN·tailLag, ±TAIL_ARC_MAX)`.

The body consumes it once, in the movement block:

```js
// sim.js:480
d.headingRate += TAIL_TURN * (d.tailBend || 0) * dt
```

So `tailBend` is the turn actuator; `tailLag`/`tailBend` are the only tail
state that is physical. (There is a deliberate one-substep lag: the body loop
runs before the tail pass.)

### 1.2 Pose (visual)

`updateTailState(sim, d, dt, waveDt)` (`cells.js:673`) runs in
`sim.renderTails` (`sim.js:562`) for **visible** (`!sideHidden`) cells only.

- Builds the analytic guide spine `q[j]` from the root at the body rear
  (`TAIL_HINGE` tuck). Each step is the carrier direction rotated by
  `TAIL_MOTOR_AMP·whip·sin(tailPhase − TAIL_WAVE·j) − TAIL_ARC·bend·j·ramp`
  (traveling wave minus trailing arc), where
  `whip = max(drive, |bend|·1.5)` (`cells.js:725`).
- Eases the rendered pose toward `q[j]`: `pts[j].lerp(q[j], kPose)` with
  `kPose = 1 − exp(−TAIL_POSE_RATE·dt)` (`cells.js:747`).
- Re-aims the carrier (`tailCarrier`) toward behind-heading at
  `TAIL_CARRIER_RATE` (orientation memory / drag).

`warmTail(sim, d)` (`cells.js:650`) re-aims the **pose only** on re-entry; it
never touches `tailLag`/`tailBend`/`tailPhase`.

Rendering writes one instanced capsule per segment in `placeTail`
(`cells.js:598`).

### 1.3 Per-cell state

| Field | Kind | Notes |
|---|---|---|
| `tailPhase`, `tailLag`, `tailBend` | control | `tailPhase` is cosmetic but advanced in the pose step (see §2) |
| `tailCarrier` | pose | orientation memory |
| `tailPts`, `tailQ`, `tailDirs` | pose | derived each render for visible cells |

## 2. Wave frequency vs sim speed

The wave is cosmetic but should visibly speed up when the sim does:

- `renderTails` computes the sim time since the previous render (`waveDt`) and
  passes it to `updateTailState` (`sim.js:562`).
- Phase advance (gated on `drive > 0.02 || |headingRate| > 0.05`) is
  `min(waveDt·TAIL_OSC_FREQ, 2π·TAIL_WAVE_MAX_HZ·dt)` (`cells.js:694`).

So frequency scales with `simRate` up to roughly `TAIL_WAVE_MAX_HZ·2π /
TAIL_OSC_FREQ` ×, then saturates at `TAIL_WAVE_MAX_HZ` (8 Hz). The cap exists
because past the render Nyquist limit the wave aliases (and the pose-lag filter
flattens it) — i.e. it would stop oscillating.

**Amplitude tradeoff:** the pose-lag filter (`TAIL_POSE_RATE`) attenuates the
wave as it approaches the cap (~40% at 8 Hz with the default 20/s). Raise
`TAIL_POSE_RATE` for more amplitude at high speed, at the cost of a stiffer
(less laggy) tail; the carrier still provides the drag memory.

## 3. Decoupling invariant

Only `tailBend` feeds motion. `tailPts`/`tailDirs`/`tailPhase` are render-only,
so **toggling the tail display must not change `pos`/`vel`/`heading`/
`headingRate`**. This holds structurally: `advance` always runs
`updateTailBend`, and `renderTails` returns early when `tailsHidden`.

Guard: `npm run test:tail` (`scripts/tail-equivalence.mjs`) checks

- two seeded-RNG worlds (tails on vs off) produce identical state checksums;
- `warmTail` resets pose but never `tailLag`/`tailBend`/`tailPhase`;
- the wave scales with sim dt and clamps below Nyquist;
- the render pose stays finite.

The harness needs **two discarded warm-up runs** because lazily created
module-level THREE geometry/pool UUIDs consume `Math.random` and shift the
seeded stream. There is no seeded RNG in the app itself.

The one-substep feedback lag (body consumes the previous substep's `tailBend`)
is kept deliberately; removing it changes loop gain (the "Stage B" option was
dropped).

## 4. Design note — bend vs whip: what steers, what is cosmetic

- **The traveling wave is cosmetic.** It only shapes `q[j]` → `tailPts`, which
  only `placeTail` reads. It never touches `pos`/`vel`/`heading`/`energy`, and
  costs no energy.
- **The arc (`bend`) is the actuator.** A continuous symmetric sine has ~zero
  mean lateral impulse, so it cannot turn the body; the `−TAIL_ARC·bend·j`
  mean-curvature term is what produces yaw, via `TAIL_TURN·tailBend`.
- **Can a whip "transfer to the end" and turn instead?** Only if it is
  time-asymmetric (a C-start pulse has a nonzero time-integral of lateral
  momentum). This sim computes no reaction from tail momentum, so a whip has no
  mechanical path to the body today. Options to change that:
  1. **Pulse / C-start whip** — sweep an amplitude envelope base→tip and derive
     body torque from the tail's lateral momentum (`Σ m·v·lever`) instead of
     `TAIL_TURN·tailBend`. Most physical, most work, needs retune.
  2. **Traveling bend envelope** — keep the arc but make it propagate/relax,
     e.g. `−TAIL_ARC·bend(t)·f(j − phase)`. Cheap, mostly visual.
  3. **Asymmetric wave** — add a net-curvature/DC term to the wave itself.

## 5. Tuning reference

Plain constants: `TAIL_SEGMENTS` (9 = `round(1.5·MAX_RADIUS/TAIL_LINK)`),
`TAIL_LINK` (0.05), `TAIL_MOTOR_AMP` (40°). Everything below is a runtime
`PARAM_DEFS` entry (Tuner, group `tail`).

| Param | Def | Role |
|---|---|---|
| `TAIL_OSC_FREQ` | 4 | wave angular frequency (rad/s); scales with sim speed |
| `TAIL_WAVE_MAX_HZ` | 8 | cap on visible wave frequency (Hz) |
| `TAIL_WAVE` | 0.35 | phase shift per joint (travel direction) |
| `TAIL_CARRIER_RATE` | 2 | rate the tail axis re-aims to behind-heading |
| `TAIL_POSE_RATE` | 20 | pose lag rate toward the analytic spine |
| `TAIL_TRAIL_RATE` | 1 | decay of the turn-lag memory |
| `TAIL_ARC` / `TAIL_ARC_MAX` | 1 / 2 | trailing-arc toggle / cap (rad) |
| `TAIL_RUDDER_GAIN` | 1 | steer → arc bend gain |
| `TAIL_TURN` | 2.5 | `bend` → heading-rate gain (the actuator) |
| `TAIL_HINGE` | 0.5 | how far the hinge tucks into the body |
| `TAIL_LINK_FILL` | 0.95 | drawn fraction of each pitch |
| `TAIL_BODY` | 2 | tail length × body length |

## 6. Cost

Pose is `O(S)` per visible cell (S = 9), zero when hidden or on the far side.
There is no spring chain, self-avoidance, or substep loop. The render path
(`placeTail` + instance upload + draw) is the remaining cost — see §7.

## 7. Rendering cost & options

Tracked as epic `cell-5tt` ("Tail rendering efficiency").

### 7.1 Current render path

- `renderTails(dt)` (`sim.js:562`): visible cells → `updateTailState` (pose) →
  `placeTail`; `sideHidden` cells call `placeTail`, which zeroes their matrices.
- `placeTail` (`cells.js:598`): 9 segment transforms per cell, each doing
  `addScaledVector`/`setLength`/`subVectors`/`normalize`/`crossVectors`/
  `makeBasis`/`setFromRotationMatrix`/`updateMatrix`/`setMatrixAt`; sets
  `instanceMatrix.needsUpdate = true` inside the per-cell loop.
- Chunks: `InstancedMesh` of `TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS·TAIL_SEGMENTS
  = 576` instances. `ensureTailChunk` sets `frustumCulled = false` and **never
  sets `mesh.count`**, so all 576 instances of every chunk are submitted;
  `DynamicDrawUsage`, no update range.
- Geometry/material: `tailGeo = CapsuleGeometry(0.014, 0.972, 2, 6)` (caps
  hidden by overlapping segments); `tailMat` is a `MeshStandardMaterial`.

### 7.2 What costs

- **CPU** `placeTail`: 9 segment transforms per visible cell.
- **Bandwidth:** the whole 576-instance (~36 KB) chunk buffer re-uploads every
  frame (no `updateRange`), even if only a few cells moved.
- **Draw:** every chunk submits all 576 instances — including zeroed far-side
  cells (~half at any angle) and reserved slots.
- At default 65 cells → 2 chunks → 1152 instances submitted (~half degenerate),
  ~72 KB/frame uploaded. At `MAX_CELLS = 500` → 8 chunks.

### 7.3 Options (ranked)

| # | Task | Change | Impact |
|---|---|---|---|
| 1 | `cell-5tt.1` | track live slots and set `mesh.count`; compact visible segments so far-side/reserved instances aren't submitted | up to ~2× fewer instances at default pop |
| 2 | `cell-5tt.2` | partial `instanceMatrix` upload via `addUpdateRange`/`clearUpdateRanges` | upload only changed slots |
| 3 | `cell-5tt.3` | `placeTail` micro-opts: one `needsUpdate` per chunk; build the matrix directly (skip the quat round-trip); derive the up-vector from the sphere normal | CPU in the `tails` timer |
| 4 | `cell-5tt.4` | capless cylinder / fewer radial segments; lighter material | fewer triangles + cheaper shading |
| 5 | `cell-5tt.5` | vertex-shader/procedural tail (below) | biggest win |

**Medium:** fewer segments (S 9→6) and/or size/distance LOD (reds are
half-size); update tails at 30 Hz; merge each cell's 9 capsules into one tube
(or skinned tube) → 1 instance per cell.

**Biggest win — `cell-5tt.5` vertex-shader tail.** The pose is a handful of
per-cell scalars (root, heading, carrier, `tailPhase`, `drive`, `bend`,
`radius`). Upload those as per-cell instanced attributes and compute each
segment transform in the vertex shader (or drive a skinned tube): CPU becomes
O(cells) attribute writes, with no per-segment matrices and no large uploads;
`tailPts`/`placeTail` can be dropped.

**Not useful:** per-chunk `frustumCulled` (chunks span the sphere, so it can't
cull); per-cell `sideHidden` culling exists but saves no GPU until those
instances stop being submitted.

## 8. Alternative designs

- **Procedural traveling-wave ribbon.** Compute the lateral offset analytically
  in a vertex shader: `offset(s,t) = A(drive)·sin(2πft − ks) + rudderBias·s`.
  CPU writes a few floats per cell; loses emergent detail. The current `q[j]`
  is the CPU prototype.
- **Position-history trail.** Ring-buffer recent surface positions/headings and
  render a curve through them. Zero dynamics, natural lag; tail length becomes
  speed-dependent.
- **Bone/IK tail.** 2–3 bones + analytic Bezier bend, skinned tube. O(1)–O(3)
  per cell, trivial LOD, keeps the `tailBend` actuator.
- **GPU population chain.** One compute/transform-feedback pass over a joint
  buffer for all cells. Highest ceiling; large complexity and hard to
  headless-test.

## 9. History & decisions

- The tail used to be a damped spring-mass chain (guide/length/beam springs +
  self-avoidance, `TAIL_DYN_SUB = 4`) that chased the analytic spine `q[j]`. It
  was replaced by the analytic pose + one lag filter (epic `cell-asu`): the
  chain's only visual job was smoothing `q`, and the sole physical coupling was
  `tailBend`.
- Deleted with it: `tailVel`/`tailVT`, the force/self-avoidance loops, and the
  tunables `TAIL_DYN_SUB`, `TAIL_LEN_K`, `TAIL_LEN_DAMP`, `TAIL_BEND_K`,
  `TAIL_CONTACT_D/K`, `TAIL_MOTOR_K`, `TAIL_MOTOR_JOINTS`, `TAIL_DRAG_K`,
  `TAIL_DAMP`; added `TAIL_POSE_RATE`. The `_v1` scratch-aliasing bug in the
  self-avoidance loop went with it.
- "Stage B" (compute the turn driver before the tail animation, removing the
  one-substep lag) was **dropped**: the lag is harmless once the tail is
  visual-only, and removing it changes loop gain.
- A follow-up bug: pinning the wave to render time stopped it scaling with
  `simRate`; the phase now advances by the sim-time delta since the last render,
  clamped to `TAIL_WAVE_MAX_HZ`.

## 10. Open follow-ups

- Rendering quick wins and the vertex-shader tail: `cell-5tt.1`–`cell-5tt.5`.
- Optional: momentum-driven "C-start" whip (design note §4.1).
