# CellSphere

**[Live demo](https://boscoh.github.io/cellsphere/)** ·
**[Source](https://github.com/boscoh/cellsphere)**

A real-time predator–prey simulation on the surface of a sphere. Green bacteria
graze on scattered food and grow fat enough to divide; red predators hunt them
down and drain their energy. Every cell is an autonomous agent — it senses its
surroundings, steers with an undulating flagellum, and lives or starves on the
energy it banks. No grid, no walls, no seams: continuous motion in a closed,
finite world.

## Motivation

The [Lotka–Volterra equations](https://en.wikipedia.org/wiki/Lotka%E2%80%93Volterra_equations)
are the simplest model of a predator–prey cycle: two populations, one feeding on
the other, oscillating around an equilibrium. That structure is far more general
than the ecology it came from, and it keeps turning up under other names. [Steve
Keen](https://en.wikipedia.org/wiki/Steve_Keen)'s Minsky model is Goodwin's
growth cycle — the wage share in the predator role, employment as its prey —
extended with private debt, so a long calm plateau ends in a debt crisis instead
of an equilibrium. [Peter
Turchin](https://en.wikipedia.org/wiki/Peter_Turchin)'s structural-demographic
theory puts elites and commoners in those same two slots: commoners multiply
and are immiserated, elites overproduce, and the populations drift out of step
until the state breaks down. An economy, a dynastic cycle, a food web — one
two-population oscillator, differently dressed. The elite–commoner cycle is the
one we care about most: it is the version that decides how societies go wrong,
and the hardest to see actually happening.

Any picture of that cycle, though, is usually as inert as the equations
themselves: two smooth curves and a fixed point, with nothing in it that could
eat or be eaten. The standard substitute is cellular automata — Conway's
Game of Life, Wolfram's Rule 110, Schelling's segregation model, Sugarscape,
lattice Lotka–Volterra, even lattice Cellular Potts models — but the world is a
grid of pixels updated by a rule, and no agent there ever swims, senses a
gradient or chases. NetLogo's *[Wolf Sheep
Predation](https://ccl.northwestern.edu/netlogo/models/WolfSheepPredation)* is
the notable exception, a direct descendant of the animal-population studies the
equations were invented for: agents that wander a landscape, graze and hunt.

CellSphere is that idea carried down to bacteria on a sphere, where the
population curves are traced by bodies with flagella and an energy budget — the
cycle is not plotted beside the model, it is what the model does. What we wanted
to see was that link made concrete: autonomous agents with a bit of
personality, or at least an animation worth watching. You can follow one green
from grazing to dividing to starving, and one red through the ambush, the lunge
and the kill.

Geography is the other half of it. The sphere is a landscape with distances,
directions and no shortcuts, and where a cell happens to be decides what happens
to it. Food arrives in clumps, so some regions are rich and others are empty,
and a cell senses only a short reach around its own body — nothing here knows
where the food is. Autonomous agents have to search for things, and searching
means getting lost: drifting through an empty quarter, turning on a weak
gradient that leads nowhere, and then having to be lucky — to be in the right
place when a clump of prey goes past, and to reach it while there is still
something left to eat. In a lattice model distance is free and patchiness is a
local update rule; on a sphere it is a cost an agent pays in energy, and the
pattern on the screen is the sum of all those separate, badly informed
journeys.

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
