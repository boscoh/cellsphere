# Cell — Design & Session State

This doc captures the current architecture, tuning values, decisions, gotchas,
and in-progress work so a fresh session can pick up quickly.

## Overview

A Vue 3 + Three.js simulation of bacteria grazing on the **surface of a solid
(opaque) sphere**. Bacteria are elongated **capsules** with thin **flagellum
tails** that drive slow, heavily-viscous motion. The sphere is covered in muted
food specks arranged in **clumps**; bacteria sense food, slow down, turn toward
concentration, eat to grow, and eventually **mitose**.

`src/App.vue` is a thin Vue shell (lifecycle, reactive UI overlay, frame
timing). The simulation is split into modules: `src/sim.js` (`Simulation`
orchestrator: collision, physics loop, render lifecycle), `src/cells.js`
(cell domain — create/grow/mitose/tails), `src/food.js` (food grid, eating +
sensing, clumps); tuning constants in `src/constants.js`; scene/renderer in
`src/sceneSetup.js`; shared geos/materials in `src/materials.js`; pure helpers
in `src/math.js`.

## How it works (architecture)

- **Sphere surface model**: bacteria/food rest at `SURFACE = SPHERE_RADIUS + 0.06`
  (just above the opaque `FrontSide` sphere so they don't z-fight). No boundary.
- **Bacteria**: each stores surface `pos` (Vector3), tangent `vel`, tangent
  `heading`, angular `headingRate`, per-cell tail traits, growth state.
- **Linear motion**: `drive = power * slow`; thrust `THRUST*drive` along heading;
  high `DRAG` bleeds velocity (stops fast when tail stops). Viscosity is fixed
  high.
- **One consistent time loop**: `App.vue` runs `Simulation.frame(simDt, tail)`
  per render where `simDt = rawDt * speed/100`. `frame()` subdivides `simDt`
  into `clamp(ceil(simDt / FIXED_DT), 1, MAX_STEPS)` equal physics substeps
  (`advance(dt)`), so `simSpeed` is a **linear time multiplier** and stays
  stable at high speed (single big steps earlier over-damped the
  `exp(-DRAG*simDt)` integration and paradoxically slowed the sim). **Time-driven**:
  `App.vue` measures real elapsed time each frame and banks it in an
  **accumulator** (`sim.step(simDt) × simSpeed`, capped by `MAX_BACKLOG`), so
  sim time tracks wall-clock × speed across uneven frame times but never
  spirals during slow frames. **Headless**: the physics is split into
  `step(simDt)` (substeps only, no rendering) and `render()` (tail matrices +
  controls + `renderer.render`); `frame()` calls both. `sim.buildWorld()` works
  without `attach()` — a bare `THREE.Scene` is used and no WebGL context is
  created, so you can run pure physics via `sim.step(simDt)` (verified: 120
  cells/14k food, 30 s, no renderer, slow range 0.02→1.0, cells grow).
  **Perf**: the food **spatial hash** is built once at init and maintained
  **incrementally** (`addFoodToGrid`/`removeFoodFromGrid`) so respawns/absorbs
  update only affected buckets. Sensing is **split**: `eatAndRespawn` runs
  **per-substep** with a tight 3×3×3 scan (foods within eat range only) and
  tracks respawning foods in a list; the wide 5×5×5 **concentration** scan
  (`slow`/`foodAmt`/`foodPeak`/`foodDir`) runs only every `SENSE_PERIOD`
  (0.05) sim-sec via an accumulator — cuts the dominant scan cost while
  preserving eating and the slow ramp.
- **Rotation (viscous)**: `headingRate` accumulates torque from **collision
  kicks** and **chemotaxis**, then is damped by `ANG_DRAG` and integrated about
  the surface normal. No self-steering.
- **Food**: clumped, rendered as one `InstancedMesh`; a **spatial hash** (`GRID`)
  limits each bacterium's food lookups. Absorption uses **capsule–capsule**
  distance. Concentration drives a **graduated slowdown** (`slow`) and a
  **chemotaxis** turn (only when the gradient is strongly peaked).
- **Cell–cell collision**: true capsule–capsule min distance; soft spring +
  positional correction; contact also kicks `headingRate`. Pairs are
  limited by a **cell spatial-hash** (`CELL_GRID`, ±1 bucket) instead of an
  O(n²) scan; mito/splitting cells are excluded from the grid.
- **Growth/mitosis**: eating grows length to `maxLength = 2× start`.
  On full, `mitose()` spawns **two daughters** (each half the mother's length,
  placed to tile the parent's footprint), the **parent phases out**, then the
  daughters rest and are released.
- **Tail (trailing + agitation)**: each cell keeps a surface-tangent `tailDir`
  (the flagellum axis) that chases `-heading` with a first-order lag
  (`TAIL_LAG_RATE`), so the tail drags through the medium and bends around
  turns instead of snapping to the body frame. A discrete `agitate` decision
  (attack/release, `AGITATE_UP/DOWN`) is fed by `drive`/`slow`; crossing
  `GO_THRESH` fires a decaying **whip** (`WHIP_GAIN`, `WHIP_TAU`) that briefly
  spikes amplitude, and the beat blends from a limp planar wave into a
  **helical corkscrew** (`TAIL_HELIX`) under agitation = "swivel to generate
  thrust." Drawn per frame in `placeTail` (base sits at the rear of the body;
  the wave travels outward along `tailDir`).

## Current tuning constants (`src/constants.js`)

| Constant | Value | Role |
|---|---|---|
| `SPHERE_RADIUS` / `SURFACE` | 5 / 5.06 | sphere radius / surface offset |
| `CELL_COUNT` / `MAX_CELLS` | 120 / 500 | initial / max population |
| `FOOD_COUNT` | 7000 | food specks |
| `GRID` / `CELL_GRID` | 0.35 / 1.0 | food spatial-hash cell size / cell collision-hash cell size |
| `SPRING` | 22 | cell–cell stiffness |
| `FIXED_DT` / `MAX_STEPS` | 1/60 / 200 | stable physics substep / hard per-frame substep ceiling |
| `MIN_RADIUS` / `MAX_RADIUS` / `START_RADIUS` | 0.10 / 0.37 / 0.13 | color/length gradient |
| `GROWTH_PER_FOOD` | 0.0005 | length gained per food |
| `ABSORB_CAP` | 3 | max foods absorbed per cell/frame |
| `MITO_TIME` | 90 | mitosis animation duration (sim-s) |
| `MITO_HOLD` / `MITO_FADE` | 0.2 / 0.4 | fraction parent stays fully visible / then fades (children held overlapped until fade ends) |
| `MITO_NEAR` / `MITO_SEP` | 2.1 / 2.8 | child spread when held (head-to-head in parent) / after parent gone |
| `MITO_SLOW_FRAC` | 0.6 | fraction of max length where a cell starts decelerating into mitosis |
| `MITO_REST` | 4 | post-mitosis coast (s) with drive=0 so daughters drift apart, no thrust |
| `WIDTH` | 0.085 | body width; only length grows |
| `TAIL_SEGMENTS` / `TAIL_LEN` / `TAIL_AMP` | 24 / 0.60 / 0.10 | tail shape |
| `TAIL_FREQ` / `TAIL_WAVE` | 24.0 / 24.0 | tail beat rate / spatial waves |
| `TAIL_LAG_RATE` / `TAIL_HELIX` | 3.5 / 1.0 | how fast the tail axis chases `-heading` (lower = more trailing) / planar→helical blend |
| `AGITATE_UP` / `AGITATE_DOWN` / `GO_THRESH` | 6.0 / 2.0 / 0.6 | agitation attack / release rate / "move decision" drive threshold |
| `WHIP_GAIN` / `WHIP_TAU` | 1.2 / 0.35 | transient amplitude boom on "go" / its decay |
| `THRUST` / `DRAG` | 12 / 22 | linear propulsion / damping |
| `GRAZE_RATE` / `GRAZE_GAIN` | 0.01 / 6.0 | graduated slowdown floor / gain |
| `ANG_DRAG` / `MAX_SPIN` | 12 / 2.0 | angular damping / rate limit |
| `CHEMO_ACCEL` / `MAX_ACCEL` / `PEAK_MIN` | 3.5 / 1.2 / 0.18 | chemotaxis torque / cap / min-peak |
| `COLLISION_KICK` | 0.5 | contact → angular kick |
| `PEAK_MIN` | 0.18 | min concentration peak for chemotaxis |
| `SENSE_BOOST` | 0.25 | food sensing radius for concentration |
| `SENSE_PERIOD` | 0.05 | sim-sec between concentration scans (throttle) |
| `CULL_COS` | -0.06 | cos(normal, camDir) below which a cell/tail is culled |

Reactive UI: `simRate` (default 15, 0–`MAX_SIM_RATE`=MAX_STEPS, step 2, shown as
`×` — sim-time per real-time, i.e. sim seconds per real second; also shows
`max MAX_SIM_RATE×`), `tailsActive`. The fps readout is tagged `render`.
`MAX_SIM_RATE` and `MAX_BACKLOG` are derived from the sim constants
(`MAX_STEPS`, `MAX_BACKLOG = MAX_STEPS*FIXED_DT`) so the slider's top is exactly
the sim's per-frame physics ceiling and the request is clamped to it — you
can't choose a rate the sim can't be asked to run.

## Key decisions & gotchas

- **Opaque sphere** uses `side: THREE.FrontSide`; bacteria/food on the *near*
  hemisphere are visible, far side is occluded. This is intentional. Body uses
  `MeshStandardMaterial` (translucent, no `transmission` — removed for perf).
  Cells/tails on the occluded far side are **culled** (`updateVisibility`,
  `CULL_COS`) to save draw calls + transmission/transparent cost; `shadowMap`
  is off.
- Entities sit at `SURFACE` (not `SPHERE_RADIUS`) to avoid z-fighting with the
  shell.
- **Cell–cell collision** must use capsule–capsule distance; a single big
  spherical radius caused phantom contacts → spurious rotation.
- **Rotation is lazy**: only collision kicks + chemotaxis, damped by `ANG_DRAG`
  (high viscosity → slow rotation).
- **Food absorption** uses capsule distance; concentration sums are computed in
  the same spatial-hash scan.
- **`GROWTH_PER_FOOD`** is tiny and `ABSORB_CAP` bounds per-frame growth.
- **Mitosis**: two daughters each `fullLen * 0.45`, facing 180° apart (heads
  toward the parent center, tails pointing outward). They spawn overlapping the
  parent (held), the parent stays fully visible then fades, then the daughters
  separate apart (spread `MITO_NEAR→MITO_SEP`). Children's position + quaternion
  are synced every frame (splitting cells skip the physics loop, so without this
  they'd render at the world origin). After finalize each daughter gets a
  **`MITO_REST` coast (`drive=0`)**, so they drift apart with no thrust instead
  of propelling into each other; they resume normal swimming after the rest. To
  see the children inside, the fading parent uses **`depthWrite=false`** and
  lower opacity (`0.75*(1-fadeK)`) so it never occludes the held daughters.
- The **tails checkbox** hides tails by scaling tail instances to 0 (not just
  stopping the wave).
- `MAX_CELLS` preallocates tail instances; unused ones are zeroed at init;
  `tailMesh.instanceColor.needsUpdate` is set on color writes.
- **Tail slots** are allocated via `allocTailIndex()` (monotonic + free-list)
  since cells are spliced out of `cells`; a naive `cells.length`/loop-counter
  index gets reused and collides with a live cell's tail instances → "lost tails".
- **Tail state ordering**: `updateTailState` must run as a separate pass *after*
  the `updateMito` pass in `advance()`. `updateMito` sets splitting children's
  `drive = sep` so propulsion/tails ramp with separation; if the tail state is
  computed inside the physics loop (where the mito/splitting branch forces
  `drive`), the children's tails read full-strength drive and screw into a
  full helical corkscrew for the whole separation. The mito/splitting branch
  sets `d.drive = d.slow` (calm fading parent) rather than `1`.

## Workflow

- Issue tracking: **Beads (`bd`)**. `bd ready` / `bd create` / `bd update
  --claim` / `bd close`. Use `bd remember` for persistent knowledge (not
  MEMORY.md). See `AGENTS.md`.
- Git: `git add -A && git commit`. Beads sync is via `bd dolt push` (Dolt
  backend, no git-origin sync-branch configured).
- Dev: `npm run dev` (Vite). Build: `npm run build`.

## In progress / next steps

- Mitosis child placement/facing being tuned (two daughters vs mother as child).
- Possible follow-ups discussed: predator–prey, faster sim control, food
  source/sink, tail shape variance, colony growth.
- Beads: this repo has been migrated to **Dolt**; the other repos
  (`anki-tools`, `deployvm`, `microeval`, `nimago`) still on **SQLite** and need
  `bd` migration.
