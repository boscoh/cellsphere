# AGENTS.md — Development Guide

CellSphere is a Vue 3 + Vite + Three.js real-time **predator–prey simulation on
the surface of a solid sphere**. Blue prey graze food; red predators hunt them.
There is no boundary — the surface is a closed periodic domain.

`docs/DESIGN.md` is the authoritative architecture + tuning + gotchas reference;
read it before touching physics. `docs/NOTES.md` is the consolidated record of
explorations, experiments, rejected options, and subsystem history.

## Commands

- `npm run dev` — Vite dev server at http://localhost:5173
- `npm run build` — runs `scripts/gen-params-table.mjs --check`, then
  `vite build` into the gitignored `dist/` (base `/cellsphere/`). This is the
  only quality gate; there is no lint/typecheck.
  `.github/workflows/deploy-pages.yml` publishes `dist/` to GitHub Pages on
  push to `main`.
- `npm run preview` — preview the built site
- `npm run test:tail` — headless Vite-SSR checks, fast (<1s):
  constants registry integrity, capsule-distance geometry, a minimal
  hidden/visible physics equivalence (8 substeps), then direct tail-pathway
  checks — control/pose write no body state, `warmTail` decoupling, wave phase,
  slot handover, pool invariants, render smoke, normalize budget. It calls the
  tail functions directly rather than stepping the simulation. Run it after
  changing physics, tail code, or `constants.js`.
- `npm run test:headless` — plain-Node (no Vite, no WebGL) smoke test: asserts no
  physics module imports a render module, then builds and steps a world through
  `scripts/headless-sim.mjs` assertions. Use it to verify the sim/view boundary.
- `npm run test` — runs both of the above.
- `node scripts/gen-params-table.mjs --write` — regenerate the tuning table in
  `docs/DESIGN.md` from `PARAM_DEFS`. The build fails if it is stale.

## Architecture

- `src/App.vue` — thin shell: lifecycle, frame timing, overlay state
- `src/components/Hud.vue` — top-left HUD (counts, speed slider, tails, restart)
- `src/components/PerfPanel.vue` — perf breakdown panel; `src/components/PopChart.vue` — population chart
- `src/sim.js` — `Simulation` orchestrator: physics loop + data (render
  lifecycle is delegated to `View`)
- `src/view.js` — `View`: owns scene/camera/renderer/controls/pools/meshes +
  render scratch; created by `sim.attach()`
- `src/renderSync.js` — render-side slot reconcile (allocate/rehome/free bodies
  and tails) driven by the cell list
- `src/collision.js` — capsule distance, cell hash, collision solve
- `src/grid.js` — spatial hash: key packing + neighbourhood scan
- `src/cells.js` — cell domain: create/grow/mitose (bodies and tails are separate)
- `src/bodyPool.js` — pooled body `InstancedMesh`es, one pool per length bucket
- `src/tailPool.js` — tail instance pool, slot claims/transfers, segment placement
- `src/tail.js` — tail physics: steering control, spring-chain + kinematic pose, re-aim
- `src/food.js` — food grid, eating + sensing, clumps (plain data)
- `src/foodRender.js` — food `InstancedMesh` create/sync from `food.dirty`
- `src/predator.js` — predation: latch + drain
- `src/constants.js` — tuning registry (`PARAM_DEFS`/`P`/`GROUPS`) + plain consts
- `src/sceneSetup.js` — `createSceneCore` (scene/shell) + `attachGraphics`
  (camera/renderer/controls/lights)
- `src/materials.js` — shared geometries & materials (body shader hooks)
- `src/render.js` — visibility culling + render passes (take a `View`)
- `src/glow.js`, `src/pops.js` — death-burst billboards
- `src/perf.js` — per-frame timing; `src/components/Tuner.vue` — parameter UI
- `src/math.js` — pure helpers
- `src/util.js` — dependency-free script/test helpers (seeded PRNG)

Invariants an agent must not break:

- Cells are **plain data objects, not `THREE.Group`**. Physics reads/writes their
  fields directly (`pos`, tangent `vel`/`heading`, `energy`, tail state, `quat`).
- **Time loop**: `App.vue` banks real time and calls `sim.step(simDt * simRate)`;
  `step` subdivides into `clamp(ceil(simDt/FIXED_DT), 1, MAX_STEPS)` substeps of
  `advance(dt)`. Rendering is separate: `sim.render(tailScale, dt)` delegates to
  the `View`.
- **Headless physics**: `new Simulation(); sim.buildWorld(); sim.step(dt)` works
  with no WebGL and no `View` at all. Render resources (scene, pools, meshes,
  materials) live on `View`, which is created by `sim.attach()`; a `View` can be
  built without a container for headless pooled-render tests.
- **Sim/view boundary**: physics modules (`cells`, `food`, `predator`, `tail`,
  `collision`, `grid`, `math`) must never import a render module (`view`,
  `render`, `renderSync`, `bodyPool`, `tailPool`, `sceneSetup`, `materials`,
  `glow`, `pops`, `foodRender`). `npm run test:headless` enforces this.
- **Slot lifecycle is render-owned**: physics never allocates body/tail slots.
  `renderSync.syncCells(view)` reconciles pools with `sim.cells`; cell records
  carry `body*/tail*` handle fields as render-written state only.
- `energy` in `[0, ENERGY_MAX]` drives size linearly; `ENERGY_MAX` → mitosis,
  `0` → immediate death (no fade).
- Cell–cell collision must use **capsule–capsule** distance, not sphere distance.
- Tails are visual-only except the `tailBend` scalar that drives `headingRate`;
  tail control runs even while tails are hidden, so steering is unaffected. The
  cosmetic pose is gated by the sim-owned `poseEnabled` (set by `App.vue` from
  the HUD toggle); `View.tailsHidden` is render-only mesh visibility.
- Body/tail `InstancedMesh`es grow on demand in fixed-size chunks; they are not
  sized to `MAX_CELLS`.

## Tuning & code style

- All runtime-tunable values live in `src/constants.js` (`PARAM_DEFS`/`P`/
  `GROUPS`) and are editable live in the Tuner panel. A parameter is declared once,
  in `PARAM_DEFS`; its value lives in the single mutable `P` record, so read
  `P.THRUST`, never a bare binding. Structural constants (counts, grid/chunk
  sizes) are plain `const`s outside the registry. Full table in
  `docs/DESIGN.md`. The HUD speed slider is `simRate` (`SIM_SPEED`, 1–50×), not a
  "viscosity".
- 2 spaces, no semicolons, single quotes
- Vue Composition API with `<script setup>`; `camelCase` functions, `PascalCase` components
- No comments unless the logic genuinely needs them
- Match the patterns of a neighboring file before adding code

## Issue tracking (Beads)

Work is tracked in **Beads** (`bd`, Dolt-backed). `bd prime` is the single
source of truth for the workflow; run it after compaction or in a new session.
The `beads` skill lives at `.agents/skills/beads/SKILL.md`. Never keep a second
task list in markdown.

```bash
bd ready                       # unblocked work
bd create "title" -t task -p 2 # new issue; add --json for structured output
bd update <id> --claim         # claim atomically
bd close <id> --reason "..."   # complete
bd sync                        # full pull/check/push (only when authorized)
bd dolt push                   # push Dolt history (only when authorized)
```

- Issues live in a local Dolt DB. `bd sync` runs the full pull → conflict-check
  → push cycle; `bd dolt push`/`pull` are the low-level primitives. Both target
  `refs/dolt/data` on the git remote (configured in `.beads/config.yaml`). Fresh
  clones run `bd bootstrap`. The JSONL export is a passive artifact, not the
  sync protocol.
- Never use `bd edit` (it opens an interactive `$EDITOR`); update fields with
  flags such as `bd update <id> --description ...` instead.
- Link discovered work with `--deps discovered-from:<id>`.

**Git & task policy (conservative default).** Use `bd` for all task tracking.
Do not commit, push, or run `bd dolt push` unless explicitly asked; at handoff,
report changed files, validation, and suggested next commands. Explicit user or
orchestrator instructions override this section. When finishing a session: file
beads for any remaining work, run the quality gate (`npm run build`) if code
changed, update issue status, then hand off.
