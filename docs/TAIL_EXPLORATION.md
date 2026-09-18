# Tail — Model, Decoupling, Tuning & Rendering

> **Status:** current (2026-09). The tail is a **damped spring-chain simulation**
> whose O(1) control runs every sim step and whose O(S²) pose is integrated only
> while tails are drawn. It replaced an earlier analytic control/pose split and
> was restored because the chain looks better. Rendering-efficiency epic
> `cell-5tt`: **`.1`–`.5` shipped** (a full GPU chain remains future work).
> An experimental **kinematic mode** (`TAIL_MODE`, `cell-h2o`) swaps the chain
> for a force-rotated rigid root plus a positional follow — see §1.5.

The tail is a chain of joints on the sphere surface, driven toward an analytic
guide spine `q[j]` and integrated with springs. It shapes the rendered flagellum
and provides the physical steering scalar `tailBend` that turns the body.

## TL;DR

- **Chain, not a filter.** `advance` splits the tail into `updateTailControl`
  (O(1)) and `updateTailPose` (a substep spring chain: guide + length + beam +
  self-avoidance toward `q[j]`). The pose runs only while tails are visible
  (`cells.js`).
- **Only `tailBend` feeds motion.** `headingRate += TAIL_TURN·tailBend·dt`
  (`sim.js`); everything else (`tailPts`, `tailDirs`, `tailPhase`, the wave) is
  cosmetic. This holds in kinematic mode too, so switching modes never changes
  the simulation (`npm run test:tail` checks both).
- **Toggling tails cannot change the simulation.** `advance` always runs the
  control; only the pose and `renderTails` are gated. Guarded by
  `npm run test:tail`.
- **Wave frequency scales with sim speed for free** — the phase advances by
  `dt·TAIL_OSC_FREQ` in the sim step (no render-time Nyquist cap needed).
- **Rendering is the remaining cost.** `cell-5tt.1`–`.5` made draws and uploads
  proportional to live cells and moved the per-segment transform to the vertex
  shader (packed slots, exact `mesh.count`, partial uploads, compact basis
  attributes, cheaper geometry/material) — see [§5](#5-cost). The CPU still
  writes `O(cells·S)` attributes; a full GPU chain is the only path to
  `O(cells)`.

## 1. Model (spring chain)

### 1.1 Step (every `advance`)

`sim.advance` splits the tail into two passes (`cells.js`):

- **`updateTailControl`** — O(1), runs for **every** cell on **every** step,
  even while tails are hidden. It re-aims `tailCarrier` toward behind-heading at
  `TAIL_CARRIER_RATE` (orientation memory / drag); advances
  `tailPhase += dt·TAIL_OSC_FREQ` when `drive > 0.02` or `|headingRate| > 0.05`;
  and integrates `tailLag` from `steer + headingRate`, decaying at
  `TAIL_TRAIL_RATE`, setting `tailBend = clamp(TAIL_RUDDER_GAIN·tailLag,
  ±TAIL_ARC_MAX)`. This is the physical actuator the body reads.
- **`updateTailPose`** — O(S²·TAIL_DYN_SUB), runs only while tails are visible
  (`!sim.tailsHidden`). It builds the analytic guide spine `q[j]` from the root
  at the body rear (`TAIL_HINGE` tuck) — each step is the carrier rotated by
  `TAIL_MOTOR_AMP·whip·sin(tailPhase − TAIL_WAVE·j) − TAIL_ARC·bend·j·ramp`,
  `whip = max(drive, |bend|·1.5)` — then integrates the chain
  `tailPts`/`tailVel` toward `q` over `TAIL_DYN_SUB` substeps.

The chain reads `tailBend`/`tailPhase`/`tailCarrier` but never writes back to
them, so the two passes are independent: skipping the pose cannot change motion.
`updateTailState` remains as a thin `control + pose` wrapper for tests. On the
hidden→visible edge `renderView` calls `warmTail` once per cell to re-aim the
frozen chain and avoid a snap.

In outline:

```text
# always, even while hidden:
updateTailControl(sim, d, dt):
  n0     = normalize(d.pos)                       # local surface normal
  behind = tangent-project(-d.heading, n0)        # desired drag direction
  if |behind| ~ 0: return
  pitch  = TAIL_BODY * 2 * d.radius / S * d.tailGrow
  if pitch < 1e-6 or dt <= 0: return
  tailCarrier -> behind          at TAIL_CARRIER_RATE   # orientation memory
  if drive > 0.02 or |headingRate| > 0.05:
      tailPhase += dt * TAIL_OSC_FREQ                   # wave phase
  tailLag += (steer + headingRate) * dt;  tailLag -= TAIL_TRAIL_RATE * tailLag
  tailBend = clamp(TAIL_RUDDER_GAIN * tailLag, ±TAIL_ARC_MAX)

# only while tails are visible:
updateTailPose(sim, d, dt):
  (recompute n0, behind, pitch as above)
  side = cross(n0, tailCarrier)                   # lateral sweep axis
  root = project(pos - heading * (radius - width*TAIL_HINGE))
  cur  = root
  for j in 0..S:                                  # analytic guide spine
      q[j] = cur
      if j < S:
          ang = TAIL_MOTOR_AMP*whip*sin(tailPhase - TAIL_WAVE*j)
                - TAIL_ARC*bend*j*ramp          # ramp = 1/(S-1)
          cur = project(cur + rotate(carrier, ang, side) * pitch)
  repeat TAIL_DYN_SUB times:                      # integrate chain toward q
      gather guide + length + beam forces -> acc[j]
      add self-avoidance contacts         -> acc[]
      integrate v[j] then p[j]            # damp, tangent-project, clamp VMAX
  for i in 0..S: tailDirs[i] = normalize(pts[i+1] - pts[i])
```

The body consumes it once, in the movement block:

```js
// sim.js
d.headingRate += TAIL_TURN * (d.tailBend || 0) * dt
```

So `tailBend` is the turn actuator; `tailLag`/`tailBend` are the only tail state
that is physical. There is a deliberate one-substep lag (the body loop runs
before the tail pass).

### 1.2 Chain forces

Each substep runs three passes in order — **(1)** gather forces into per-joint
accelerations, **(2)** add self-avoidance contacts, **(3)** integrate
velocities/positions — so pair forces act symmetrically and a joint never sees a
half-updated neighbour. For each joint `j` (1..S):

- **guide spring** toward `q[j]`: stiffness `TAIL_MOTOR_K` for the root motor
  joints (`j <= TAIL_MOTOR_JOINTS`) and `TAIL_DRAG_K` elsewhere — stiff at the
  paddle, weak drag along the tail;
- **length springs** to neighbours `j±1` at spacing `pitch` (`TAIL_LEN_K`),
  damped along the link by `TAIL_LEN_DAMP` — keeps spacing and stops collapse;
- **local beam** restoring `TAIL_BEND_K·(pₗ + pᵣ − 2pⱼ)` — resists curvature,
  the mechanism that straightens the chain for motion;
- **self-avoidance**: non-adjacent joints closer than `TAIL_CONTACT_D` push apart
  at `TAIL_CONTACT_K` (only on contact).

Integration (`h = dt/TAIL_DYN_SUB`): `v = (v + a·h)·e^(−TAIL_DAMP·h)`, projected
to the tangent plane and clamped to `VMAX = 40`; positions are projected back to
`SURFACE` each substep. Every acceleration is likewise projected onto the
tangent plane before integration, so joints never drift off the sphere. After
all substeps, segment tangents are stored in `tailDirs` for rendering.

The whole loop is allocation-free: it writes through the per-cell arrays and the
shared `sim._vN` scratch vectors (see §1.3), so no `Vector3` is created per
step.

### 1.3 Tail data structures

There are two representations: a **per-cell CPU chain** (integrated while tails
are visible) and a **shared GPU instance pool** (written once per frame by
`placeTail`).

#### Per-cell CPU state

`createCell` builds the chain once via `makeTailChain(pos, heading, radius)` and
stores it on the cell as plain fields (`cells.js`). `S = TAIL_SEGMENTS = 9`, so
there are `S+1 = 10` joints and `S = 9` segments.

| Field | Type | Size | Pass | Role |
|---|---|---|---|---|
| `tailPts` | `Vector3[]` | S+1 | pose | joint positions on the sphere; `tailPts[0]` is the root at the body rear |
| `tailVel` | `Vector3[]` | S+1 | pose | joint velocities, always tangent to the sphere (index 0 unused) |
| `tailVT` | `Vector3[]` | S+1 | pose | per-substep acceleration accumulator (index 0 unused) |
| `tailQ` | `Vector3[]` | S+1 | pose | analytic guide targets `q[j]`, rebuilt each pose step |
| `tailDirs` | `Vector3[]` | S | pose | unit segment tangents `normalize(pts[i+1]−pts[i])`, the render input |
| `tailCarrier` | `Vector3` | 1 | control | drag axis / orientation memory; re-aims toward behind-heading (read by pose) |
| `tailPhase` | number | 1 | control | traveling-wave phase (rad); advances only while driving/turning (read by pose) |
| `tailLag` | number | 1 | control | turn-lag memory driven by `steer + headingRate`, decayed each step |
| `tailBend` | number | 1 | control | clamped arc bend `= TAIL_RUDDER_GAIN·tailLag`; the only field the body reads |
| `tailGrow` | number | 1 | shared | 0..1 tail-length scale (0 while dividing, ramps down while starving) |
| `tailTransfer` | bool | 1 | sim | set when the parent hands its render slot to the front daughter |

The **control** fields are the only ones that survive a hidden-tail step; the
**pose** fields are frozen while hidden and re-aimed by `warmTail` on re-show.

`makeTailChain` allocates the four `Vector3[]` arrays (40 `Vector3`s total) and
lays the initial chain out along `−heading`, projected to `SURFACE`;
`makeTailDirs` allocates the 9 tangent vectors. `warmTail(sim, d)` re-aims the
chain along behind-heading and zeroes `tailVel`/`tailVT`, but never touches
`tailLag`/`tailBend`/`tailPhase`. The arrays are allocated once at birth and
mutated in place — `updateTailPose` allocates nothing per step.

#### Shared scratch buffers

The chain math reuses scratch objects owned by the simulation (`sim.js`) instead
of allocating: `sim._v1`–`sim._v9` (`Vector3`), `sim._m` (`Matrix4`), `sim._q`
(`Quaternion`), `sim._dummy` (`Object3D`), and `sim._tailDirty` (`Set`).
`updateTailControl`/`updateTailPose` write through these. The self-avoidance
loop no longer aliases `sim._v1` for its joint normals: `cell-bjm` extracts them
once per substep into a module-level `_norm` array (`_norm[i]`/`_norm[k]`), so
`ni` stays valid for every non-adjacent pair.

#### GPU representation (instanced chunks)

- `tailGeo` is a **capless cylinder** (radius 0.014, length 1.0, 6 radial
  segments) rotated so its local **X axis is the segment direction**;
  `tailMat` is a `MeshLambertMaterial` with per-instance color.
- Each segment is one instance, but there is **no `instanceMatrix`**: the chunk
  carries four compact `InstancedBufferAttribute`s — `aSegPos` (vec3 midpoint),
  `aSegX` (vec3 unit axis), `aSegY` (vec3 unit up), `aSegScale` (vec2 = length,
  radius). The vertex shader builds the transform from these (`z = x × y`), so
  only `3+3+3+2 = 11` floats/segment are uploaded instead of 16.
- `sim.tailChunks` is an array of chunks `{ mesh, live, owners, attrs, attrList }`
  where `mesh` is an `InstancedMesh(geo, tailMat, TAIL_CHUNK_SIZE)` with
  `TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS · S = 64 · 9 = 576`, `frustumCulled =
  false`, and `DynamicDrawUsage`. `geo` is a **per-chunk clone** of `tailGeo`
  (the attributes are per-chunk, so they can't live on the shared template).
- A cell holds `tailChunk` (chunk ref) and `tailSlot` (cell slot within it,
  `0..TAIL_CHUNK_CELLS-1`). Its segment `i` lives at flat instance index
  `tailSlot · S + i`, spanning `tailPts[i] → tailPts[i+1]`.
- `owners[slot]` maps a slot back to its cell (needed by swap-remove
  compaction). Slots are packed `0..live-1`, so `mesh.count = live · S`; a freed
  slot is filled by moving the last live slot into it (its attributes are
  recomputed by `placeTail` next frame; its color is rewritten immediately).
  Empty chunks draw nothing and are reused before growing a new chunk. See §5.2
  for the per-frame write path.

### 1.4 Phase timing vs sim speed

Because the phase advances in the sim step (`dt·TAIL_OSC_FREQ`), its frequency
scales with `simRate` automatically. An earlier render-time advance needed a
`TAIL_WAVE_MAX_HZ` Nyquist cap; the chain integrates at the fixed sim substep, so
that cap is not needed.

### 1.5 Kinematic mode (experiment, `cell-h2o`)

`P.TAIL_MODE = 1` replaces the O(S²) spring chain in `updateTailPose` (`tail.js`)
with a purely positional model that answers the question *"what if we
force-rotate the rigid root and let the rest of the tail respond
kinematically?"*:

- The analytic guide spine `q[j]` is still built exactly as in §1.1.
- The root paddle joints `j = 1..TAIL_MOTOR_JOINTS` are **force-rotated straight
  onto** `q[j]` (no guide spring, no lag) and their velocities are zeroed.
- Each remaining joint `j` then **follows the segment ahead** with a first-order
  direction lag: `dir_j ← normalize(lerp(dir_j, dir_{j-1}, 1−e^{−TAIL_FOLLOW_RATE·dt}))`,
  and is placed at `pts[j-1] + dir_j·pitch`, projected back to `SURFACE`.

`P.TAIL_FOLLOW_RATE` sets the response: high = the free tail snaps into a rigid
rod extending the last root segment; low = a floppy, laggy follow. Because the
cascade is spatial *and* temporal, the root's traveling wave propagates tip-ward
with an amplitude ratio `Π 1/√(1+(ω/TAIL_FOLLOW_RATE)²)` and a growing phase
lag — a kinematic undulation rather than an integrated one. There is no
self-avoidance, so a very low rate can fold the tail onto itself; raise the rate
if that appears.

The mode is **pose-only**: `updateTailControl` and the `tailBend` actuator are
untouched, so `npm run test:tail` verifies spring and kinematic worlds produce
identical motion checksums.

## 2. Decoupling invariant

Only `tailBend` feeds motion, and `tailPts`/`tailDirs`/`tailPhase` are cosmetic,
so **toggling the tail display must not change `pos`/`vel`/`heading`/
`headingRate`**. This holds structurally: `advance` always runs
`updateTailControl` (which alone sets `tailBend`), while only `updateTailPose`
and `renderTails` are gated on `tailsHidden`. The chain never feeds back into
the control scalars, so hiding tails can skip the expensive pose but not change
motion.

Guard: `npm run test:tail` (`scripts/tail-equivalence.mjs`) checks

- two seeded-RNG worlds (tails on vs off) produce identical state checksums;
- `warmTail` resets the chain but never `tailLag`/`tailBend`/`tailPhase`;
- `tailPhase` advances by `dt·TAIL_OSC_FREQ` while driving, never when idle, and
  the joints stay on the surface;
- the pose stays finite after a long run.

The harness needs **two discarded warm-up runs** because lazily created
module-level THREE geometry/pool UUIDs consume `Math.random` and shift the
seeded stream. There is no seeded RNG in the app itself.

The one-substep feedback lag (the body consumes the previous substep's
`tailBend`) is kept deliberately; removing it changes loop gain (the "Stage B"
option was dropped).

## 3. What steers vs what is cosmetic

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

## 4. Tuning reference

Plain constants: `TAIL_SEGMENTS` (9 = `round(1.5·MAX_RADIUS/TAIL_LINK)`),
`TAIL_LINK` (0.05), `TAIL_MOTOR_AMP` (40°), `TAIL_DYN_SUB` (4 substeps).
Everything below is a runtime `PARAM_DEFS` entry (Tuner, group `tail`).

| Param | Def | Role |
|---|---|---|
| `TAIL_OSC_FREQ` | 4 | wave angular frequency (rad/s); scales with sim speed |
| `TAIL_WAVE` | 0.35 | phase shift per joint (rad); base→tip positive |
| `TAIL_CARRIER_RATE` | 2 | rate the tail axis re-aims to behind-heading |
| `TAIL_DRAG_K` | 25 | guide stiffness along the tail (lower = more drag lag) |
| `TAIL_MOTOR_K` | 2200 | guide stiffness at the root motor joints (whip) |
| `TAIL_MOTOR_JOINTS` | 3 | number of root joints driven by the motor |
| `TAIL_BEND_K` | 900 | beam stiffness resisting curvature |
| `TAIL_LEN_K` | 4000 | length spring keeping adjacent joints at the pitch |
| `TAIL_LEN_DAMP` | 90 | damping of the length-spring oscillation |
| `TAIL_DAMP` | 1.2 | joint velocity damping per substep |
| `TAIL_CONTACT_D` | 0.04 | self-avoidance contact distance |
| `TAIL_CONTACT_K` | 400 | self-avoidance push strength |
| `TAIL_TRAIL_RATE` | 1 | decay of the turn-lag memory |
| `TAIL_ARC` / `TAIL_ARC_MAX` | 1 / 2 | trailing-arc toggle / cap (rad) |
| `TAIL_RUDDER_GAIN` | 1 | steer → arc bend gain |
| `TAIL_TURN` | 2.5 | `bend` → heading-rate gain (the actuator) |
| `TAIL_HINGE` | 0.5 | how far the hinge tucks into the body |
| `TAIL_LINK_FILL` | 0.95 | drawn fraction of each pitch |
| `TAIL_BODY` | 2 | tail length × body length |
| `TAIL_MODE` | 0 | 0 = spring chain, 1 = kinematic (rigid root + follow) |
| `TAIL_FOLLOW_RATE` | 15 | kinematic mode: free-joint alignment rate (higher = rod-like) |

## 5. Cost

### 5.1 Sim

Control is `O(1)` per cell per step and always runs. Chain integration is
`O(S²·TAIL_DYN_SUB)` per cell per sim step (self-avoidance dominates), S = 9,
substeps = 4 — paid **only while tails are visible** (`updateTailPose`), so the
hidden-tail case now costs just the control pass.

### 5.2 Render path

Tracked as epic `cell-5tt` ("Tail rendering efficiency"). **`.1`–`.5` shipped
2026-09**; only a full GPU chain remains.

- `renderTails()` (`sim.js`): clears each chunk's attribute update ranges, then
  for every cell calls `placeTail`, collecting touched chunks in
  `sim._tailDirty`; one `needsUpdate` per attribute per dirty chunk per frame.
  Returns early when `tailsHidden` (ranges already cleared, so nothing leaks).
- `placeTail` (`cells.js`): 9 segments per cell. For each it writes `aSegPos`
  (midpoint), `aSegX` (unit axis), `aSegY` (up = sphere normal projected off the
  axis), and `aSegScale` (`draw`, `ts`) straight into the typed arrays; `z` is
  derived in the shader, so no cross product is needed. Adds update ranges
  (`base·3`, `S·3` for vec3; `base·2`, `S·2` for scale) when `sim.renderer` is
  set. `sideHidden` cells get `aSegScale = 0` (degenerate, not drawn).
- `tailMat.onBeforeCompile` (materials.js) declares the four attributes and
  replaces `project_vertex` / `worldpos_vertex` with `aSegPos + aSegX·(x·sx) +
  aSegY·(y·sy) + aSegZ·(z·sy)`, and `defaultnormal_vertex` with the inverse-scale
  basis (so the unused zero `instanceMatrix` is never read).
- Slots: `allocTailSlot` packs cell slots contiguously `0..live-1`;
  `freeTailSlot` swap-removes the last live slot into a freed hole (updating
  `owner.tailSlot` + its color); `mesh.count = live·TAIL_SEGMENTS`. A chunk with
  no live cells draws nothing (`count = 0`, hidden in `renderView`) and is reused
  before a new chunk is grown. A cell stores `tailChunk`/`tailSlot` (no global
  index).
- Geometry/material: `tailGeo = CylinderGeometry(0.014, 0.014, 1, 6, 1,
  openEnded)` (the capsule caps were hidden by overlapping segments); `tailMat`
  is a `MeshLambertMaterial`.

### 5.3 Render cost (after `.1`–`.5`)

- **CPU** `placeTail`: still `O(cells·S)` (9 segments per visible cell), but each
  segment is 11 float writes with no matrix build and no cross product (z is
  derived in the shader). Truly `O(cells)` CPU needs the GPU chain.
- **Bandwidth:** `live·S · 11` floats uploaded per chunk via update ranges
  (vs `live·S · 16` matrices before `.5`, and the whole 576-instance ~36 KB
  buffer before `.2`). The unused `instanceMatrix` is never re-uploaded.
- **Draw:** only `live·S` instances submitted per chunk; zeroed far-side and
  reserved slots are excluded from `count`.
- At default ~65 cells → 2 chunks → 585 instances submitted (was 1152, ~half
  degenerate). At `MAX_CELLS = 500` the chunk pool can still grow to 8, but only
  chunks with live cells submit.

### 5.4 Remaining options

**Medium options:** fewer segments (S 9→6) and/or size/distance LOD (reds are
half-size); update tails at 30 Hz; merge each cell's 9 segments into one tube (or
skinned tube) → 1 instance per cell.

**`cell-5tt.5` (shipped) moved the transform to the GPU** but still writes
`O(cells·S)` compact attributes on the CPU. The remaining big win is a **GPU
chain**: integrate the spring chain in a compute/transform-feedback pass so the
CPU only updates a few per-cell scalars (`O(cells)`), or a skinned tube that
samples the CPU chain. With the chain this is harder than for the old analytic
spine — the chain state is `O(S)` per cell, not a few scalars — and is the
highest-ceiling / highest-complexity option (see §6).

**Not useful:** per-chunk `frustumCulled` (chunks span the sphere, so it can't
cull). A `sideHidden` cell still submits a degenerate (zero-scaled) instance —
cheap but not free — because its slot stays inside `count` until the cell dies;
only a fully empty chunk drops to `count = 0`.

## 6. Alternative designs

- **Analytic traveling-wave ribbon** (the model this restore replaced). Compute
  the lateral offset analytically and ease a single pose filter:
  `offset(s,t) = A(drive)·sin(2πft − ks) + rudderBias·s`. Cheap and
  deterministic, but loses the chain's emergent drag/whip detail.
- **Position-history trail.** Ring-buffer recent surface positions/headings and
  render a curve through them. Zero dynamics, natural lag; tail length becomes
  speed-dependent.
- **Bone/IK tail.** 2–3 bones + analytic Bezier bend, skinned tube. O(1)–O(3)
  per cell, trivial LOD, keeps the `tailBend` actuator.
- **GPU population chain.** One compute/transform-feedback pass over a joint
  buffer for all cells. Highest ceiling; large complexity and hard to
  headless-test.

## 7. History & decisions

- The tail is a damped spring-mass chain (guide/length/beam springs +
  self-avoidance, `TAIL_DYN_SUB = 4`) that chases the analytic spine `q[j]`.
- It was briefly replaced by an analytic pose + one lag filter
  (`updateTailBend` control + `updateTailState` pose, epic `cell-asu`), which
  also removed `tailVel`/`tailVT` and the 9 chain tunables and added
  `TAIL_POSE_RATE`. The chain was **restored** because it looks better: it adds
  emergent drag lag, whip, and self-avoidance that the single pose filter
  smoothed away. The physical coupling (`tailBend → headingRate`) is unchanged.
- Restoring the chain also brought back the sim-step phase advance, so wave
  frequency again scales with sim speed without the `TAIL_WAVE_MAX_HZ` cap.
- Former issue (resolved): the self-avoidance loop used to alias `sim._v1` for
  both joint normals (`ni` then `nk`), leaving `ni` stale for the third and
  later non-adjacent pairs. `cell-bjm` (commit `0868790`) now shares a per-joint
  `_norm` array across the accumulate/self-avoidance/integrate loops, so no
  aliasing remains.
- "Stage B" (compute the turn driver before the tail animation, removing the
  one-substep lag) was **dropped**: the lag is harmless and removing it changes
  loop gain.
- Kinematic mode (`P.TAIL_MODE`) added as a `cell-h2o` experiment: the rigid root
  is force-rotated onto the analytic guide and the free tail follows with a
  first-order direction lag. Kept behind a toggle (default 0) so it can be
  compared in the Tuner; both modes are pose-only and motion-equivalent.
- Control/pose split: `updateTailState` was split into `updateTailControl`
  (O(1), always runs) and `updateTailPose` (O(S²·substeps), only while tails are
  visible). The chain reads control scalars but never writes them, so the pose
  can be skipped without changing motion; `warmTail` is called on the
  hidden→visible edge to re-aim the frozen chain.
- Rendering efficiency `cell-5tt.1`–`.5` shipped:
  - `.1` chunk-local packed tail slots with exact `mesh.count` and swap-remove
    compaction;
  - `.2` per-slot partial uploads (one `needsUpdate` per chunk per frame);
  - `.3` direct basis build + sphere-normal up vector;
  - `.4` capless-cylinder `MeshLambertMaterial` segment;
  - `.5` per-segment transform moved to the vertex shader via four compact
    instanced attributes (11 floats/segment, no `instanceMatrix`, `z = x × y`).

  Submitted instances and upload bytes scale with live cells. Headless churn
  verifies the slot/owner invariant and attribute finiteness/orthonormality; the
  motion equivalence test (`npm run test:tail`) is unchanged. Full `O(cells)`
  CPU still requires a GPU chain (§5.4).

## 8. Open follow-ups

- Kinematic mode (`TAIL_MODE`, `cell-h2o`) is an experiment: compare it
  side-by-side in the Tuner against the spring chain and decide whether to keep,
  retune (`TAIL_FOLLOW_RATE`) or drop it. It is cheaper (`O(S)` vs
  `O(S²·TAIL_DYN_SUB)`) but loses emergent self-avoidance/whip detail.
- GPU spring chain (compute/transform-feedback) for `O(cells)` CPU render —
  `cell-5tt.5` shipped only the transform side (§5.4).
- Optional: momentum-driven "C-start" whip (design note §3).
