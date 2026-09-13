# CellSphere

A real-time predator–prey simulation on the surface of a sphere. Blue bacteria
graze on scattered food and grow fat enough to divide; red predators hunt them
down and drain their energy. Every cell is an autonomous agent — it senses its
surroundings, steers with an undulating tail, and lives or starves on the energy
it banks. No grid, no walls, no seams: continuous motion in a closed, finite
world.

## Design goals

CellSphere is an experiment in blending three things that are usually kept
apart:

- **Animation** — motion that reads as alive: undulating flagella, spring-chain
  bodies, and death bursts timed to the physics.
- **Game physics** — cheap, stable, "feels right" rules (soft collisions, drag,
  steering) that keep a real-time swarm responsive and fun to watch.
- **Simulation rigour** — a closed, deterministic, headless-testable model where
  behaviour falls out of a small set of state variables rather than scripted
  keyframes.

The aim is bacteria that look interesting on their own and interact in
interesting ways, without one goal overriding the others. A **unified
energy/food model** ties it together: a single `energy` value per cell drives
size, speed, growth, mitosis, and death, while grazing food and predation both
feed that same pool. Basic physics, good-looking physics, and animation are
meant to reinforce each other rather than compete.

## Features

- **Boundary-free sphere** — a closed surface with no grid, walls, or
  wrap-around seams; cells move and sense continuously
- **Tail-driven steering** — the undulating flagellum is the actuator:
  chemotaxis and collisions bend it, and the bend generates the body's rotation
- **One energy currency** — a single `energy` value drives size, speed, growth,
  mitosis, and death, fed by both grazing and predation
- **Growth & mitosis** — eating linearly lengthens the body; at full energy it
  splits into two daughters while the parent lingers as an immovable collision
  proxy until they separate
- **Chemotaxis on a peaked gradient** — cells only turn toward food when the
  local gradient is sharply peaked, and slow to a near-stop inside a clump
- **Capsule–capsule collisions** — a mass-weighted soft spring on true capsule
  distance, so elongated bodies repel without phantom contact
- **Chunked instanced rendering** — body/tail `InstancedMesh`es grow on demand,
  tracking the high-water mark of concurrent cells instead of a hard ceiling
- **Live tuning** — every runtime parameter is exposed in a grouped slider panel
  (`src/constants.js` registry)

## Tech stack

- [Vue 3](https://vuejs.org/) (`<script setup>`)
- [Vite](https://vite.dev/)
- [Three.js](https://threejs.org/) (via `three/addons`, plus pooled
  `InstancedMesh` for bodies, tails, and food)

The authoritative architecture, tuning values, and gotchas live in
[`docs/DESIGN.md`](docs/DESIGN.md); this README is the quick overview.

## Getting started

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

### Scripts

| Command            | Description                                                        |
| ------------------ | ----------------------------------------------------------------- |
| `npm run dev`      | Start the Vite dev server                                          |
| `npm run build`    | Build the site into `docs/` (the committed GitHub Pages site)      |
| `npm run preview`  | Preview the built site                                             |
| `npm run test:tail`| Headless tail/steering equivalence, wave-phase, and pose smoke test |

## Controls

The HUD (top-left) shows live blue/red cell counts, food count, the speed
slider, and a Tails toggle. Perf timings and the population chart sit
bottom-left; drag/scroll hints bottom-center.

| Input                       | Action                                          |
| --------------------------- | ----------------------------------------------- |
| Drag                        | Orbit the camera                                |
| Scroll                      | Zoom                                            |
| Speed slider (1–50×)        | Time acceleration (`simRate`)                   |
| Tails toggle                | Show/hide the tail mesh (steering is unchanged) |
| Tuner                       | Open/close the parameter panel (Esc closes)     |
| Restart                     | Rebuild the world at the current defaults       |

## Architecture

The simulation is split into focused modules rather than living all in `App.vue`:

- `src/main.js` — app bootstrap
- `src/App.vue` — thin shell: lifecycle, HUD, frame timing, overlay
- `src/sim.js` — `Simulation` orchestrator: collision, physics loop, render lifecycle
- `src/cells.js` — cell domain: create/grow/mitose (bodies and tails live in the
  pools below)
- `src/food.js` — food domain: spatial grid, eating + sensing, clumps
- `src/predator.js` — predation: latch + drain
- `src/constants.js` — tuning registry (`PARAM_DEFS` / `P` / `GROUPS`) + plain consts
- `src/sceneSetup.js` — Three.js scene / renderer / camera / controls / sphere shell
- `src/materials.js` — shared geometries & materials (incl. the body shader hooks)
- `src/render.js` — visibility culling + render pass
- `src/glow.js`, `src/pops.js` — death-burst billboards
- `src/perf.js` — per-frame timing
- `src/Tuner.vue`, `src/PopChart.vue` — runtime UI panels
- `src/math.js` — pure helpers

### Sphere surface model

Bacteria and food are constrained to the surface of a sphere of radius
`SPHERE_RADIUS` (entities rest at `SURFACE = SPHERE_RADIUS + 0.06`). There is no
boundary — the surface is a closed periodic domain.

### Cells as data objects

A bacterium is a plain data object (no `THREE.Group`): surface `pos`, tangent
`vel`, tangent `heading`, `headingRate`, `quat`, `radius/mass/breed/color`, tail
state, and growth/mitosis state. Physics in `sim.js` reads/writes these directly.

### Energy → size, growth, death

One value, `d.energy` in `[0, ENERGY_MAX]`, drives everything:
`radius = MIN_RADIUS + (energy/ENERGY_MAX)*(MAX_RADIUS-MIN_RADIUS)` (linear).
Eating (`gainEnergy`) grows it; `METABOLISM` plus locomotion costs (`MOVE_COST`,
`TURN_COST`) drain it every step. At `ENERGY_MAX` the cell splits; at zero it
dies immediately.

### Motion & steering

`drive = slow × (1 − coast) × fatigue`; thrust `THRUST*drive` along the heading,
and high `DRAG` bleeds velocity. Rotation is generated by the tail: chemotaxis
and collision kicks produce a steering bend the tail turns into a `headingRate`
(`headingRate += TAIL_TURN*tailBend`), damped by `ANG_DRAG`.

### Tails

The tail is a segmented spring chain whose base axis follows the body and whose
tips chase a traveling wave. It is visual-only apart from the `tailBend` scalar
that drives rotation: the physical control pass runs even while the tail mesh is
hidden, so toggling Tails never changes motion.

## Tuning

All tunables — grouped (World, Movement, Collision, Sensing & Feeding, Mitosis,
Survival, Tail, Predator) with defaults, ranges, and descriptions — live in
`src/constants.js` (`PARAM_DEFS` / `P` / `GROUPS`) and are adjustable live
via the Tuner panel: each parameter is declared once in `PARAM_DEFS` and its
value is read from the `P` record (`P.THRUST`). Structural/allocation constants (surface radius, cell/food
counts, grid sizes, chunk sizes) are plain `const`s excluded from the registry.
See `docs/DESIGN.md` for the full constant table and semantics.

## License

MIT
