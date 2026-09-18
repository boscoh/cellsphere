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
  `scripts/clean-docs.mjs`, then `vite build` **into `docs/`** (the committed
  GitHub Pages site, base `/cellsphere/`). This is the only quality gate; there
  is no lint/typecheck. Do not confuse `docs/` with the ignored `dist/`.
- `npm run preview` — preview the built site
- `npm run test:tail` — the only test. Headless Vite-SSR checks: constants
  registry integrity, capsule-distance geometry, tail visible/hidden physics
  equivalence, `warmTail` decoupling, wave phase, and a pose smoke test. Run it
  after changing physics, tail code, or `constants.js`.
- `node scripts/gen-params-table.mjs --write` — regenerate the tuning table in
  `docs/DESIGN.md` from `PARAM_DEFS`. The build fails if it is stale.

## Architecture

- `src/App.vue` — thin shell: lifecycle, frame timing, overlay state
- `src/Hud.vue` — top-left HUD (counts, speed slider, tails, restart)
- `src/PerfPanel.vue` — perf breakdown panel; `src/PopChart.vue` — population chart
- `src/sim.js` — `Simulation` orchestrator: physics loop, render lifecycle
- `src/collision.js` — capsule distance, cell hash, collision solve
- `src/grid.js` — spatial hash: key packing + neighbourhood scan
- `src/cells.js` — cell domain: create/grow/mitose (bodies and tails are separate)
- `src/bodyPool.js` — pooled body `InstancedMesh`es, one pool per length bucket
- `src/tailPool.js` — tail instance pool, slot claims/transfers, segment placement
- `src/tail.js` — tail physics: steering control, spring-chain + kinematic pose, re-aim
- `src/food.js` — food grid, eating + sensing, clumps
- `src/predator.js` — predation: latch + drain
- `src/constants.js` — tuning registry (`PARAM_DEFS`/`P`/`GROUPS`) + plain consts
- `src/sceneSetup.js` — scene / renderer / camera / controls / sphere shell
- `src/materials.js` — shared geometries & materials (body shader hooks)
- `src/render.js` — visibility culling + render pass
- `src/glow.js`, `src/pops.js` — death-burst billboards
- `src/perf.js` — per-frame timing; `src/Tuner.vue` — parameter UI
- `src/math.js` — pure helpers

Invariants an agent must not break:

- Cells are **plain data objects, not `THREE.Group`**. Physics reads/writes their
  fields directly (`pos`, tangent `vel`/`heading`, `energy`, tail state, `quat`).
- **Time loop**: `App.vue` banks real time and calls `sim.step(simDt * simRate)`;
  `step` subdivides into `clamp(ceil(simDt/FIXED_DT), 1, MAX_STEPS)` substeps of
  `advance(dt)`. Rendering is a separate `sim.render(tailScale)`.
- **Headless physics**: `new Simulation(); sim.buildWorld(); sim.step(dt)` works
  with no WebGL/`attach()`. Use this for tests and debugging.
- `energy` in `[0, ENERGY_MAX]` drives size linearly; `ENERGY_MAX` → mitosis,
  `0` → immediate death (no fade).
- Cell–cell collision must use **capsule–capsule** distance, not sphere distance.
- Tails are visual-only except the `tailBend` scalar that drives `headingRate`;
  tail control runs even while tails are hidden, so steering is unaffected.
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
source of truth for the workflow; run it after compaction or in a new session
(Codex auto-loads it via native hooks). The `beads` skill lives at
`.agents/skills/beads/SKILL.md`. Never keep a second task list in markdown.

```bash
bd ready                       # unblocked work
bd create "title" -t task -p 2 # new issue; add --json for structured output
bd update <id> --claim         # claim atomically
bd close <id> --reason "..."   # complete
bd dolt push                   # push Dolt history (only when authorized)
```

- Issues live in a local Dolt DB; `bd dolt push`/`pull` sync `refs/dolt/data`
  over the git remote (configured in `.beads/config.yaml`). Fresh clones run
  `bd bootstrap`. The JSONL export is a passive artifact, not the sync protocol.
- Never use `bd edit` (it opens an interactive `$EDITOR`); update fields with
  flags such as `bd update <id> --description ...` instead.
- Link discovered work with `--deps discovered-from:<id>`.

**Git & task policy (conservative default).** Use `bd` for all task tracking.
Do not commit, push, or run `bd dolt push` unless explicitly asked; at handoff,
report changed files, validation, and suggested next commands. Explicit user or
orchestrator instructions override this section. When finishing a session: file
beads for any remaining work, run the quality gate (`npm run build`) if code
changed, update issue status, then hand off.
