# AGENTS.md — Development Guide

CellSphere is a Vue 3 + Vite + Three.js real-time **predator–prey simulation on
the surface of a solid sphere**. Green prey graze food; red predators hunt them.
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
- `src/components/PerfPanel.vue` — perf breakdown panel; `src/components/PopChart.vue` — population counts chart; `src/components/RateChart.vue` — prey autocorrelation cycle panel (`rateModel.js`, `popChartMath.js`, `chartCanvas.js` are its pure data/canvas helpers)
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

<!-- bv-agent-instructions-v4 -->

---

## Beads Workflow Integration

This project uses a Beads tracker—either the Go `bd` CLI or the Rust `br` CLI—for issue tracking, plus [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for graph-aware triage. Issues are stored in `.beads/`. `bv` auto-discovers supported JSONL exports, including `.beads/issues.jsonl` and legacy `.beads/beads.jsonl`.

**Choose the tracker CLI from this repository's instructions and configuration.** Use `bd` commands in a Go Beads workspace and `br` commands in a beads_rust workspace. Do not run both trackers against the same workspace or infer the tracker solely from the JSONL filename.

### Using bv as an AI sidecar

bv is a graph-aware triage engine for Beads projects. Instead of parsing .beads/issues.jsonl / .beads/beads.jsonl directly or hallucinating graph traversal, use robot flags for deterministic, dependency-aware outputs with precomputed metrics (PageRank, betweenness, critical path, cycles, HITS, eigenvector, k-core).

**Scope boundary:** bv handles *what to work on* (triage, priority, planning). The selected tracker CLI (`bd` or `br`) handles creating, claiming, modifying, and closing beads.

**CRITICAL: Use ONLY --robot-* flags. Bare bv launches an interactive TUI that blocks your session.**

#### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns everything you need in one call:
- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command

# Token-optimized output (TOON) for lower LLM context usage:
bv --robot-triage --format toon
```

Before claiming, verify current state with the selected tracker: `br show <id> --json`/`br ready --json` or `bd show <id> --json`/`bd ready --json`. `recommendations` can include graph-important blocked or assigned work; only `quick_ref.top_picks` and non-empty `claim_command` fields represent claimable work.

#### Other bv Commands

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-priority` | Priority misalignment detection with confidence |
| `--robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-suggest` | Hygiene: duplicates, missing deps, label suggestions, cycle breaks |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified issues |
| `--robot-graph [--graph-format=json\|dot\|mermaid]` | Dependency graph export |

#### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank scores
```

### Tracker Commands for Issue Management

Use exactly one command family, matching the tracker configured for the repository.

#### Rust beads_rust (`br`)

```bash
br ready --json                       # Show issues ready to work (no blockers)
br list --status=open --json          # All open issues
br show <id> --json                   # Full issue details with dependencies
br create --title="..." --type=task --priority=2 --json
br update <id> --status=in_progress --json
br close <id> --reason="Completed" --json
br close <id1> <id2> --reason="Completed" --json
br sync --flush-only                  # Export DB to JSONL after Beads mutations
```

#### Go Beads (`bd`)

```bash
bd ready --json                       # Show issues ready to work
bd show <id> --json                   # Full issue details
bd create "..." -t task -p 2 --json
bd update <id> --claim --json         # Atomically claim work
bd close <id> --json
bd dep add <issue> <depends-on>
bd export --no-memories -o .beads/beads.jsonl  # Refresh the export read by bv
```

### Workflow Pattern

1. **Triage**: Run `bv --robot-triage` to find the highest-impact actionable work
2. **Verify**: Check the selected tracker's `show`/`ready` output before claiming
3. **Claim**: Use `br update <id> --status=in_progress --json` or `bd update <id> --claim --json`
4. **Work**: Implement the task
5. **Complete**: Use the selected tracker's `close` command
6. **Refresh for bv**: Run `br sync --flush-only` or the `bd export` command above so the JSONL export is current

### Key Concepts

- **Dependencies**: Issues can block other issues. `br ready --json` and `bd ready --json` show unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers 0-4, not words)
- **Types**: task, bug, feature, epic, chore, docs, question
- **Blocking**: Use `br dep add <issue> <depends-on>` or `bd dep add <issue> <depends-on>` to add dependencies

### Git Policy

Tracker commands do not grant permission to commit or push application code. Follow this repository's own git and tracker instructions before staging, committing, syncing, or pushing. If the repository says "commit only when asked," that rule overrides any generic workflow advice.

<!-- end-bv-agent-instructions -->
