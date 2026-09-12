# Tail — Model, Decoupling, Tuning & Rendering

> **Status:** current (2026-09). The tail is a **damped spring-chain simulation**
> integrated every sim step. It replaced an earlier analytic control/pose split
> and was restored because the chain looks better. Rendering-efficiency epic
> `cell-5tt`: **`.1`–`.4` shipped**, `.5` (GPU tail) remains.

The tail is a chain of joints on the sphere surface, driven toward an analytic
guide spine `q[j]` and integrated with springs. It shapes the rendered flagellum
and provides the physical steering scalar `tailBend` that turns the body.

## TL;DR

- **Chain, not a filter.** `updateTailState` runs every `advance` for every cell,
  integrating a substep spring chain (guide + length + beam + self-avoidance)
  toward `q[j]` (`cells.js`).
- **Only `tailBend` feeds motion.** `headingRate += TAIL_TURN·tailBend·dt`
  (`sim.js`); everything else (`tailPts`, `tailDirs`, `tailPhase`, the wave) is
  cosmetic.
- **Toggling tails cannot change the simulation.** `advance` always runs the
  chain; `renderTails` only draws. Guarded by `npm run test:tail`.
- **Wave frequency scales with sim speed for free** — the phase advances by
  `dt·TAIL_OSC_FREQ` in the sim step (no render-time Nyquist cap needed).
- **Rendering is the remaining cost.** `cell-5tt.1`–`.4` made draws and uploads
  proportional to live cells (packed slots, exact `mesh.count`, partial uploads,
  cheaper geometry/material); a GPU tail (`cell-5tt.5`) is the only big win left
  — see [§5](#5-cost).

## 1. Model (spring chain)

### 1.1 Step (every `advance`)

`updateTailState(sim, d, dt)` (`cells.js`) runs in `sim.advance` for **every**
cell, even when tails are hidden (`sim.js`):

- re-aims `tailCarrier` toward behind-heading at `TAIL_CARRIER_RATE`
  (orientation memory / drag);
- advances `tailPhase += dt·TAIL_OSC_FREQ` when `drive > 0.02` or
  `|headingRate| > 0.05`;
- integrates `tailLag` from `steer + headingRate`, decaying at `TAIL_TRAIL_RATE`,
  and sets `tailBend = clamp(TAIL_RUDDER_GAIN·tailLag, ±TAIL_ARC_MAX)`;
- builds the analytic guide spine `q[j]` from the root at the body rear
  (`TAIL_HINGE` tuck): each step is the carrier rotated by
  `TAIL_MOTOR_AMP·whip·sin(tailPhase − TAIL_WAVE·j) − TAIL_ARC·bend·j·ramp`,
  where `whip = max(drive, |bend|·1.5)`;
- integrates the chain `tailPts`/`tailVel` toward `q` over `TAIL_DYN_SUB`
  substeps.

In outline:

```text
updateTailState(sim, d, dt):
  n0     = normalize(d.pos)                       # local surface normal
  behind = tangent-project(-d.heading, n0)        # desired drag direction
  if |behind| ~ 0: return
  pitch  = TAIL_BODY * 2 * d.radius / S * d.tailGrow

  # --- control scalars ---------------------------------------------------
  tailCarrier -> behind          at TAIL_CARRIER_RATE   # orientation memory
  if drive > 0.02 or |headingRate| > 0.05:
      tailPhase += dt * TAIL_OSC_FREQ                   # wave phase
  tailLag += (steer + headingRate) * dt;  tailLag -= TAIL_TRAIL_RATE * tailLag
  tailBend = clamp(TAIL_RUDDER_GAIN * tailLag, ±TAIL_ARC_MAX)

  # --- analytic guide spine q[0..S] --------------------------------------
  side = cross(n0, tailCarrier)                   # lateral sweep axis
  root = project(pos - heading * (radius - width*TAIL_HINGE))
  cur  = root
  for j in 0..S:
      q[j] = cur
      if j < S:
          ang = TAIL_MOTOR_AMP*whip*sin(tailPhase - TAIL_WAVE*j)
                - TAIL_ARC*bend*j*ramp          # ramp = 1/(S-1)
          cur = project(cur + rotate(carrier, ang, side) * pitch)

  # --- integrate the chain toward q --------------------------------------
  repeat TAIL_DYN_SUB times:
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

There are two representations: a **per-cell CPU chain** (integrated every step)
and a **shared GPU instance pool** (written once per frame by `placeTail`).

#### Per-cell CPU state

`createCell` builds the chain once via `makeTailChain(pos, heading, radius)` and
stores it on the cell as plain fields (`cells.js`). `S = TAIL_SEGMENTS = 9`, so
there are `S+1 = 10` joints and `S = 9` segments.

| Field | Type | Size | Role |
|---|---|---|---|
| `tailPts` | `Vector3[]` | S+1 | joint positions on the sphere; `tailPts[0]` is the root at the body rear |
| `tailVel` | `Vector3[]` | S+1 | joint velocities, always tangent to the sphere (index 0 unused) |
| `tailVT` | `Vector3[]` | S+1 | per-substep acceleration accumulator (index 0 unused) |
| `tailQ` | `Vector3[]` | S+1 | analytic guide targets `q[j]`, rebuilt every step |
| `tailDirs` | `Vector3[]` | S | unit segment tangents `normalize(pts[i+1]−pts[i])`, the render input |
| `tailCarrier` | `Vector3` | 1 | drag axis / orientation memory; re-aims toward behind-heading |
| `tailPhase` | number | 1 | traveling-wave phase (rad); advances only while driving/turning |
| `tailLag` | number | 1 | turn-lag memory driven by `steer + headingRate`, decayed each step |
| `tailBend` | number | 1 | clamped arc bend `= TAIL_RUDDER_GAIN·tailLag`; the only field the body reads |
| `tailGrow` | number | 1 | 0..1 tail-length scale (0 while dividing, ramps down while starving) |
| `tailTransfer` | bool | 1 | set when the parent hands its render slot to the front daughter |

`makeTailChain` allocates the four `Vector3[]` arrays (40 `Vector3`s total) and
lays the initial chain out along `−heading`, projected to `SURFACE`;
`makeTailDirs` allocates the 9 tangent vectors. `warmTail(sim, d)` re-aims the
chain along behind-heading and zeroes `tailVel`/`tailVT`, but never touches
`tailLag`/`tailBend`/`tailPhase`. The arrays are allocated once at birth and
mutated in place — `updateTailState` allocates nothing per step.

#### Shared scratch buffers

The chain math reuses scratch objects owned by the simulation (`sim.js`) instead
of allocating: `sim._v1`–`sim._v9` (`Vector3`), `sim._m` (`Matrix4`), `sim._q`
(`Quaternion`), `sim._dummy` (`Object3D`), and `sim._tailDirty` (`Set`).
`updateTailState` writes through these; the known `sim._v1` aliasing in the
self-avoidance loop is noted in §7.

#### GPU representation (instanced chunks)

- `tailGeo` is a **capless cylinder** (radius 0.014, length 1.0, 6 radial
  segments) rotated so its local **X axis is the segment direction**;
  `tailMat` is a `MeshLambertMaterial` with per-instance color.
- `sim.tailChunks` is an array of chunks `{ mesh, live, owners }` where `mesh` is
  an `InstancedMesh(tailGeo, tailMat, TAIL_CHUNK_SIZE)` with
  `TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS · S = 64 · 9 = 576`, `frustumCulled =
  false`, and `DynamicDrawUsage`.
- A cell holds `tailChunk` (chunk ref) and `tailSlot` (cell slot within it,
  `0..TAIL_CHUNK_CELLS-1`). Its segment `i` lives at flat instance index
  `tailSlot · S + i`, spanning `tailPts[i] → tailPts[i+1]`.
- `owners[slot]` maps a slot back to its cell (needed by swap-remove
  compaction). Slots are packed `0..live-1`, so `mesh.count = live · S`; a freed
  slot is filled by moving the last live slot into it. Empty chunks draw nothing
  and are reused before growing a new chunk. See §5.2 for the per-frame write
  path.

### 1.4 Phase timing vs sim speed

Because the phase advances in the sim step (`dt·TAIL_OSC_FREQ`), its frequency
scales with `simRate` automatically. An earlier render-time advance needed a
`TAIL_WAVE_MAX_HZ` Nyquist cap; the chain integrates at the fixed sim substep, so
that cap is not needed.

## 2. Decoupling invariant

Only `tailBend` feeds motion, and `tailPts`/`tailDirs`/`tailPhase` are cosmetic,
so **toggling the tail display must not change `pos`/`vel`/`heading`/
`headingRate`**. This holds structurally: `advance` always runs
`updateTailState`, and `renderTails` returns early when `tailsHidden`.

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

## 5. Cost

### 5.1 Sim

Chain integration is `O(S²·TAIL_DYN_SUB)` per cell per sim step (self-avoidance
dominates), S = 9, substeps = 4 — small but nonzero, and paid even when tails
are hidden.

### 5.2 Render path

Tracked as epic `cell-5tt` ("Tail rendering efficiency"). **`.1`–`.4` shipped
2026-09**; `.5` remains.

- `renderTails()` (`sim.js`): clears each chunk's `instanceMatrix` update ranges,
  then for every cell calls `placeTail`, collecting touched chunks in
  `sim._tailDirty`; one `needsUpdate` per dirty chunk per frame. Returns early
  when `tailsHidden` (ranges already cleared, so nothing leaks).
- `placeTail` (`cells.js`): 9 segment transforms per cell. Writes the instance
  matrix directly into `sim._m.elements` from basis columns `(x·draw, y·ts,
  z·ts)` + midpoint (no quaternion round-trip); the up vector is the outward
  sphere normal projected off the segment axis (no reference-axis cross). Adds
  `instanceMatrix.addUpdateRange(slot·16, S·16)` when `sim.renderer` is set.
  `sideHidden` cells are zeroed in the same slot.
- Slots: `allocTailSlot` packs cell slots contiguously `0..live-1`;
  `freeTailSlot` swap-removes the last live slot into a freed hole (updating
  `owner.tailSlot`); `mesh.count = live·TAIL_SEGMENTS`. A chunk with no live
  cells draws nothing (`count = 0`, hidden in `renderView`) and is reused before
  a new chunk is grown. A cell stores `tailChunk`/`tailSlot` (no global index).
- Geometry/material: `tailGeo = CylinderGeometry(0.014, 0.014, 1, 6, 1,
  openEnded)` (the capsule caps were hidden by overlapping segments); `tailMat`
  is a `MeshLambertMaterial`.

### 5.3 Render cost (after `.1`–`.4`)

- **CPU** `placeTail`: still 9 segment transforms per visible cell, but cheaper
  per segment (direct matrix, no quaternion or reference cross).
- **Bandwidth:** only `live·S` matrices uploaded per chunk via update ranges,
  instead of the whole 576-instance (~36 KB) buffer every frame.
- **Draw:** only `live·S` instances submitted per chunk; zeroed far-side and
  reserved slots are excluded from `count`.
- At default ~65 cells → 2 chunks → 585 instances submitted (was 1152, ~half
  degenerate). At `MAX_CELLS = 500` the chunk pool can still grow to 8, but only
  chunks with live cells submit.

### 5.4 Remaining options

| # | Task | Change | Impact |
|---|---|---|---|
| 5 | `cell-5tt.5` | vertex-shader/procedural tail (below) | biggest win |

**Other medium options:** fewer segments (S 9→6) and/or size/distance LOD (reds
are half-size); update tails at 30 Hz; merge each cell's 9 capsules into one
tube (or skinned tube) → 1 instance per cell.

**Biggest win — `cell-5tt.5` vertex-shader tail.** Upload a handful of per-cell
scalars as instanced attributes and compute each segment transform in the vertex
shader (or drive a skinned tube): CPU becomes O(cells) attribute writes, with no
per-segment matrices and no large uploads. With the chain this is harder than for
the old analytic spine — the chain state is `O(S)` per cell, not a few scalars —
so a GPU chain (below) or a skinned tube that samples the CPU chain is the
realistic path.

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
- Known issue (restored): the self-avoidance loop aliases `sim._v1` for both
  joint normals (`ni` then `nk`), so `ni` is stale for the third and later
  non-adjacent pairs. This is faithful to the original — see §8.
- "Stage B" (compute the turn driver before the tail animation, removing the
  one-substep lag) was **dropped**: the lag is harmless and removing it changes
  loop gain.
- Rendering efficiency `cell-5tt.1`–`.4` shipped: chunk-local packed tail slots
  with exact `mesh.count` and swap-remove compaction, per-slot partial
  `instanceMatrix` uploads (one `needsUpdate` per chunk per frame), direct
  matrix build + sphere-normal up vector, and a capless-cylinder
  `MeshLambertMaterial` segment. Submitted instances and upload bytes now scale
  with live cells. Headless 240s churn verifies the slot/owner invariant; the
  motion equivalence test (`npm run test:tail`) is unchanged.

## 8. Open follow-ups

- Fix the `_v1` aliasing in the self-avoidance loop (use a second scratch
  vector); check it doesn't change the look.
- Vertex-shader/procedural tail: `cell-5tt.5` (§5.4).
- Optional: momentum-driven "C-start" whip (design note §3).
