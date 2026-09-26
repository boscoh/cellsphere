# CellSphere — Design & Session State

This doc captures the current architecture, tuning values, decisions, gotchas,
and in-progress work so a fresh session can pick up quickly.

## Overview

A Vue 3 + Three.js simulation of bacteria grazing on the **surface of a solid
(opaque) sphere**. Bacteria are elongated **capsules** with a segmented
**flagellum tail** that undulates while swimming and swings to drive turns.
The sphere is covered in dark food specks arranged in **clumps**; bacteria
sense food, slow down, turn toward concentration, eat to grow, and eventually
**mitose** into two daughters.

`src/App.vue` is a thin Vue shell (lifecycle, single-line top-left HUD, frame
timing). The simulation is split into modules: `src/sim.js` (`Simulation`
orchestrator: physics loop + cell/food data; the render lifecycle is delegated
to `src/view.js`), `src/view.js` (`View`: scene/camera/renderer/controls, pooled
meshes and render scratch), `src/renderSync.js` (render-side pool reconcile),
`src/collision.js` (capsule
distance, cell hash, collision solve), `src/grid.js` (spatial hash key packing
and neighbourhood scan), `src/cells.js` (cell domain — create/grow/mitose),
`src/bodyPool.js` (pooled body instances per length bucket), `src/tailPool.js`
(tail instance pool, slot claims/transfers, segment placement), `src/tail.js`
(tail physics — steering control and spring-chain pose), `src/gait.js` (opt-in
alternating turn/move locomotion; `GAIT_MODE = 0` is a no-op), `src/food.js` (food
grid, eating + sensing, clumps), `src/foodRender.js` (food mesh create/sync from
`food.dirty`); tuning constants in `src/constants.js`;
scene/lights in `src/sceneSetup.js` (`createSceneCore` + `attachGraphics`);
shared geos/materials in
`src/materials.js`; pure helpers in `src/math.js`; dependency-free script/test
helpers (seeded `mulberry32`) in `src/util.js`.

## How it works (architecture)

- **Sphere surface model**: bacteria/food rest at `SURFACE = SPHERE_RADIUS +
  SHELL_GAP` (just above the opaque `FrontSide` shell). No boundary.
  `SPHERE_RADIUS` is a tunable World parameter that rebuilds the world and
  resizes the shell; `SURFACE` is a live binding kept in sync by `setParam`.
  Background/fog and the shell are a dark greenish family.
- **Data-object cells**: a bacterium is a plain data object (no `THREE.Group`):
  surface `pos`, tangent `vel`, tangent `heading`, `headingRate`, `quat`,
  `radius/mass/breed/color`, tail control (`tailPhase`, `tailLag`, `tailBend`,
  `steer`) and the spring chain (`tailCarrier`, `tailPts`, `tailVel`, `tailVT`,
  `tailQ`, `tailDirs`), growth and mitosis state. Physics in `sim.js`
  reads/writes these directly.
- **Bodies** render via **pooled `InstancedMesh`es** keyed by length bucket
  (`bodyGeoCache` + `bodyPools`): `addBody/removeBody/rehomeBody` manage a free
  list per bucket chunk; per-instance color (`setBodyColor`) plus a custom
  `aAura` attribute drive color and the rim marker — a latched prey at full
  brightness, an eaten dividing unit at its ramping aura.
  `renderBodies` composes each cell's matrix from `pos/quat`, scaling it by
  `fade` (mitosis uses it to shrink the fading mother to nothing). Each bucket grows on demand in
  `BODY_CHUNK_CELLS` chunks rather than reserving `MAX_CELLS` up-front; each
  chunk clones its geometry template (its per-instance attributes must be
  independent) and is detached from the scene when it empties.
- **Tails** render as **chunked `InstancedMesh`es** of capless-cylinder segments
  (`TAIL_CHUNK_CELLS*TAIL_SEGMENTS` each, `MeshLambertMaterial`); per-cell color
  set from `createCell`/`setSize` (`setTailColor`, pool-owned). Cell slots are packed
  contiguously from `0..live-1` (`claimTailSlot`) and holes are closed by
  swap-remove on death, so `mesh.count = live*TAIL_SEGMENTS` excludes every
  unused instance (a chunk with no live cells draws nothing). Each segment is one
  instance but carries **no `instanceMatrix`**: `placeTail` writes four compact
  instanced attributes (`aSegPos`, `aSegX`, `aSegY`, `aSegScale`) and the
  `tailMat` vertex shader builds the transform (`z = x × y`), uploading only the
  touched slots via `addUpdateRange` and batching one `needsUpdate` per chunk per
  frame. Tails hidden = skip `renderTails` (placement), hide the chunk meshes
  (`View.tailsHidden`), and skip the cosmetic pose in `advance` (sim-owned
  `poseEnabled`); the physical
  control (`updateTailControl` → `tailBend`) always runs in `advance`, so
  steering is unaffected. `warmTail` re-aims the frozen chain on re-show.
- **Linear motion**: `drive = slow × (1 − coast) × fatigue`; thrust
  `THRUST*drive` along heading; high `DRAG` bleeds velocity. Three mostly-
  exclusive energy bands: near max (`coast`, above `MITO_SLOW_FRAC`) the cell
  eases to a stop to split; mid band it drives full; toward zero (`fatigue`,
  below `STARVE_SLOW`) a starving cell slows. `slow` likewise ramps to ~0 near
  food (graze). Reds additionally **ambush**: `drive` is scaled by `PRED_COAST`
  while no prey is within `PRED_LUNGE`, so a red cruises slowly and bursts when
  a green comes close. Steering stays active regardless of `drive`. An **opt-in
  alternating gait** (`GAIT_MODE`, `src/gait.js`, `cell-d4z`) can instead cut
  `drive` and boost `steer` in a TURN phase and scale them by a forward mode
  (general / drift / eat) in a MOVE phase; it edits only `drive`/`steer`, so with
  it off the locomotion above is unchanged. See `NOTES.md` §5.
- **One consistent time loop**: `App.vue` banks real time in an accumulator
  and calls `sim.step(simDt×simRate)`; `step` subdivides into
  `clamp(ceil(simDt/FIXED_DT),1,MAX_STEPS)` substeps of `advance(dt)`. Render
  is separate (`sim.render(tailScale, dt)` delegates to the `View`). Headless
  physics: `buildWorld()` + `step()` work with no `View`/WebGL and allocate no
  render resources at all.
- **Sim/view split**: render resources — scene, camera, renderer, controls,
  lights and shell, pooled body/tail meshes, food and death-burst meshes, and
  render scratch — live on `src/view.js`'s `View`, created by `sim.attach()`.
  `renderSync.syncCells(view)` reconciles pool slots from the cell list, food
  matrices upload from `food.dirty`, and the cosmetic tail pose is gated by the
  sim-owned `poseEnabled` (set from the HUD toggle). `advance()` touches no GPU
  buffer and reads no render state. `npm run test:headless` guards that physics
  modules never import a render module.
- **Food**: one `InstancedMesh`; spatial hash (`GRID`) limits lookups;
  `eatAndRespawn` (per substep, tight scan) and `concentration`
  (every `SENSE_PERIOD`, wide scan) update `slow/foodAmt/foodPeak/foodDir`.
- **Scan radii** are derived, never hardcoded: `grid.scanRadius(threshold +
  halfLenA + halfLenB, period)` in `concentration`, `predatorSense` and the
  predation latch. The threshold is a capsule *gap* while `forEachNearby` walks
  buckets around the sensor's *centre*, so both capsule half-lengths have to be
  added or reach is silently clipped (cell-qjo.1, cell-kkl). `eatAndRespawn`
  keeps `r = 1`: `foodDist` is point-to-capsule, so no half-length applies.
- **Predation**: a red latches one green within `PRED_RANGE` and drains it at a
  fixed `PRED_DRAIN`/s (gaining `PRED_EFF` of that). Holding only one prey at a
  time means a red's eating rate levels off when prey are common — the classic
  recipe for a predator boom-and-bust. So the bite is scaled by how much prey
  there is *per predator* (`ratio/(ratio + PRED_RATIO)`), and hunting stops
  entirely once there is less than one prey per predator: a refuge that lets
  scarce prey recover. Unfed reds burn `METABOLISM + PRED_METABOLISM +` move/turn
  cost and die, so they cannot finish off the last prey. See `NOTES §1.5`,
  `§1.6`.
- **Net effect**: these rules give a **bounded predator–prey cycle**, not a steady
  state — reds follow greens with roughly a quarter-cycle lag and both persist.
  Four things keep it from tipping into overshoot-and-collapse: predators share
  scarce prey (`PRED_RATIO`), rare prey get a refuge (the stop-hunting gate),
  unfed reds starve quickly, and prey have their own regrowing food. See
  `NOTES §1` (executive summary) and `§1.6`.
- **Cell–cell collision**: true capsule–capsule min distance; soft spring +
  positional correction + a heading kick; pairs limited by a cell spatial hash
  (`CELL_GRID`). Splitting daughters are excluded; a dividing **parent stays as
  an immovable collision proxy** (the assembly parent, inverse mass 0, sized to
  the unit's `proxyR` envelope) until the daughters separate.
- **Rotation**: `headingRate` is yaw about the surface normal, damped by
  `ANG_DRAG`. It is generated by the tail steering bend
  (`headingRate += TAIL_TURN*tailBend`): chemotaxis (turn toward food gradient
  when `foodPeak > PEAK_MIN`) and predator/prey gradients feed `steer`, which the
  tail control turns into `tailBend`; collision kicks add directly. No random
  tumble. Note `drive` does **not** enter this equation: turn rate is set by the
  tail alone, so an agent cannot turn around sooner by slowing — slowing only
  shrinks the turn radius R = v/ω (see `NOTES.md` §1.5D, `cell-1eo`).
- **Energy → size & death**: the whole growth/starvation loop is one value,
  `d.energy` in `[0, ENERGY_MAX]`. `radius = MIN_RADIUS + (energy/ENERGY_MAX)*(MAX_RADIUS-MIN_RADIUS)`
  (linear food→energy→length). Eating (`gainEnergy`, +`ENERGY_PER_FOOD`) grows it;
  `METABOLISM` (energy/s) drains it every `advance`, plus **locomotion costs**:
  `MOVE_COST` per second at full `drive` (swimming effort) and `TURN_COST` per
  second at full `MAX_SPIN` (turning effort). A cell therefore burns energy
  faster when it swims and turns hard, so a starved cell **shrinks**
  back toward `MIN_RADIUS`. At `energy <= 0` the cell **dies at once** — no
  fade-out — spawning a short additive **death burst** that flashes and fades to
  nothing (see Scene look). At `energy >= ENERGY_MAX` it
  goes `split` → mitosis. Food is **consumed on contact** (removed from the
  sphere), but the cell converts only up to `ABSORB_RATE` energy/s into energy —
  food beyond that (and food a nearly-full cell touches) is eaten but wasted.
- **Energy → mitosis**: at full energy, `mitose()` spawns two daughters, each
  at **half the parent's length** so both fit exactly inside the parent's
  outline. The two daughters face each other so their tails stream outward; see
  `NOTES.md` §1.5A for the post-division food-seeking problem. The parent
  **shrinks through the ledger handover** (its length falls toward the floor as
  the daughters grow from theirs, and `fade` scales the last of it to nothing), then its mesh is dropped but it **keeps
  colliding** until the daughters finish separating; `assemblyRelease` marks it dead
  and releases the daughters (with a `MITO_REST` coast). The exit window
  (`MITO_REST` + `MITO_FORAGE`) is a deliberate pivot: each daughter steers away
  from her sibling (`MITO_AWAY_TURN`) while the forage re-aim waits, and
  `MITO_TURN_CAP` caps the heading rate — otherwise the re-aim and any collision
  kick hold her at `MAX_SPIN`, which reads as thrashing and whips the tail (see
  `NOTES.md` §1.8). Because metabolism keeps
  draining, a full cell that can't split (cap pressure) shrinks and resumes
  moving instead of parking at max and starving.
  The division is one `asm` record (on `sim.assemblies`), advanced by
  `updateAssemblies` and ended by `assemblyRelease`; `d.asm` is set on all three
  members, so `d.asm !== null` is the in-window predicate and the ledger (`L0`,
  `h`) conserves the length handed from the mother to her daughters. A unit an
  eater is draining broadcasts a ramping `d.aura` to all three members behind
  `MITO_AURA`; render reads `max(d.aura, d.paralysed)`.
  Behind `MITO_VULNERABLE` (on by default) an exposed mother becomes prey; the
  gate and its two narrowings (`MITO_VULN_FRAC`, `MITO_DRAIN_SCALE`) are a large,
  seed-dependent lever - see the sweep in `NOTES.md` §1.9 J before enabling it.
- **Tail model (spring chain)**: `sim.advance` splits the tail into an O(1)
  **control** pass (`updateTailControl`, every cell every step) and an
  O(S²·substeps) **pose** pass (`updateTailPose`, only while tails are visible).
  Control advances `tailPhase` while driving/turning, integrates `tailLag` from
  `steer + headingRate` (decaying at `TAIL_TRAIL_RATE`), and derives
  `tailBend = clamp(TAIL_RUDDER_GAIN·tailLag, ±TAIL_ARC_MAX)`. `tailBend` feeds
  the body as `headingRate += TAIL_TURN·tailBend` (the only physical coupling).
  Pose builds an analytic guide spine `q[j]` from the root at the body rear
  (hinge tucked by `TAIL_HINGE`), each step being the carrier direction rotated
  by `TAIL_MOTOR_AMP·whip·sin(tailPhase − TAIL_WAVE·j)` (traveling wave) minus
  `TAIL_ARC·bend·j·ramp` (trailing arc), where `whip = max(drive, |bend|·1.5)`.
  The chain `tailPts`/`tailVel` chases `q` over `TAIL_DYN_SUB` substeps with
  guide springs (stiff at the root `TAIL_MOTOR_K`, weak drag `TAIL_DRAG_K`),
  neighbour length springs (`TAIL_LEN_K`/`TAIL_LEN_DAMP`), local beam stiffness
  (`TAIL_BEND_K`), and contact self-avoidance (`TAIL_CONTACT_D`/`K`); velocities
  are damped (`TAIL_DAMP`) and positions projected to `SURFACE`. `placeTail`
  draws `TAIL_LINK_FILL` of each pitch; tail length is `TAIL_BODY·2·radius`
  (scales with body size). `warmTail` re-aims the chain and zeroes joint
  velocities, never `tailLag`/`tailBend`/`tailPhase`.
  An alternative O(S) **kinematic mode** (`TAIL_MODE = 1`) skips the spring
  integration: the rigid root is force-rotated onto the guide and each free
  joint follows the segment ahead at `TAIL_FOLLOW_RATE`. It is ~3× cheaper and
  cannot fold, but loses the chain's emergent drag/whip — see `NOTES.md`
  (Tail → kinematic mode). `TAIL_MODE` is switchable live in the Tuner.

## Current tuning constants (`src/constants.js`)

<!-- BEGIN GENERATED: tuning constants -->
_Fixed constants (not tunable at runtime)._

| Parameter | Default | Role |
|---|---|---|
| `ACF_MAX_S` | 1800 | largest autocorrelation window, in sim seconds: the retained span (`POP_WINDOW_S`), so the panel cannot ask for more history than the window holds |
| `ACF_MIN_S` | 600 | smallest autocorrelation window, in sim seconds (used when no textbook period is available) |
| `BODY_CHUNK_CELLS` | 64 | cells per body instance chunk |
| `CELL_GRID` | 1 | cell spatial-hash cell size |
| `CULL_COS` | 0 | cos(normal, cam) at or below which a tail is culled |
| `ENERGY_MAX` | 1 | energy at which a cell divides; size is linear in energy |
| `FIXED_DT` | 0.0166667 | physics substep, in seconds (1/60) |
| `FOOD_RADIUS_MAX` | 0.04 | maximum per-particle food radius; feeds the sense-scan radius |
| `FOOD_RADIUS_MIN` | 0.016 | minimum per-particle food radius |
| `GRID` | 0.35 | food spatial-hash cell size |
| `MAX_CELLS` | 500 | logical population ceiling; pools grow on demand rather than reserving it |
| `MAX_RADIUS` | 0.3 | radius at full energy; chosen so a full cell exactly spans both daughters |
| `MAX_SIM_RATE` | 50 | speed slider cap, and the `SIM_SPEED` parameter maximum |
| `MAX_STEPS` | 200 | per-frame substep ceiling |
| `MIN_RADIUS` | 0.1 | radius at zero energy |
| `POP_WINDOW_S` | 1800 | sim-time span of the sliding population window both chart panels read; older samples are dropped, so nothing grows with run length |
| `SAMPLE_DT` | 0.5 | sim-time spacing between population-history samples; fixed so sample spacing stays constant at any speed |
| `SHELL_GAP` | 0.06 | gap between the collision surface and the sphere shell mesh |
| `START_RADIUS` | 0.13 | spawn radius |
| `SURFACE` | 5.06 | surface offset (`SPHERE_RADIUS + SHELL_GAP`); every entity is placed here |
| `TAIL_CHUNK_CELLS` | 64 | cells per tail instance chunk |
| `TAIL_DYN_SUB` | 4 | spring-chain substeps per step |
| `TAIL_LINK` | 0.05 | tail link pitch; `TAIL_SEGMENTS = round(1.5 * MAX_RADIUS / TAIL_LINK)` |
| `TAIL_MOTOR_AMP` | 0.349066 | tail wave amplitude (40 degrees, in radians) |
| `TAIL_SEGMENTS` | 9 | tail segments per cell |
| `WIDTH` | 0.085 | base body width; per-cell width is `WIDTH * RED_SIZE` for reds |

_Editable at runtime in the Tuner (`PARAM_DEFS`)._

**World**

| Parameter | Default | Role |
|---|---|---|
| `SPHERE_RADIUS` | 5 | Radius of the sphere cells live on (rebuilds). Larger = more surface area, so a fixed-size cell looks smaller relative to the world. |
| `PREY_COUNT` | 50 | Number of prey (green) cells spawned when the world is (re)built. |
| `PRED_COUNT` | 15 | Number of predator (red) cells spawned when the world is (re)built. |
| `SIM_SPEED` | 10 | Simulation speed applied on startup and whenever the world is restarted or Default is pressed (1x = real time). The HUD time slider changes the live speed only; this startup speed is not touched by it. |
| `FOOD_COUNT` | 3000 | Total food particles spawned when the world is (re)built. |
| `FOOD_CLUMPS` | 12 | Number of food clusters (0 = none; rebuilds). |
| `FOOD_SCATTER` | 0.15 | Share of food placed uniformly instead of in clumps (rebuilds). |
| `FOOD_CLUMP_WIDE` | 1 | Angular spread of each clump (rebuilds). |
| `FOOD_RESPAWN` | 40 | Base seconds before an eaten food particle reappears. |

**Movement**

| Parameter | Default | Role |
|---|---|---|
| `THRUST` | 12 | Forward acceleration along the heading, scaled by drive (0..1). |
| `DRAG` | 22 | Velocity damping rate (1/s) resisting cell motion. |
| `ANG_DRAG` | 22 | Heading-rate damping (1/s); matches linear DRAG so turns stop as fast as translation. |
| `MAX_SPIN` | 2 | Hard cap on turning rate (rad/s). |
| `STEER_GAIN` | 0.5 | Maps the food-gradient angle into a tail steering command (-1..1). |
| `COLLISION_KICK` | 0.5 | Strength of the heading deflection when cells collide. |
| `MITO_SLOW_FRAC` | 0.9 | Energy fraction above which a cell begins coasting toward mitosis (keeps seeking food until just before dividing). |
| `PEAK_MIN` | 0.18 | Minimum gradient sharpness required before chemotaxis steers. |

**Gait (turn/move)**

| Parameter | Default | Role |
|---|---|---|
| `GAIT_MODE` | 1 | 0 = continuous steering+thrust (current behaviour); 1 = alternate a TURN phase with a MOVE phase (cell-d4z). |
| `GAIT_PREY` | 1 | Apply the alternating gait to prey (green) when GAIT_MODE = 1. |
| `GAIT_PRED` | 1 | Apply the alternating gait to predators (red) when GAIT_MODE = 1. |
| `GAIT_TURN_ON` | 0.45 | Steering demand |steer| at which a MOVE phase ends and a TURN phase begins. |
| `GAIT_TURN_OFF` | 0.15 | Steering demand at or below which a TURN phase ends and MOVE resumes. |
| `GAIT_MOVE_TIME` | 0.8 | Seconds a cell holds a straight MOVE phase before re-aligning (if it still has steering demand). |
| `GAIT_TURN_TIME` | 0.35 | Maximum seconds a TURN phase lasts, even if the target keeps moving. |
| `GAIT_TURN_DRIVE` | 0.2 | Forward-drive multiplier during a TURN phase; low = pivot in place, higher = keep closing while turning. |
| `GAIT_TURN_STEER` | 1.5 | Steering multiplier during a TURN phase. |
| `GAIT_MOVE_STEER` | 0.5 | Steering multiplier in the general/drift MOVE modes; < 1 makes the straight run straighter. |
| `GAIT_DRIFT_DRIVE` | 0.3 | Forward-drive multiplier for the drift mode (well-fed cells coast instead of swimming). |
| `GAIT_EAT_DRIVE` | 1 | Forward-drive multiplier for the slow-eat mode (stacks on the existing graze slowdown). |
| `GAIT_EAT_SLOW` | 0.9 | Food-contact slow factor at or below which a cell is in slow-eat mode (1 = never, GRAZE_RATE = always in contact). |
| `GAIT_DRIFT_FRAC` | 0.6 | Energy fraction above which a non-eating cell drifts rather than swimming at full drive. |
| `GAIT_TUMBLE` | 0 | Seconds a target-less cell swims before a random tumble turn, so it re-searches instead of running straight (0 = off; run-and-tumble). |
| `GAIT_TUMBLE_STEER` | 1 | Steering command magnitude of a random tumble turn. |

**Collision**

| Parameter | Default | Role |
|---|---|---|
| `SPRING` | 22 | Stiffness of the soft cell-cell collision response. |

**Sensing & Feeding**

| Parameter | Default | Role |
|---|---|---|
| `SENSE_BOOST` | 0.25 | Extra sensing reach added to the body radius. |
| `SENSE_PERIOD` | 0.05 | Seconds between chemotaxis sampling passes. |
| `SENSE_MODE` | 0 | 0 = per-spec food scan, 1 = clump-attractor sensing (Tier-2 prototype, cell-qjo.5). |
| `GRAZE_RATE` | 0.01 | Drive factor while well fed (lower = lazier drifting). |
| `GRAZE_GAIN` | 6 | How quickly feeding drops drive toward the graze rate. |
| `GRAZE_RADIUS` | 0.25 | Extra radius beyond body width within which food slows the cell (drive); the wider SENSE_BOOST range only steers. At SENSE_BOOST this reproduces the original all-range slowdown; lowering it keeps speed until closer to food, but speeds up the whole ecology and increases predator/prey oscillation (cell-11i). |
| `FORAGE_TURN` | 20 | Extra heading-rate gain toward the food gradient during the post-division forage window (cell-x93). |
| `ENERGY_PER_FOOD` | 0.05 | Energy gained per food particle absorbed. |
| `ABSORB_RATE` | 0.1 | Max energy a cell can absorb per second (absorption is always rate-limited). |

**Mitosis**

| Parameter | Default | Role |
|---|---|---|
| `MITO_TIME` | 80 | Duration (sim seconds) of the full division sequence — the mitosis animation. Also the physics window: during it the parent is an immovable collision proxy and the daughters are inactive, invulnerable and food-blind. Raised 5 → 10 → 20 → 80 (16x the original) for a slow, legible division; very large values freeze a big fraction of the population in mitosis. |
| `MITO_HOLD` | 0.2 | Fraction of mitosis before the parent starts fading. |
| `MITO_FADE` | 0.4 | Fraction of mitosis over which the parent fades out. |
| `MITO_NEAR` | 2.1 | Starting separation (x half child length) as daughters form. |
| `MITO_SEP` | 2.45 | Final separation (x half child length) at division release. The daughters ease from MITO_NEAR to MITO_SEP over MITO_DRIFT. |
| `MITO_DRIFT` | 0.2 | Fraction of MITO_TIME the daughters spend easing from MITO_NEAR to MITO_SEP, starting when the handover ends (MITO_HOLD + MITO_FADE). The division releases at the end of the drift, so there is no frozen daughter time; 0 releases right at the end of the handover. |
| `MITO_DETACH` | 0.8 | Seconds a feeding predator spends separating from its prey before it can divide. |
| `MITO_REST` | 4 | Coast (no-drive) seconds for daughters right after division. |
| `MITO_FORAGE` | 6 | Seconds after division during which a daughter ignores the grazing slowdown and turns hard toward sensed food, so it can leave the parent spot on its own heading (cell-x93). |
| `MITO_AWAY_TURN` | 20 | Heading-rate gain for turning away from the sibling while a daughter coasts through MITO_REST. Daughters are born facing each other (their tails stream outward), so without it both drive straight into each other the moment drive resumes (cell-jyg). 0 = old behaviour. |
| `MITO_TURN_CAP` | 0.5 | Heading-rate ceiling (rad/s) for a daughter through her post-division exit window (MITO_REST + MITO_FORAGE). The post-division re-aim and any collision kick otherwise pin her at MAX_SPIN, which reads as thrashing and whips the tail through tailBend; a gentler cap turns the exit into a smooth pivot (cell-jyg). 0 = no turn at all. |
| `MITO_VULNERABLE` | 1 | Master gate: an exposed dividing mother becomes valid prey, so a red can latch and drain her for the rest of the window. The daughters stay invisible — they are not in the cell grid — so only the mother is reachable. Default 1 = on; the 3600 s sweep in NOTES 1.9 J found it a large, seed-dependent lever (reds can collapse, prey can saturate), so 0 is the conservative setting. |
| `MITO_VULN_FRAC` | 0.2 | Fraction of the mitosis window after which the mother is exposed. Default MITO_HOLD: the handover curve retires her body by MITO_HOLD + MITO_FADE = 0.6, so a later gate would expose an already-invisible parent. |
| `MITO_DRAIN_SCALE` | 0.5 | Bite-rate multiplier while the target is a dividing unit. It multiplies with the MITO_VULN_FRAC gate, so only one of the two narrowings may be spent — see the bite-budget table in docs/NOTES.md 1.9 G before re-tightening both. |
| `MITO_AURA` | 1 | Cosmetic gate on the assembly aura channel: 1 ramps the rim marker in while a dividing unit is being eaten and out when the bites stop, 0 forces it off. The predator-latched rim glow is unaffected. |

**Survival**

| Parameter | Default | Role |
|---|---|---|
| `METABOLISM` | 0.0015 | Energy drained per second while alive (0 = no drain). |
| `MOVE_COST` | 0.001 | Extra energy drained per second at full drive (scales with swimming effort). |
| `TURN_COST` | 0.001 | Extra energy drained per second at full spin (scales with turning effort). |
| `STARVE_SLOW` | 0.3 | Energy fraction below which a starving cell progressively slows (0 = no slowdown). |

**Tail**

| Parameter | Default | Role |
|---|---|---|
| `TAIL_OSC_FREQ` | 4 | Tail wave frequency (Hz) while driving or turning. |
| `TAIL_WAVE` | 0.35 | Phase shift per joint (rad). Positive travels base->tip, negative travels tip->base. |
| `TAIL_CARRIER_RATE` | 2 | Rate the tail axis re-aims toward the body heading. |
| `TAIL_DRAG_K` | 25 | Guide-spring stiffness along the tail (higher = the whole chain follows the wave, less drag lag). |
| `TAIL_MOTOR_K` | 2200 | Guide stiffness at the root motor joints (whip). |
| `TAIL_MOTOR_JOINTS` | 3 | Number of root joints driven by the head motor. |
| `TAIL_BEND_K` | 900 | Local beam stiffness resisting tail curvature. |
| `TAIL_LEN_K` | 4000 | Spring keeping adjacent joints at the link spacing. |
| `TAIL_LEN_DAMP` | 90 | Damping of the tail length-spring oscillation. |
| `TAIL_DAMP` | 1.2 | Velocity damping applied to tail joints per substep. |
| `TAIL_CONTACT_D` | 0.04 | Contact distance for tail self-avoidance. |
| `TAIL_CONTACT_K` | 400 | Self-avoidance push strength on contact. |
| `TAIL_TRAIL_RATE` | 1 | How fast tail-lag memory decays after turns. |
| `TAIL_ARC_MAX` | 2 | Hard cap (rad) on the trailing arc bend. |
| `TAIL_RUDDER_GAIN` | 1 | Maps accumulated heading turn into the arc bend. |
| `TAIL_ARC` | 1 | 0 = no trailing arc (pure travelling wave), 1 = arc on. |
| `TAIL_HINGE` | 0.5 | How far the tail hinge tucks into the body (fraction of body width; 0 = rear tip, 1 = deepest). |
| `TAIL_TURN` | 2.5 | Heading-rate gain from the tail steering bend (tail drives the turn). |
| `TAIL_LINK_FILL` | 0.95 | Fraction of link spacing covered by each segment mesh. |
| `TAIL_BODY` | 2 | Total tail length as a multiple of body length. |
| `TAIL_MODE` | 0 | 0 = spring-chain tail, 1 = force-rotated rigid root + kinematic follow. |
| `TAIL_FOLLOW_RATE` | 15 | Kinematic mode: rate each free joint aligns to the segment ahead (higher = stiffer/rod-like). |

**Predator**

| Parameter | Default | Role |
|---|---|---|
| `PRED_RANGE` | 0.18 | Latch distance to a green (capsule gap). |
| `PRED_SENSE` | 1.5 | Distance over which a red smells prey; nearby greens are weighted into a gradient direction. |
| `PRED_BITE` | 0.18 | Distance at which draining proceeds (>= range so a latched prey is bitten). |
| `PRED_OVERLAP` | 0.03 | How far a feeding predator sinks into its latched prey (contact distance minus this). |
| `PRED_DRAIN` | 0.02 | Green energy drained per second. Raised from 0.012 so a red eats faster and the red curve briefly overshoots the green curve (NOTES 1.5C). |
| `PRED_EFF` | 1 | Energy red gains per second as a multiple of the drain (1 = matches the drain); also sets how fast reds divide. |
| `PRED_METABOLISM` | 0.001 | Extra energy per second a red burns while it has no prey latched, so unfed predators die quickly. |
| `PRED_DRIVE` | 0.9 | Red speed multiplier (<1 = slower). |
| `PRED_LUNGE` | 0.6 | Distance (capsule gap) within which a red bursts forward; farther out it coasts (ambush). |
| `PRED_COAST` | 0.35 | Drive multiplier while no prey is within PRED_LUNGE (1 = no ambush, 0 = full stop). |
| `PRED_FOCUS` | 1 | Exponent on the prey-proximity weight (1 = linear; higher focuses the gradient on the nearest prey). |
| `PRED_REORIENT` | 1.5 | Seconds after finishing a meal that a red steers at the nearest prey and ignores both the ambush coast and the energy coast (0 = off). |
| `REORIENT_TURN` | 20 | Extra heading-rate gain toward the nearest prey during the post-meal reorient window (cell-700). |
| `PRED_HUNT` | 1 | Seconds after a red newly smells prey that it turns hard at the nearest green. Event-limited like the post-meal window, so it re-aims instead of arcing without making reds permanently agile (cell-zby). |
| `PRED_TURN_SLOW` | 0 | How much a red throttles back while its heading is off the nearest prey: drive *= 1 - PRED_TURN_SLOW*(1-cos(error))/2. Higher = tighter pivot turns but slower hunting (cell-1eo). |
| `PRED_RATIO` | 0.75 | Prey-per-predator ratio at which a red hunts at half strength (ratio-dependent response); lower = weaker suppression so reds can overshoot green before starving; 0 = off (overshoot then collapse). Lowered 1 to 0.75 so a transient red > green overshoot appears while 1800 s runs still survive. |
| `PRED_CROWD` | 0 | Extra drain per additional prey packed within PRED_SENSE: rate *= 1 + PRED_CROWD*(nearby-1). 0 = a clump is not a feast; higher = a shoal feeds a red faster (cell-3bz). |
| `PRED_T3_HALF` | 0 | Prey visible within PRED_SENSE at which a red bites at half its full rate. The bite scales as a smooth sigmoid (Hill, exponent 2) in local prey count, so one lone green is hard to catch while a shoal is easy: a continuous rare-prey refuge that can stand in for the hard stop-hunting gate. 0 = off (Type II, density-independent bite). |
| `RED_SIZE` | 0.5 | Red body size as a fraction of green (0.5 = half size). |
<!-- END GENERATED: tuning constants -->

Reactive UI: single-line **HUD top-left** — `CellSphere · Fps · Cells (green/red) · Food
| Speed slider × | Tails checkbox | Cycles checkbox | Tuner · Restart`. `simRate`
default **10×**, min 1, max `MAX_SIM_RATE = 50`, step 1. The parameter Tuner is
top-right, the population chart bottom-left, drag hint bottom-center. Both chart
panels read **one sliding window** of `POP_WINDOW_S = 1800` s of sim time, which
is the app's only retained run history: samples are dropped from the front as they
age, so nothing grows with run length. `popChartMath.windowTail` trims by sim time
rather than by count, which is what keeps the span exact even though frame
boundaries round where a sample lands (spacing is `SAMPLE_DT` plus up to one
frame of sim time); the count is capped at `POP_WINDOW_S / SAMPLE_DT + 1` by
construction, since samples are never closer together than `SAMPLE_DT`. The
population chart draws the window — prey and predator **counts vs time**, with
`hunting effort` as its only footer line (the ratio-dependent attack `PRED_RATIO`
applies at the current prey-per-predator ratio) — and the autocorrelation panel
correlates over the same samples. Samples are `markRaw` plain data read through
`toRaw`, so no proxy is ever built per sample, and the window is published as a
raw copy only on the samples that age out (a shift through the reactive array
would cost a proxy trap per element moved).

A separate **autocorrelation panel**
(`RateChart.vue`) plots the linearly-detrended **autocorrelation** of the prey
series — the robust cycle test, since a rate derivative is swamped by small-count
noise whereas an autocorrelation peak at lag `T` means the population really
repeats. A flat or monotone ACF means there is no clean cycle. It reads the same
sliding window, and its window is clamped to `ACF_MAX_S = POP_WINDOW_S`: the panel
can never ask for more history than the window holds (its largest window is 3584
samples at 1800 s, inside the 3601 the window can hold), which is what keeps the
regime it draws and the correlation it plots over the same span instead of
silently truncating to a shorter one. It is maintained
incrementally (`popChartMath.createAcfTracker`): the window's raw per-lag pair
sums are updated O(n) per sample, so a refresh costs O(n) rather than the batch
O(n²), and the panel is current on every sample instead of every 16th. Detrending
survives that because the detrended lag sums expand back into raw pair sums plus
the window's least-squares line (see the tracker's header comment). Its snapshot
spans **4x the textbook period in sim seconds**: clamped to `ACF_MIN_S = 600` s at
the bottom and `ACF_MAX_S` at the top, and converted to a sample count from the
spacing actually observed (samples land no closer than `SAMPLE_DT`, and further
apart when a frame carries more sim time, ~1.3 s at 50x), so the snapshot means the
same at any speed and the maximum
lag is ~2x
the textbook period — long enough for the expected peak to appear, since the ACF
cannot see a period longer than half its snapshot. The count is quantised to
128-sample steps (~64 s at `SAMPLE_DT`) so a tuning drag does not trigger repeated
O(n²) tracker rebuilds. The cycle is the widest
autocorrelation dome above `r = 0.2`: `broadMaximum` takes the interior local
maxima, keeps those whose `tol`-band plateau is at least 3 lags wide and has
lower values on both sides (so the lag-0 lobe cannot qualify), ranks them by
prominence, and reports the plateau centre rather than the argmax. The peak is
marked with a dot and dotted vertical, and the footer reads `textbook period`
(the uncalibrated `2π/√(αγ)` from the slider-implied rates) plus `peak at period
X s with Y`. The measured-rate and rate-plane views were removed
as uninformative; per-capita rates survive only inside `popChartMath` for the
rate-model tests. The knob-derived rates
(`rateModel.js`) are constants of the tuning and are not calibrated to population
units, so they are not plotted.

**Regime.** The four rates set the clock and the coexistence scale, but whether
the trajectory settles onto a limit cycle is decided by the food resource and
the ratio-dependent response, so it is classified empirically from the prey
series (`popChartMath.classifyRegime`): persistence first (`prey extinct` /
`predators extinct`), then the peak-envelope trend (`damped` / `diverging`), then
period stability (`cyclic` / `irregular`), with `transient` until two cycles
exist. The badge is shown in the autocorrelation panel's footer.
also tints its background in the regime colour.

## Scene look

- Shell/bg/fog: dark green family (bg `0x0e110b`, shell `0x1c2316`).
- Food material is olive/greenish (`0x56613c` + emissive `0x343d26`).
- Bacteria colors: two **breeds** with a **constant** per-breed HSL — green
  (`0.37/0.5/0.5`) and red (`0.015/0.78/0.5`). Size conveys growth (color no
  longer varies with length). A death spawns a short additive **glow burst**
  (`src/glow.js` + `src/pops.js`): a camera-facing quad whose local X axis is
  aligned with the cell's projected body axis, so the elliptical falloff
  **follows the capsule shape**. It flashes at full brightness the instant the
  cell dies, then grows and fades to nothing over `POP_LIFE` — there is **no
  body fade-out**. A predator-latched ("immobile") cell keeps
  the original **purple fresnel rim** on the body (not a billboard).
- Lighting: **viewer-constant** — key + fill are `DirectionalLight`s parented to
  the camera (no distance falloff, so zoom never changes brightness). Key hangs
  top-left and behind the viewer; a soft magenta fill from the lower-right
  keeps shadow sides from going black. Ambient 0.55.

## Key decisions & gotchas

- **Opaque sphere** uses `FrontSide`; far-hemisphere **tails** are hidden
  (`updateVisibility` sets `sideHidden` via `CULL_COS`), while bodies are left to
  shell occlusion. No shadow maps.
- Entities sit at `SURFACE` to avoid z-fighting.
- **Cell–cell collision** must use capsule–capsule distance (a spherical radius
  caused phantom contacts → spurious rotation).
- **Mitosis envelope** is the assembly parent: an `invA = 0` proxy in the cell
  grid, sized to `proxyR` (the union of the mother's and both daughters'
  capsules) rather than to the mother's own length. Neighbours therefore still
  deflect off the unit after the mother's own radius has fallen to the floor, and
  the daughters are not indexed separately until release. The radius carries most
  of the shrink and `fade` scales the mother to nothing over the handover, so she
  does not linger at the `MIN_RADIUS` floor.
- **Tail slots** live in `tailPool.js`, chunk-local and packed; a freed slot is
  filled by moving the last live slot into it (`freeTailSlot`), keeping
  `chunk.live` a contiguous high-water so `mesh.count` is exact. Cell code never
  touches `chunk.owners`: `renderSync` calls `claimTailSlot`, and a
  dividing cell calls `inheritTailSlot` so the front daughter takes the parent's
  slot and the fading parent is left slotless. That makes `releaseTail` and
  `clearTail` no-ops for the parent, so no transfer flag is needed. The front
  daughter also copies the parent's chain pose and, while the ledger hands the
  length over, its pitch (`radius * tailGrow`) is blended from the mother's to
  the daughter's, so the inherited tail shrinks into the daughter's instead of
  snapping to her half length on the split frame (cell-5xd).
- **Tail ordering**: after `updateAssemblies`, `advance()` runs `updateTailControl`
  unconditionally (so `tailBend`→`headingRate` is preserved even when tails are
  hidden), then `updateTailPose` only when visible. `renderTails` runs later and
  only places segments, after the body pass has consumed the previous substep's
  `tailBend`. `updateTailState` = control + pose, kept for tests.
- The **tails** toggle hides the mesh, skips placement (`renderTails`), and skips
  the pose; control still runs, so steering is unaffected. `renderView` calls
  `warmTail` on the hidden→visible edge to re-aim the frozen chain.
- Body-pool and tail capacities grow **on demand in fixed-size chunks**
  (`BODY_CHUNK_CELLS` / `TAIL_CHUNK_CELLS`), so buffers track the high-water
  mark of concurrent cells, not the `MAX_CELLS` ceiling. `MAX_CELLS` remains
  only the logical population ceiling. Empty body chunks are detached (not
  drawn/uploaded) but kept for reuse. Empty tail chunks stay attached but set
  `mesh.count = 0` and are skipped by `renderTails`/hidden in `renderView`; their
  unused slots are zero matrices. A freed tail chunk is reused before a new one
  is grown.

## Workflow

- Issue tracking: **Beads (`bd`)**: `bd ready` / `bd create` / `bd update
  --claim` / `bd close`. Use `bd remember` for persistent knowledge (no
  MEMORY.md). See `AGENTS.md`.

> **Rendering debug trail**: see `NOTES.md` (Render bug post-mortem) for the
> long-running "cells go black / body vanishes leaving only a tail"
> investigation — two compounding defects (opaque-shell occlusion of near-limb
> bodies + a separate emissive nucleus), fixed by culling on actual occlusion
> and removing the nucleus. The render pipeline is now an explicit, toggleable
> `src/render.js` with pure headless-testable helpers.

- Git: commit semantically per subsystem. Origin is
  `https://github.com/boscoh/cellsphere.git`; `npm run build` writes the site to
  gitignored `dist/`, and the Pages workflow deploys it.
- Dev: `npm run dev` (Vite). Build: `npm run build` (final tree verified).

## In progress / next steps

- **Predator–prey** is implemented (red hunts/immobilises/eats green), tuned to a
  bounded cycle with `PRED_RATIO = 0.75` + `FOOD_COUNT 3000`. Weakened from 1
  (2026-09) so a transient red > green overshoot appears; going lower (≤0.5) risks
  a prey wipeout on some seeds, so 0.75 is the mildest weakening that stayed
  bounded over 1800 s on three seeds.
- **Tail** is a damped spring chain (restored), with a switchable O(S)
  **kinematic mode** (`TAIL_MODE`) — visual-only apart from the `tailBend`
  steering scalar.
- **Closed explorations:** Tier-2 food sensing (`cell-qjo.5`, clump attractors
  rejected; the density field is only worth it above the current `FOOD_COUNT`)
  and the GPU spring-chain tail (`cell-igf`, not justified by measurement).
- **Open follow-ups** (details in `NOTES.md`): settle kinematic vs spring-chain
  (`cell-owg`); collision Tier-2 dense grid / persistent neighbours if profiling
  shows broadphase dominating; a possible momentum-driven "C-start" whip.
- No open beads.
