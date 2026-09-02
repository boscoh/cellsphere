# Cell — Design & Session State

This doc captures the current architecture, tuning values, decisions, gotchas,
and in-progress work so a fresh session can pick up quickly.

## Overview

A Vue 3 + Three.js simulation of bacteria grazing on the **surface of a solid
(opaque) sphere**. Bacteria are elongated **capsules** with thin **flagellum
tails** that drive slow, heavily-viscous motion. The sphere is covered in muted
food specks arranged in **clumps**; bacteria sense food, slow down, turn toward
concentration, eat to grow, and eventually **mitose**.

Everything lives in `src/App.vue`. UI is a minimal overlay (sim-speed slider +
tails toggle).

## How it works (architecture)

- **Sphere surface model**: bacteria/food rest at `SURFACE = SPHERE_RADIUS + 0.06`
  (just above the opaque `FrontSide` sphere so they don't z-fight). No boundary.
- **Bacteria**: each stores surface `pos` (Vector3), tangent `vel`, tangent
  `heading`, angular `headingRate`, per-cell tail traits, growth state.
- **Linear motion**: `drive = power * slow`; thrust `THRUST*drive` along heading;
  high `DRAG` bleeds velocity (stops fast when tail stops). Viscosity is fixed
  high; a "sim speed" slider scales the sim clock (`simDt = rawDt*speed/100`).
- **Rotation (viscous)**: `headingRate` accumulates torque from **collision
  kicks** and **chemotaxis**, then is damped by `ANG_DRAG` and integrated about
  the surface normal. No self-steering.
- **Food**: clumped, rendered as one `InstancedMesh`; a **spatial hash** (`GRID`)
  limits each bacterium's food lookups. Absorption uses **capsule–capsule**
  distance. Concentration drives a **graduated slowdown** (`slow`) and a
  **chemotaxis** turn (only when the gradient is strongly peaked).
- **Cell–cell collision**: true capsule–capsule min distance; soft spring +
  positional correction; contact also kicks `headingRate`.
- **Growth/mitosis**: eating grows length to `maxLength = 2× start`.
  On full, `mitose()` spawns **two daughters** (each half the mother's length,
  placed to tile the parent's footprint), the **parent phases out**, then the
  daughters rest and are released.

## Current tuning constants (`src/App.vue`)

| Constant | Value | Role |
|---|---|---|
| `SPHERE_RADIUS` / `SURFACE` | 5 / 5.06 | sphere radius / surface offset |
| `CELL_COUNT` / `MAX_CELLS` | 225 / 500 | initial / max population |
| `FOOD_COUNT` | 26000 | food specks |
| `GRID` | 0.35 | food spatial-hash cell size |
| `SPRING` | 22 | cell–cell stiffness |
| `MIN_RADIUS` / `MAX_RADIUS` / `START_RADIUS` | 0.07 / 0.26 / 0.09 | color/length gradient |
| `GROWTH_PER_FOOD` | 0.0005 | length gained per food |
| `ABSORB_CAP` | 3 | max foods absorbed per cell/frame |
| `MITO_TIME` | 90 | mitosis animation duration (sim-s) |
| `MITO_HOLD` / `MITO_SEP` | 0.15 / 0.25 | fraction held / separating (rest = remainder) |
| `WIDTH` | 0.06 | body width (fixed; only length grows) |
| `TAIL_SEGMENTS` / `TAIL_LEN` / `TAIL_AMP` | 24 / 0.15 / 0.1 | tail shape |
| `TAIL_FREQ` / `TAIL_WAVE` | 24.0 / 24.0 | tail beat rate / spatial waves |
| `THRUST` / `DRAG` | 12 / 22 | linear propulsion / damping |
| `GRAZE_RATE` / `GRAZE_GAIN` | 0.02 / 1.8 | graduated slowdown floor / gain |
| `ANG_DRAG` / `MAX_SPIN` | 12 / 2.0 | angular damping / rate limit |
| `CHEMO_ACCEL` / `MAX_ACCEL` / `PEAK_MIN` | 3.5 / 1.2 / 0.18 | chemotaxis torque / cap / min-peak |
| `COLLISION_KICK` | 0.5 | contact → angular kick |
| `SENSE_BOOST` | 0.25 | food sensing radius for concentration |

Reactive UI: `simSpeed` (default 50, 0–1000%), `tailsActive`.

## Key decisions & gotchas

- **Opaque sphere** uses `side: THREE.FrontSide`; bacteria/food on the *near*
  hemisphere are visible, far side is occluded. This is intentional.
- Entities sit at `SURFACE` (not `SPHERE_RADIUS`) to avoid z-fighting with the
  shell.
- **Cell–cell collision** must use capsule–capsule distance; a single big
  spherical radius caused phantom contacts → spurious rotation.
- **Rotation is lazy**: only collision kicks + chemotaxis, damped by `ANG_DRAG`
  (high viscosity → slow rotation).
- **Food absorption** uses capsule distance; concentration sums are computed in
  the same spatial-hash scan.
- **`GROWTH_PER_FOOD`** is tiny and `ABSORB_CAP` bounds per-frame growth.
- **Mitosis**: two daughters each `fullLen * 0.5`, centers `±childLen` (tile the
  mother), facing outward; parent fades out over the whole animation. The parent
  overlaps the daughters at the start (all coincident/full), then separates.
- The **tails checkbox** hides tails by scaling tail instances to 0 (not just
  stopping the wave).
- `MAX_CELLS` preallocates tail instances; unused ones are zeroed at init;
  `tailMesh.instanceColor.needsUpdate` is set on color writes.

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
