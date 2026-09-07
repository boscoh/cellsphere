# Cell

A Vue 3 + Three.js interactive simulation: bacteria grazing on the surface
of a solid opaque sphere. Each bacterium is an elongated capsule with a
segmented flagellum tail that drives its (highly viscous) motion. The sphere
is covered in clumped food that the bacteria eat to grow, divide, and — with
predators enabled — hunt each other.

The authoritative architecture, tuning values, and session state live in
[`docs/DESIGN.md`](docs/DESIGN.md); this file is the quick overview.

## Features

- **Opaque sphere** — bacteria and food live on the front surface; the solid
  sphere occludes anything on the far side
- **Two breeds** — blue prey that graze food, and red predators that hunt and
  drain blue cells; both are constant-colored per breed
- **Bacteria** — capsule-shaped bodies (tube with rounded ends), oriented along
  their direction of travel
- **Flagellum tails** — thin segmented "whisker" tails that undulate while
  swimming and swing to drive turns (tail motion generates the rotation)
- **Food distribution** — thousands of tiny muted specks scattered in uneven
  clumps across the sphere
- **Chemotaxis & grazing** — a bacterium senses local food concentration and
  only turns toward food when the gradient is **strongly peaked**; it slows
  gradually with concentration until it nearly stops inside a clump
- **Energy → growth → mitosis** — eating banks energy that linearly grows the
  body length; at max energy the cell **splits into two daughters** (each half
  the parent's length), with a per-instance opacity fade and an immovable
  parent collision proxy until the daughters separate
- **Starvation cycle** — `METABOLISM` drains energy and a starved cell shrinks,
  then fades/dies; predation drains prey into the predator
- **High viscosity** — heavy linear drag and a separate **angular drag** mean
  bacteria stop quickly when their tail stops
- **Soft collision physics** — bacteria repel via a mass-weighted spring; contact
  uses accurate **capsule–capsule** distance
- **Chunked render pools** — body and tail `InstancedMesh`es grow on demand in
  fixed-size chunks, so memory/upload scale with the high-water mark of
  concurrent cells, not a hard ceiling
- **Live parameter tuner** — a runtime panel (`src/Tuner.vue`) with grouped
  sliders over the tuning registry in `src/constants.js`
- **Orbit camera** — drag to orbit, scroll to zoom

## Tech stack

- [Vue 3](https://vuejs.org/) (`<script setup>`)
- [Vite](https://vite.dev/)
- [Three.js](https://threejs.org/) (via `three/addons`, plus pooled `InstancedMesh`
  for bodies, tails, and food)

## Getting started

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

## Scripts

| Command               | Description                |
| --------------------- | -------------------------- |
| `npm run dev`         | Start the Vite dev server  |
| `npm run build`       | Production build to `dist/`|
| `npm run preview`     | Preview the production build |

## Controls

The HUD (top-left) shows fps, per-breed cell counts, food count, and per-frame
perf timings.

| Input                                | Action                                     |
| ------------------------------------ | ------------------------------------------ |
| Drag                                  | Orbit the camera                           |
| Scroll                                | Zoom                                       |
| Speed slider (1–50×)                  | Time acceleration                          |
| Tails checkbox                        | Toggle tail beat / propulsion on and off   |
| Tuner button                          | Open/close the parameter panel (Esc closes)|
| Restart                               | Rebuild the world at the current defaults  |

## How it works

The simulation is split into focused modules rather than living all in `App.vue`:

- `src/App.vue` — thin Vue shell (lifecycle, HUD, frame timing, overlay)
- `src/sim.js` — `Simulation` orchestrator: collision, physics loop, render lifecycle
- `src/cells.js` — cell domain: create, grow energy→size, mitosis, tails, body pools
- `src/food.js` — food domain: spatial grid, eating + sensing, clumps
- `src/predator.js` — predation: latch + drain
- `src/constants.js` — all tuning constants (a live registry + exported bindings)
- `src/sceneSetup.js` — Three.js scene / renderer / camera / controls / sphere shell
- `src/materials.js` — shared geometries & materials (incl. the body shader hooks)
- `src/render.js` — visibility culling + render pass
- `src/math.js` — pure helpers (random vectors, smoothstep, spatial-hash keys)

### Sphere surface model
Bacteria and food are constrained to the surface of a sphere of radius
`SPHERE_RADIUS` (entities rest at `SURFACE = SPHERE_RADIUS + 0.06`). There is no
boundary — the surface is a closed periodic domain.

### Cells as data objects
A bacterium is a plain data object (no `THREE.Group`): surface `pos`, tangent
`vel`, tangent `heading`, `headingRate`, `quat`, `radius/mass/breed/color`, tail
state, and growth/mitosis state. Physics in `sim.js` reads/writes these directly.

### Energy → size
One value, `d.energy` in `[0, ENERGY_MAX]`, drives everything:
`radius = MIN_RADIUS + (energy/ENERGY_MAX)*(MAX_RADIUS-MIN_RADIUS)` (linear). Eating
(`gainEnergy`) grows it; `METABOLISM` drains it every step. At `ENERGY_MAX` the
cell splits; at zero it starves and dies.

### Motion
`drive = slow × (1 − coast) × fatigue`; thrust `THRUST*drive` along the heading,
high `DRAG` bleeds velocity. Rotation is generated by the tail: chemotaxis and
collision kicks produce a steering bend the tail turns into a `headingRate`,
damped by `ANG_DRAG`.

### Tail-coupled propulsion
The tail is a segmented chain whose base axis follows the body and whose tips
chase a traveling wave. Beat amplitude scales with `drive` (slow bacteria beat
slowly; tails off → `drive = 0` → no tail motion, and the tail mesh is hidden).

## Tuning parameters

All tunables — grouped (World, Movement, Collision, Sensing & Feeding, Mitosis,
Survival, Tail, Predator) with defaults, ranges, and descriptions — live in
`src/constants.js` (`PARAM_DEFS` / `PARAMS` / `GROUPS`) and are adjustable live
via the Tuner panel. Structural/allocation constants (surface radius, cell/food
counts, grid sizes, chunk sizes) are plain `const`s and are excluded from the
registry. See `docs/DESIGN.md` for the full constant table and semantics.

## Project structure

```
cell/
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.js          # app bootstrap
    ├── App.vue          # HUD, lifecycle, frame timing
    ├── Tuner.vue        # live parameter panel
    ├── sim.js           # Simulation orchestrator (physics + render lifecycle)
    ├── cells.js         # cell domain: grow, mitose, tails, body pools
    ├── food.js          # food grid, eating + sensing, clumps
    ├── predator.js      # predation: latch + drain
    ├── constants.js     # tuning constants registry
    ├── sceneSetup.js    # Three.js scene, renderer, camera, controls, shell
    ├── materials.js     # shared geometries & materials
    ├── render.js        # visibility culling + render pass
    └── math.js          # pure helpers
```

## License

MIT
