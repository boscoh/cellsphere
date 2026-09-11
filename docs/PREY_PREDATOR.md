# Predator-Prey: red hunts blue (immobilise, eat, shrink)

> **Status:** implemented (2026-09-05). Beads `cell-k2g` (+ subtasks .1–.5) closed.
> Red (breed 1) hunts/immobilises/eats blue (breed 0); a latched blue glows with a
> **purple aura** (`instanceParalysed`), shrinks and dies; red gains energy and divides.
> Balance: blue flee + red `PRED_DRIVE` (<1) keeps both breeds coexisting (~20/20 at 100
> cells start), no wipe-out. Red does **not** graze food (`eatAndRespawn`/`concentration`
> skip breed 1) — it only chases prey. Implemented via `src/predator.js` `predation()`
> (latches via `cellGrid`/`capsuleDist`, sets `paralysed`, drains `PRED_DRAIN`, marks
> `dying` at energy 0, `gainEnergy` + `PRED_EFF`). `sim.js`: `buildCellGrid()` is rebuilt
> fresh at the top of `advance` (fixes the stale-index crash); red slows to `drive=0`
> while feeding so the latch holds; `PRED_BITE` = `PRED_RANGE` so a latched prey is bitten.


## Goal

- **Blue** (breed `0`): prey. Grazes food, grows, divides as today.
- **Red** (breed `1`): predator. Targets nearby blue cells, **immobilises**
  them, then **drains their energy** so the blue **shrinks** and finally **dies**.
- Optionally: red still grazes food too (predators stay opportunists), but the
  new behaviour is eating *blue*, not food.

## How it fits the existing model

Everything is already keyed on `d.energy` (linear `radiusFromEnergy`), so
"shrink the blue" is automatic if we drain the blue's energy — it shrinks and,
at `energy <= 0`, already dies via the existing `dying → STARVE_FADE → dead`
path. The predator gains that same energy (capped at `ENERGY_MAX`), so a red
that eats enough blue will grow and divide exactly like now.

## New cell state (add to `createCell` in `src/cells.js`)

- `d.paralysed: false` — set on a blue while a red is immobilising/eating it.
- (breed is already `0`/`1`; red = predator.)

## New module: `src/predator.js` (mirrors `food.js` shape)

Export `predation(sim, simDt)`, called from `sim.advance` **after**
`solveCollisions`/`eatAndRespawn` and **before** `updateEnergy`/
`updateStarvation` (sim.js:451). Reuse the existing `cellGrid` (rebuilt each
`advance` in `solveCollisions`) for nearest-neighbour queries — no new grid.
There is currently **no** `forEachNearbyCell` for cells (only
`forEachNearbyFood`), so add a small one in `predator.js` (iterate `cellGrid`
bucket ±radius) that mirrors `forEachNearbyFood`'s shape.

### 1. Detection / targeting
- For each red cell (breed `1`, not `mito/splitting/dying`), scan the
  `cellGrid` buckets (radius ~1–2) for blue cells (breed `0`) within
  `PRED_RANGE` (capsule-gap; reuse `sim.capsuleDist`, which writes `_col`).
- Track the nearest/latching prey on the red cell: `d.target`.
- Target is invalid if: prey is `dead`, `dying`, `splitting`, or beyond a
  re-latch distance (`PRED_LOSE = 1.6 × PRED_RANGE`).
- **Multiple reds on one blue is allowed** — each drains (keeps it simple). A
  red holds at most one target.

### 2. Immobilise
- While latched, set `prey.paralysed = true`.
- In `sim.advance`'s per-cell movement block (the `drive`/`headingRate` section,
  ~sim.js:398): if `d.paralysed`, force `drive = 0`, zero `headingRate`, skip
  chemotaxis, and decay `vel` hard (× a strong decay, or hold) so the prey stops
  and its tail goes limp.
- Clear `paralysed` each frame for any prey no longer latched by a live red
  (target lost / red died).

### 3. Eat & shrink (energy transfer)
- While latched and within `PRED_BITE` distance, drain prey energy:
  - `drainEnergy(prey, PRED_DRAIN * dt)` → blue shrinks (existing linear path).
  - **Death:** `updateEnergy` returns early when `METABOLISM <= 0`, so DON'T rely
    on it — in `predation`, when `prey.energy <= 0`, set `prey.dying = true`
    (and `prey.starveT = 0`) if not already. `updateStarvation` then fades it
    out and marks `dead` → removed. That's the "eats the blue" resolution.
  - `gainEnergy(red, PRED_DRAIN * dt * PRED_EFF)` so the predator grows from the
    meal; `PRED_EFF` may exceed 1 so growth is decoupled from (and can outpace)
    the drain. `gainEnergy` caps at `ENERGY_MAX` and flips `split`, so a
    well-fed red divides.
- A red drains at most `PRED_DRAIN` energy/s (rate-limited like `ABSORB_RATE`)
  and holds only one target.
- A red with no latched target (`!d.target`) additionally burns
  `PRED_METABOLISM` energy/s in `updateEnergy`, so unfed predators die quickly
  instead of lingering on base metabolism alone.

### 4. Perception / escape tension (so prey aren't instantly wiped out)
- Blue flee: the steering is now tail-driven via `d.steer` (chemotaxis → steer →
  tail bend → heading). Add a blue avoidance term that **adds** an
  away-from-reds steer to `d.steer` when a red is within `PRED_RANGE`, so fast /
  lucky blue steer off before the latch drains them.
- Predators are slower: red drive is scaled by `PRED_DRIVE` (< 1), so they can't
  catch everything; blue escapability keeps predation a *maintained*
  population, not a wipe-out.
- Predator gradient sensing: `predatorSense()` (in the sensing pass, next to
  `concentration()`) sums proximity-weighted directions to every valid blue
  within `PRED_SENSE` (weight `1 - dist/sense`) into `d.preyDir`/`d.preyAmt`, and
  red steers up that gradient — so it tracks the shoal instead of a single
  nearest target behind a hard cutoff.
- `PRED_BITE`/`PRED_DRAIN` → a single unlatchable blue takes a few seconds to
  fully consume, giving an observed shrinking.

## Parameters (new `predator` group in `src/constants.js` PARAM_DEFS)

| key | label | def | role |
|---|---|---|---|
| `PRED_RANGE` | Predator range | 0.18 | latch distance (capsule gap) |
| `PRED_SENSE` | Predator sense | 1.5 | distance over which reds smell prey into a gradient |
| `PRED_BITE` | Predator bite | 0.18 | distance at which draining proceeds |
| `PRED_DRAIN` | Predator drain | 0.008 | prey energy drained per second |
| `PRED_EFF` | Predator growth | 1 | energy red gains per second as a multiple of the drain (also division rate) |
| `PRED_METABOLISM` | Predator metabolism | 0.005 | extra energy/s a red burns with no prey latched (starves quickly) |
| `PRED_DRIVE` | Predator drive | 0.7 | red speed multiplier |

`d.paralysed`/`d.target` have no param. Add `predator` to `GROUPS`; wire live
bindings + setters via the existing `export let` / `setters` pattern.

## Interaction with existing systems

- **Collisions**: `solveCollisions` treats all cells as soft sphero-capsules.
  Keep it; it just means the red bumps into a blue before latching. Do NOT let a
  paralysed blue keep being pushed hard — the immobilise should hold it (vel
  decayed ~0) so the red can perch on it.
- **Food**: red keeps grazing food if we want; simplest is to leave food eating
  unchanged (red eats food AND blue). If red should eat *only* blue, gate
  red cells out of `eatAndRespawn`.
- **Mitosis / tail / nucleus**: unchanged. Note a red that eats enough blue
  reaches `ENERGY_MAX` and divides — predators can multiply, which the balance
  params (drain rate/flee) must keep in check.
- **Body pools / render**: nothing new to render; breed colors already differ.

## HUD / observability

- The HUD already shows **per-breed counts** (blue dot / count + red dot / count),
  so a rising red count and shrinking blue count is the predator signal — no layout
  change needed. Optionally flag a `paralysed` prey visually (e.g. dim it) for dev.

## Acceptance criteria

1. Blue count falls over time as red count rises; neither hits 0 in the first
   ~few minutes (balance via `PRED_DRIVE`/`PRED_DRAIN`/blue flee).
2. A latched blue visibly **stops moving** (no drive, tail still) and **shrinks**
   as `updateStarvation`/`updateEnergy` would normally; it dies when energy
   reaches 0.
3. The red grows when it consumes blue and can `mitose`.
4. No NaN; existing food growth/mitosis still works. `npm run build` passes.

## Suggested implementation order

1. Add `predator` param group + live bindings; add `d.paralysed`/`d.target`.
2. Write `src/predator.js` `predation()`: latch via `cellGrid`, immobilise
   (`paralysed`), drain/gain.
3. Hook `predation()` into `sim.advance`; enforce `paralysed` in the movement
   block.
4. Add blue flee (avoid reds) in the steering block.
5. Balance-tune defaults headlessly, then `npm run build`.
