# Cell — Design & Session State

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
orchestrator: collision, physics loop, render lifecycle), `src/cells.js`
(cell domain — create/grow/mitose/tails, body pools), `src/food.js` (food
grid, eating + sensing, clumps); tuning constants in `src/constants.js`;
scene/lights in `src/sceneSetup.js`; shared geos/materials in
`src/materials.js`; pure helpers in `src/math.js`.

## How it works (architecture)

- **Sphere surface model**: bacteria/food rest at `SURFACE = SPHERE_RADIUS + 0.06`
  (just above the opaque `FrontSide` shell). No boundary. Background/fog and
  the shell are a dark greenish family.
- **Data-object cells**: a bacterium is a plain data object (no `THREE.Group`):
  surface `pos`, tangent `vel`, tangent `heading`, `headingRate`, `quat`,
  `radius/mass/breed/color`, tail state (`tailDirs`, `tailPhase`), growth and
  mitosis state. Physics in `sim.js` reads/writes these directly.
- **Bodies** render via **pooled `InstancedMesh`es** keyed by length bucket
  (`bodyGeoCache` + `bodyPools`): `addBody/removeBody/rehomeBody` manage a free
  list per bucket; per-instance color + a custom `instanceOpacity` attribute
  (`setBodyColor/setBodyOpacity`) drive color and the mitosis fade.
  `renderBodies` composes each cell's matrix from `pos/quat`.
- **Tails** render as one `InstancedMesh` of capsule segments
  (`MAX_CELLS*TAIL_SEGMENTS`); per-cell color set from `createCell`/`growCell`
  (`setTailColor`), slots via `allocTailIndex` + free list. Tails hidden = skip
  `updateTailState`/`renderTails` and hide the mesh (`tailsHidden`).
- **Linear motion**: `drive = slow*(1-slowFrac)`; thrust `THRUST*drive` along
  heading; high `DRAG` bleeds velocity. `slow` ramps to ~0 near food
  (graze), `slowFrac` ramps to 1 near max length (ease into mitosis).
- **One consistent time loop**: `App.vue` banks real time in an accumulator
  and calls `sim.step(simDt×simRate)`; `step` subdivides into
  `clamp(ceil(simDt/FIXED_DT),1,MAX_STEPS)` substeps of `advance(dt)`. Render
  is separate (`sim.render(tailScale)`). Headless physics: `buildWorld()` +
  `step()` work without `attach()` (bare `THREE.Scene`, no WebGL).
- **Food**: one `InstancedMesh`; spatial hash (`GRID`) limits lookups;
  `eatAndRespawn` (per substep, tight scan) and `concentration`
  (every `SENSE_PERIOD`, wide scan) update `slow/foodAmt/foodPeak/foodDir`.
- **Cell–cell collision**: true capsule–capsule min distance; soft spring +
  positional correction + a heading kick; pairs limited by a cell spatial hash
  (`CELL_GRID`). Splitting daughters are excluded; a dividing **parent stays as
  an immovable collision proxy** (`mitoParent`, inverse mass 0) until the
  daughters separate.
- **Rotation**: `headingRate` is yaw about the surface normal, damped by
  `ANG_DRAG`. Sources: chemotaxis (turn toward food gradient when
  `foodPeak > PEAK_MIN`) and collision kicks. No random tumble.
- **Growth/mitosis**: eating grows `radius` to `maxLength = 2×birth`; at full,
  `mitose()` spawns two daughters (`0.45×` length) facing away. The parent
  **fades via per-instance opacity** (`setBodyOpacity`; body material runs a
  custom shader hook multiplying `diffuseColor.a` by `instanceOpacity`) while
  `depthWrite=false`, then its mesh is dropped but it **keeps colliding** until
  the daughters finish separating; `finalizeMito` marks it dead and releases
  the daughters (with a `MITO_REST` coast).
- **Tail model**: `TAIL_SEGMENTS` fixed-length links of `TAIL_LINK` (constant
  length for all body sizes) drawn as capsule segments (`TAIL_LINK_FILL` of each
  pitch → small joint gaps). Joint directions live on the sphere: `placeTail`
  walks nodes by projecting each step back to `SURFACE`, so the tail follows the
  sphere's curvature. `updateTailState`: base link chases behind-heading with a
  slow lag (`TAIL_BASE_RATE` — the tail swings out and "drives" food turns),
  outer links chase with `TAIL_JOINT_RATE`, and while moving
  (`drive > 0.02`) a traveling sine (`TAIL_OSC_FREQ/AMP/WAVE`) is injected per
  link so the tail undulates; amplitude scales with `drive`, so it stops when
  grazing/resting.

## Current tuning constants (`src/constants.js`)

| Constant | Value | Role |
|---|---|---|
| `SPHERE_RADIUS` / `SURFACE` | 5 / 5.06 | sphere radius / surface offset |
| `CELL_COUNT` / `MAX_CELLS` | 100 / 500 | initial / max population |
| `FOOD_COUNT` | 7000 | food specks |
| `GRID` / `CELL_GRID` | 0.35 / 1.0 | food / cell spatial-hash cell size |
| `SPRING` | 22 | cell–cell stiffness |
| `FIXED_DT` / `MAX_STEPS` | 1/60 / 200 | physics substep / per-frame ceiling |
| `MIN_RADIUS` / `MAX_RADIUS` / `START_RADIUS` | 0.10 / 0.37 / 0.13 | color/length gradient |
| `GROWTH_PER_FOOD` / `ABSORB_CAP` | 0.0005 / 3 | growth per food / per-frame cap |
| `MITO_TIME` / `MITO_HOLD` / `MITO_FADE` | 90 / 0.2 / 0.4 | mitosis duration; hold; fade fraction |
| `MITO_NEAR` / `MITO_SEP` | 2.1 / 2.8 | child held spread / separated spread |
| `MITO_SLOW_FRAC` / `MITO_REST` | 0.6 / 4 | decel into split / post-mitosis coast |
| `WIDTH` | 0.085 | body width (only length grows) |
| `TAIL_SEGMENTS` / `TAIL_LINK` | 8 / 0.11 | links per tail / link pitch (fixed for all sizes; total ≈0.88) |
| `TAIL_LINK_FILL` | 0.9 | drawn fraction of each pitch (gaps ≈0.1 → jointed look) |
| `TAIL_BASE_RATE` | 1.6 | base-link lag toward behind-heading (turn "drive") |
| `TAIL_JOINT_RATE` | 2.0 | outer-link straightening viscosity |
| `TAIL_OSC_FREQ` / `TAIL_OSC_AMP` / `TAIL_OSC_WAVE` | 7 / 0.5 / 0.9 | traveling sine speed / amplitude / wavelength per link |
| `THRUST` / `DRAG` | 12 / 22 | linear propulsion / damping |
| `GRAZE_RATE` / `GRAZE_GAIN` | 0.01 / 6.0 | slowdown floor / gain |
| `ANG_DRAG` / `MAX_SPIN` | 12 / 2.0 | angular damping / rate cap |
| `CHEMO_ACCEL` / `MAX_ACCEL` / `PEAK_MIN` | 3.5 / 1.2 / 0.18 | chemotaxis torque / cap / min gradient |
| `COLLISION_KICK` | 0.5 | contact → angular kick |
| `SENSE_BOOST` / `SENSE_PERIOD` | 0.25 / 0.05 | sensing radius / scan period |
| `CULL_COS` | -0.06 | cos(normal, cam) below which a cell/tail is culled |

Reactive UI: single-line **HUD top-left** — `Cell · fps · bacteria · food |
Speed slider × | Tails on/off word switch | Restart`. `simRate` default **1×**,
min 1, max `MAX_SIM_RATE = 10`, step 2. Drag hint sits bottom-center.

## Scene look

- Shell/bg/fog: dark green family (bg `0x0e110b`, shell `0x1c2316`).
- Food material is olive/greenish (`0x56613c` + emissive `0x343d26`).
- Bacteria colors: two **breeds** — blue (hue ~0.56→0.64) and red; lightness
  ramps with size via `smoothstep` so newborns are dark and full-grown cells are
  clearly brighter.
- Lighting: **viewer-constant** — key + fill are `DirectionalLight`s parented to
  the camera (no distance falloff, so zoom never changes brightness). Key hangs
  top-left and behind the viewer; a soft magenta fill from the lower-right
  keeps shadow sides from going black. Ambient 0.5.

## Key decisions & gotchas

- **Opaque sphere** uses `FrontSide`; far-hemisphere cells are culled
  (`updateVisibility`, `CULL_COS`). No shadow maps.
- Entities sit at `SURFACE` to avoid z-fighting.
- **Cell–cell collision** must use capsule–capsule distance (a spherical radius
  caused phantom contacts → spurious rotation).
- **Mitosis fade** uses a per-instance opacity attribute + `onBeforeCompile`
  on the shared body material (three can't set per-instance opacity otherwise).
  `bodyMat.depthWrite` is toggled false while any parent is fading so the ghost
  never occludes the held daughters; `activeFades` counts live fades.
  The faded parent's mesh/tail are dropped at fade end but the cell object
  stays as an **immovable collision proxy** (`mitoParent`, recentered on
  `m.startPos`) until the daughters separate — otherwise neighbours sail
  through the division.
- **Tail slots** are monotonic + free-list (`allocTailIndex`); naive index reuse
  collided with live cells' instances ("lost tails"). A daughter reuses the
  parent's slot (`tailTransfer`), so `removeCell` must not free it.
- **Tail ordering**: `updateTailState` runs as a pass after `updateMito` in
  `advance()`. Mito/splitting branches force `drive = 0`; the sine is injected
  *after* the joint chase (feeding it into the chase target gets low-pass
  filtered away by `TAIL_JOINT_RATE`).
- The **tails** toggle hides the mesh and skips tail sim/placement entirely
  (not the old micro-scale trick).
- `MAX_CELLS` preallocates body-pool and tail capacities; unused slots are
  zero matrices.

## Workflow

- Issue tracking: **Beads (`bd`)**: `bd ready` / `bd create` / `bd update
  --claim` / `bd close`. Use `bd remember` for persistent knowledge (no
  MEMORY.md). See `AGENTS.md`.
- Git: commit semantically per subsystem; no git origin configured (local only).
- Dev: `npm run dev` (Vite). Build: `npm run build` (final tree verified).

## In progress / next steps

- Possible follow-ups discussed: run/tumble randomness, snappier chemotaxis
  turns, predator–prey, colony growth, tail shape variance.
