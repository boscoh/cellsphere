# CellSphere

**[Live demo](https://boscoh.github.io/cellsphere/)** ·
**[Source](https://github.com/boscoh/cellsphere)**

A real-time predator–prey simulation on the surface of a sphere. Blue bacteria
graze on scattered food and grow fat enough to divide; red predators hunt them
down and drain their energy. Every cell is an autonomous agent — it senses its
surroundings, steers with an undulating flagellum, and lives or starves on the
energy it banks. No grid, no walls, no seams: continuous motion in a closed,
finite world.

## Motivation

The [Lotka–Volterra equations](https://en.wikipedia.org/wiki/Lotka%E2%80%93Volterra_equations)
are the simplest model of a predator–prey cycle: two populations, one feeding on
the other, oscillating around an equilibrium. That structure is far more general
than the ecology it came from — [Steve
Keen](https://en.wikipedia.org/wiki/Steve_Keen) builds economic dynamics on it,
with workers and capital in place of predators and prey, and [Peter
Turchin](https://en.wikipedia.org/wiki/Peter_Turchin)'s dynastic-cycle models are
the same shape: two coupled populations that boom, overshoot, and crash.

But the equations are boring to look at — two smooth curves and a fixed point —
when the thing they describe moves, chases, eats, and dies, and most attempts to
animate them are just as lifeless. The usual substitute is **cellular
automata**: Conway's Game of Life, Wolfram's Rule 110, Schelling's segregation
model, Sugarscape, lattice Lotka–Volterra, and even the lattice-based Cellular
Potts models. The world is a grid of pixels updated by a rule, and nothing ever
swims, senses a gradient, or chases.

The classic counter-example is NetLogo's *[Wolf Sheep
Predation](https://ccl.northwestern.edu/netlogo/models/WolfSheepPredation)*, a
direct descendant of the animal-population studies the equations were invented
for. CellSphere is the bacterial version: autonomous cells with bodies and
flagella, sensing gradients and spending energy — so the cycle is something you
watch happen, and, as it turns out, something that emerges on its own.

## Design goals

To make cells that look alive *and* still produce a Lotka–Volterra-style cycle,
the design borrows from three traditions that are usually kept apart:

- **Animation** — motion that reads as alive: undulating flagella, spring-chain
  bodies, death bursts timed to the physics.
- **Game physics** — cheap, stable, responsive rules: soft capsule collisions,
  drag, tail-driven steering.
- **Simulation rigour** — a closed, deterministic, headless-testable model whose
  behaviour falls out of state variables, not scripted keyframes.

A **unified energy/food model** ties them together: one `energy` value per cell
drives size, speed, growth, division, and death, and both grazing and predation
feed that same pool. Physics, animation, and ecology all read the same number —
which is what lets the emergent cycle be a *consequence* of the simulation
rather than a chart drawn beside it.

## Features

- **Boundary-free sphere** — a closed surface with no grid, walls, or
  wrap-around seams; cells move and sense continuously
- **Tail-driven steering** — the undulating flagellum is the actuator:
  chemotaxis and collisions bend it, and the bend generates the body's rotation
- **Growth & mitosis** — eating linearly lengthens the body; at full energy it
  splits into two daughters while the parent lingers as an immovable collision
  proxy until they separate
- **Chemotaxis on a peaked gradient** — cells only turn toward food when the
  local gradient is sharply peaked, and slow to a near-stop inside a clump
- **Predator behaviour** — reds ambush and burst, reorient after a meal, and
  share scarce prey: the bite scales with prey-per-predator and stops below one
  prey per predator, so rare prey get a refuge
- **Capsule–capsule collisions** — a mass-weighted soft spring on true capsule
  distance, so elongated bodies repel without phantom contact
- **Chunked instanced rendering** — body/tail `InstancedMesh`es grow on demand,
  tracking the high-water mark of concurrent cells instead of a hard ceiling
- **Live tuning** — every runtime parameter is exposed in a grouped slider panel
  (`src/constants.js` registry)

## Tech stack & architecture

[Vue 3](https://vuejs.org/) + [Vite](https://vite.dev/) + [Three.js](https://threejs.org/),
using pooled `InstancedMesh` for bodies, tails, and food.

The model is split into a **headless simulation** and a **render layer**. Physics
never touches render state, so the world can be built and stepped with no WebGL
at all.

- **Shell** — `main.js` and `App.vue`: bootstrap, HUD, and frame timing; `App.vue`
  banks real time and calls `sim.step(...)`.
- **Simulation** — `sim.js`: the fixed-step physics loop, which subdivides each
  step into `advance(dt)` substeps.
- **Domains** — `cells.js`, `food.js`, `predator.js`, and `tail.js`, on top of the
  shared `collision.js` and `grid.js`: plain-data physics, no Three.js.
- **Render layer** — `view.js` drives `renderSync.js` (pool reconcile) plus
  `bodyPool.js`, `tailPool.js`, and `render.js` (meshes, tails, culling).
- **Tuning** — `constants.js`: the `PARAM_DEFS` / `P` / `GROUPS` registry behind
  the Tuner panel; every runtime value lives here.

Full details — tuning values, invariants, and gotchas — are in
[`docs/DESIGN.md`](docs/DESIGN.md); explorations and history in
[`docs/NOTES.md`](docs/NOTES.md).

## Getting started

Needs Node.js. Install the dependencies (Vue, Vite, and Three.js), then start
the Vite dev server:

```bash
npm install   # fetch dependencies
npm run dev   # start the local dev server with hot-reload
```

The server prints its URL; open <http://localhost:5173> to run the simulation.
For a static production build, `npm run build` writes the site to `dist/`.

## License

MIT
