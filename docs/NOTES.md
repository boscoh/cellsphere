# CellSphere — Consolidated Notes (explorations, experiments, history)

`docs/DESIGN.md` is the authoritative reference for the current architecture,
tuning values, and gotchas. This file is the consolidated record behind that
design: subsystem models, balance experiments, measured results, rejected
options, and the decisions that produced the code. It replaces the former
`PREY_PREDATOR.md`, `PREDATOR_EXPLORATION.md`, `COLLISION_EXPLORATION.md`,
`FOOD_SENSING_EXPLORATION.md`, `TAIL_EXPLORATION.md`, and
`RENDER_BUG_POSTMORTEM.md`.

1. [Predator–prey](#1-predatorprey)
2. [Cell–cell collision](#2-cellcell-collision)
3. [Food sensing](#3-food-sensing)
4. [Tail](#4-tail)
5. [Render bug post-mortem](#5-render-bug-post-mortem)
6. [Appendix — experiment method](#appendix--experiment-method)

References are by symbol rather than line number, which drifts.

---

## 1. Predator–prey

> **Status:** implemented. Beads `cell-k2g` (+ subtasks `.1`–`.5`), `cell-v9d`
> (energy economy), `cell-dmd` (coupling), `cell-erd` (re-acquisition).

### Executive summary

The ecology is a **predator–prey cycle**, and the goal state is a *bounded
oscillation* — green and red numbers rise and fall indefinitely without either
species dying out. Each breed follows a simple strategy, and four design choices
keep the cycle from tipping into a boom-and-bust. The rest of §1 is the detail
behind this paragraph.

**Prey (green): graze food, grow, divide, avoid being eaten.**

- Sense the food gradient, steer up it, and slow to graze once food is close.
- Energy drives size; full energy triggers division, zero energy is instant death.
- Steer away from nearby reds.

**Predator (red): find prey, latch one, drain it, then divide or starve.**

- Follow the local prey gradient; short "hunt" and "reorient" windows turn hard
  at the nearest green, and it ambushes (cruises at range, bursts when close).
- Holds **one** prey at a time and drains it — its only energy source.
- Energy drives division, but an unfed red burns extra energy and dies quickly.

**Four stabilisers make it a *good* cycle** (weaken any and it can collapse):

| design choice | in plain terms | knob |
|---|---|---|
| predators share scarce prey | per-predator kill falls as predators outnumber prey | `PRED_RATIO` |
| rare prey get a refuge | hunting stops below one prey per predator | stop-hunting gate |
| predators starve fast | no fat reserve; an unfed red dies in seconds | `METABOLISM`, `PRED_METABOLISM` |
| prey have their own food | clumped food regrows, so prey can recover | food grid, `FOOD_RESPAWN` |

**The resulting cycle.** Predators lag prey by roughly a quarter-cycle: prey rise
on food, predators follow and over-hunt a little, prey dip, predators starve and
dip, prey recover. Counts stay bounded (order 10–80 green, 5–45 red at defaults)
and both survive on every seed tested — a bounded oscillation, not a fixed point
or a collapse. This is the classic predator–prey picture; §1.6 names the models
it matches.

**What breaks it.** `PRED_EFF > 1` (predators gaining free energy), or weakening
the ratio response / refuge, tips the cycle into **overshoot**: predators pass
green, wipe out prey, then starve. Measured with the ratio response off: reds
overshoot by +34 cells, then both go extinct. §1.6 maps these roles to classic
ecology.

### 1.1 Model

- **Breeds.** Green (breed `0`) grazes food and divides as usual. Red (breed `1`)
  hunts green. Reds are skipped by `eatAndRespawn`/`concentration`, so a red's
  only energy is a green it drains.
- **Latch.** A red scans the cell grid for the nearest valid green within
  `PRED_RANGE` (capsule gap), stores it as `red.target`, and re-latches while
  within `PRED_RANGE × 1.6`. One target per red; multiple reds may drain the
  same green. `buildCellGrid` is rebuilt fresh at the top of `advance`.
- **Immobilise.** Within `PRED_RANGE` the green is `paralysed`: `sim.advance`
  forces `drive = 0`, zeros `headingRate`, hard-decays velocity, and skips
  chemotaxis. A latched prey glows purple (`instanceParalysed`). While it has a
  paralysed target a red's own drive is 0, so the latch holds.
- **Drain / gain.** Within `PRED_BITE` (≥ `PRED_RANGE`, so a latch is bitten),
  `drainEnergy(green, PRED_DRAIN·dt)` and
  `gainEnergy(red, PRED_DRAIN·dt·PRED_EFF)`. The green shrinks because size is
  linear in energy and dies at `energy <= 0` (`killedByPred`). `gainEnergy`
  caps at `ENERGY_MAX`, so a well-fed red divides.
- **Sensing.** `predatorSense()` sums proximity-weighted directions to every
  valid green within `PRED_SENSE` into `preyDir`/`preyAmt`; reds steer up that
  gradient. It also records `preyNear` (nearest capsule gap) for the ambush.
- **Ambush.** While no prey is within `PRED_LUNGE`, red `drive` is scaled by
  `PRED_COAST`; inside the lunge it bursts at full drive. Steering is unaffected,
  so a coasting red still turns onto prey.
- **Re-acquisition.** After a meal the shoal gradient can point ~40° off the
  nearest green, so a red swims past close prey. `PRED_REORIENT` (default 0.3s)
  steers at the nearest prey and suppresses the ambush coast for that window;
  `PRED_FOCUS` steepens the proximity weight (default 1 = linear).
- **Ratio-dependent predation.** `PRED_RATIO` (`0` = off) implements an
  Arditi–Ginzburg response: `attack = ratio / (ratio + K)` with
  `ratio = prey / predators`. As predators outnumber prey the per-capita attack
  falls, giving rare prey an emergent refuge.

### 1.2 Balance history and findings

**A. Reds starved before they could reproduce (`cell-v9d`).** An unfed red burned
`METABOLISM + PRED_METABOLISM + MOVE_COST·drive ≈ 0.007/s` but gained only
`PRED_DRAIN × PRED_EFF = 0.008/s` while biting, and `PRED_DRIVE = 0.7` made reds
slower than fleeing greens. Seeded 180s run: 15 reds → 1, 0 births, green 50 → 82.
Fix (600s × 3 seeds → green 50→213/236/256, red 15→73/66/53, 48–68 births,
110–140 kills, no NaN):

| key | old | new |
|---|---|---|
| `PRED_DRAIN` | 0.008 | **0.012** |
| `PRED_METABOLISM` | 0.005 | **0.001** |
| `PRED_DRIVE` | 0.7 | **0.9** |
| `PRED_EFF` | 1 | 1 (unchanged) |

**B. A clump is not a feast.** Intake is a fixed `PRED_DRAIN` on **one** latched
target. More prey nearby only shorten search dead-time; they do not raise
energy/second. A density-scaled drain or multiple simultaneous targets would
change this (not implemented).

**C. Long runs still went extinct.** With the §1.2 defaults, a 1800s run showed
green 50→223→0 (~860s), then red 15→179→0 (~1160s): reds boom, overhunt the last
greens, then starve. Structural cause is the saturating (Type II) one-target
intake — once prey are common the total kill rate scales with *predator* count
(the paradox of enrichment).

**D. Winner: ratio-dependent predation + scarce prey (`cell-dmd`).** Ratio
dependence makes per-capita kill fall as predators outnumber prey; lowering
`FOOD_COUNT` 7000 → 3000 gives prey a carrying capacity to cycle against.
Together they produce a sustained bounded cycle:

| run (3600s) | seed | green | red |
|---|---|---|---|
| `FOOD_COUNT 3000`, `PRED_RATIO 1` | 1 | 20..91 | 7..48 |
| " | 2 | 28..200 | 7..113 |
| + `PRED_HANDLE 20` (test only) | 1 | 19..93 | 8..56 |
| + `PRED_HANDLE 20` (test only) | 2 | 22..175 | 6..97 |

Reds lag greens by a quarter-cycle: as prey drop, predators starve and drop; as
prey recover, predators follow. Shipped defaults: `FOOD_COUNT = 3000`,
`PRED_RATIO = 1` (later lowered to 0.75; see §1.6). `PRED_EFF > 1` (energy
creation) is the single most destabilising knob — it always ends in prey wipeout.

**E. Re-acquisition A/B (`cell-erd`).** Seeded A/B (relatch within 2s): baseline
14/15%, `PRED_FOCUS=2` 24/19%, `PRED_REORIENT=0.3` 23/20%; mean nearest-green
distance at meal end 1.52 → 1.36 with `PRED_REORIENT=0.3`. **Adopted
`PRED_REORIENT = 0.3`**; `PRED_FOCUS` stays 1. Disabling the ambush
(`PRED_COAST=1`) crashes green (64→27), so the ambush is load-bearing.

### 1.3 Rejected stabilisers

Implemented behind temporary parameters, tested, then **removed from the code**;
only ratio-dependent predation survived.

| mechanism | temp param | verdict |
|---|---|---|
| global prey refuge | `PRED_REFUGE` | works but a magic population floor → **rejected as artificial** |
| predator interference | `PRED_INTERFERE` | no help; still extinct |
| handling time | `PRED_HANDLE` | delays the crash only (or reds dominate) |
| crowding cost | `PRED_COMPETE` | wrong feedback; over/under-shoots |
| Type III local threshold | `PRED_HALF` | narrow usable window; not satisfactory alone |
| ratio-dependent | `PRED_RATIO` | **kept** (bounded cycles with scarcity) |

### 1.4 Open follow-ups

- Clumps are still not a feast (fixed single-target intake); see §1.5 for the
  measured eating-speed options and the division-orientation bug.
- Reds cannot graze food at all; grazing would give a survival floor.
- Early dip: reds fall 15 → ~6–11 around t=90–150s before green builds.
- Ambush refinement (`cell-fgh`: `PRED_SIGHT`/`PRED_LUNGE`, pivoting while
  resting) — not addressed here.
- `FOOD_COUNT 3000` changes the non-predator base feel; revert if undesired.

The full `predator` parameter table is generated into `DESIGN.md`.

### 1.5 Clump camping, division orientation, eating speed

> **Status:** investigation only (2026-09). No default changed. Seeded headless
> runs (`ssrLoadModule('/src/sim.js')`, `mulberry32` from `src/util.js`), 600–
> 3600 s, seeds 1–3, PRED_* overridden directly on `P`.

**A. Daughters face each other by design; the defect is post-division
food-seeking.** Facing each other is *deliberate, not a bug*: each daughter's
tail must stream **outward**, away from its sibling, and since the tail trails
`-heading` the body heading must point inward. `mitose()` places the `back` cell
at `startPos + headBack·(-half·MITO_NEAR)` with heading `headBack` (backward) and
mirrors `front`, which is exactly what keeps the two tails outside — correct.

The real problem is what happens next: a freshly divided cell is bad at finding
the food right beside it, so a green that divides on a clump often leaves it.

- `concentration()` and `eatAndRespawn()` skip cells while `d.mito || d.splitting`,
  so daughters are **food-blind for the whole `MITO_TIME` (5 s)**.
- `finalizeMito` then gives each daughter `rest = MITO_REST` (4 s) with
  `drive = 0`: it coasts in place and may only turn. Steering is live after one
  sense pass (`foodPeak ≈ 0.46`, `|steer| ≈ 0.44`), but the tail-driven
  `headingRate` is drag-limited (`≈ TAIL_TURN·tailBend/ANG_DRAG`), so the body
  swings only ≈13° during the 4 s rest.
- The outward-facing tails also mean the birth heading points at the sibling —
  ~90° off the nearest food on average — and when drive resumes the near-food
  `slow` (grazing) term keeps the daughter crawling, so it mills/drifts instead
  of closing.

Measured over 516 divisions (seed 1, 1200 s): nearest-food distance at release
0.166–0.211; by 16 s it is essentially unchanged (0.172–0.195) and system-wide
mean `|headingRate|` is 0.036 rad/s (≈0.07 for daughters). So the failure is an
**actuation/re-aim problem in the division aftermath** — an inward birth heading
plus a ~9 s blind/coast window the cell cannot turn through — not the facing
itself. Candidate fixes: let daughters sense during `MITO_REST` (or during
mitosis), shorten `MITO_REST`, seed a stronger initial turn toward the sensed
gradient at release, or raise steering authority for the re-aim window.

**B. Why a red does not camp a clump.** Measured (600 s, seeds 1–2): reds are
latched ~40–50 % of their lives, mean kill gap ~65–71 s, mean re-latch ~30 s, and
only ~40–50 % of meals are followed by a fresh latch within 2 s. Causes, in order:

1. **Single-target, fixed-rate intake.** `PRED_DRAIN` on one latched green; a
   clump only shortens search dead-time (§1.2.B). This caps throughput hardest.
2. **Short re-orient window.** `PRED_REORIENT` is 0.3 s; after it the red reverts
   to the shoal gradient (`preyDir`), a proximity-weighted average that can point
   off the nearest green, and re-enables the ambush coast (`PRED_COAST`) so it
   closes on the next green at 0.35 drive while beyond `PRED_LUNGE`.
3. **Energy coast band.** Above `MITO_SLOW_FRAC = 0.9` drive ramps to 0, so the
   best-fed red — the one that just ate — is the least inclined to chase again.
4. **Ratio gate.** `PRED_RATIO = 1` stops hunting entirely once `prey/pred < 1`.
   That is what protects prey at the crossover, but it also truncates camping.

Multi-red competition and the shared ratio throttle amplify all four.

**C. Eating faster with a transient red > green, without a prey wipeout.** Keeping
`PRED_EFF = 1`, `PRED_COAST`, `PRED_LUNGE`, `PRED_METABOLISM` and `PRED_RATIO`
unchanged, raise `PRED_DRAIN` alone. 3600 s, seeds 1/2/3 (`red>green` = max
red−green; `×` = red/green curve crossings):

| `PRED_DRAIN` | green min..max | red min..max | red>green | crossings | extinct? |
|---|---|---|---|---|---|
| 0.02 | 15/15/12..158/76/141 | 5/6/2..84/39/79 | 7/3/2 | 4/4/10 | no |
| 0.025 | 19/24/21..59/62/85 | 7/5/7..30/34/53 | 1/3/2 | 2/6/2 | no |
| 0.03 | 18/9/22..72/70/126 | 6/1/6..43/32/71 | 2/1/3 | 4/4/10 | no |

Baseline `PRED_DRAIN = 0.012` (1800 s, seeds 1–2) never crosses: green 26..92,
red 9..55, `red>green = 0`, 0 crossings. So the crossover comes entirely from a
faster bite.

**Rejected in the same sweep.** `PRED_EFF = 0.5` (drain 0.03): reds convert too
little, prey bloom to 191–300, crossover becomes seed-dependent (4/0) — reject.
`PRED_RATIO = 2–3`: suppresses the crossover entirely and lets prey bloom to 343.
`PRED_METABOLISM = 0.002` (drain 0.03): seed 2 starved all reds (green 500,
red 0) — reject. Raising `PRED_REORIENT` to 2 s gave a small kill-gap gain
(60–63 s vs 65–71 s) but nothing else, because intake is intake-limited.

**Recommendation.** `PRED_DRAIN` 0.012 → **0.02** (1.67×): shortest change that
shortens time-on-prey, produces repeated transient red > green overshoots (up to
+7 cells), and kept both populations alive in all six long runs. `0.025` is the
conservative alternative; `0.03` also survived these seeds but seed 2 dropped to
a single red, so treat it as riskier. If a stronger, more visible boom is wanted,
the structural move is the §1.4 **clump feast** — scale drain with local prey
density (`rate *= 1 + c·(nearby−1)`) or allow N simultaneous latches — so a red
eats fast inside a clump while isolated greens survive as refuge; that needs its
own A/B.

**D. Outcome (2026-09): targeted fixes shipped.**

- **Faster bites (`cell-t82`).** `PRED_DRAIN` default 0.012 → **0.02** (table
  above); `PRED_EFF`/`PRED_RATIO` unchanged.
- **Graze radius separated (`cell-11i`).** `concentration()` now computes the
  drive slowdown from a new `GRAZE_RADIUS` radius (`nearSense = width +
  GRAZE_RADIUS`) while the wide `SENSE_BOOST` radius only steers. Default
  `GRAZE_RADIUS = 0.25` exactly reproduces the old all-range slowdown, and it was
  **not lowered**: sweeping it down (1800 s, seeds 1–2) speeds every cell
  (`drive` 0.04 → 0.51) but barely improves daughter growth (8 s energy 0.28 →
  0.35) and throws the ecology into heavy oscillation (crossings 6–16 → 42, and
  126–146 over 3600 s). It stays as a live tuning knob.
- **Post-division forage window (`cell-x93`).** A daughter gets `MITO_FORAGE`
  (6 s) in which it ignores the graze slowdown and turns hard at the sensed
  gradient (`FORAGE_TURN = 20`; a deterministic heading-rate assist, drag-capped
  at `MAX_SPIN`). This is the *targeted* version of the graze idea, so it leaves
  the ecology alone. 1800 s, seeds 1–2: daughter energy at 8 s **0.28 → 0.40**,
  at 16 s 0.32 → 0.41; populations stayed bounded with no extinction and
  crossings unchanged (6–8).
- **Post-meal re-aim (`cell-700`).** `PRED_REORIENT` 0.3 → 1.5 s, the window now
  also zeroes the energy coast, and a `REORIENT_TURN = 20` heading-rate assist
  turns the red toward `preyNearestDir` (drag-capped at `MAX_SPIN`). Widening the
  window alone did **not** help (re-latch unchanged) — the bottleneck is turn
  authority, so the assist is the effective part. 1800 s, seeds 1–2: re-latch
  within 2 s ~30% → ~42%, mean kill gap ~82 s → ~68 s. 3600 s × 3 seeds stayed
  bounded with no extinction (green 19..94, red 6..51, red>green 4–6).
- **Clump feast (`cell-3bz`, opt-in prototype).** New `PRED_CROWD` scales the
  bite with prey packed within `PRED_SENSE`
  (`rate *= 1 + PRED_CROWD·(nearby−1)`), so a shoal feeds a red faster than a lone
  green. Default **0** keeps “a clump is not a feast”. 1800 s, seeds 1–2:
  `PRED_CROWD` 0.5–2 lowers mean kill gap 69–92 s → 59–67 s but also suppresses
  prey (green max 62–67 → 50–62) and does not improve re-latch; 3600 s × 3 seeds
  at 1.0 stayed bounded (green min 10–16, no extinction). Left off by default as a
  Tuner knob — the effect is real but modest, and it trades prey abundance for
  bite speed.
- **Predator re-aim (`cell-zby`).** The visible “red takes a long curve” is
  mostly the freshly divided red: born facing its sibling (tails out), it had the
  forage window’s drive but no aim, so it swam off and curved back. Two fixes:
  (1) the forage heading-rate assist now also serves reds, aimed at the nearest
  prey — red-daughter aim at 2 s goes **87° → ~20°** (10 s latch rate 91–95% →
  94–96%); (2) new `PRED_HUNT` (1 s) opens the same hard-turn assist the moment a
  red *newly* smells prey, so adults re-aim onto a new shoal instead of arcing.
  Making reds *permanently* agile was rejected: an unconditional turn assist
  halves populations (green max 62–67 → 50, reds crash) and high gain goes
  extinct, so the assist stays event/window-limited. 3600 s ×3 at `PRED_HUNT=1`
  stayed bounded, no extinction.
- **Slow-drive turn mode (`cell-1eo`, rejected).** `headingRate` comes only from
  the tail (`+= TAIL_TURN·tailBend·dt`, damped by `ANG_DRAG`); `drive` is not in
  it, so slowing shrinks the turn radius R = v/ω but never the time to turn.
  Scaling predator drive by heading error (`PRED_TURN_SLOW`) made aim worse
  (73–74° → 87–90° at full) and cut kills, because the agent just loses ground;
  prey would be penalised identically. Left as an off-by-default knob. The
  untested variant is a *windowed* pivot — also cut drive inside the existing
  reorient/hunt/forage heading-assist windows — which is the only version that
  could tighten the visible arc without permanent-agility blow-up.

### 1.6 External context: how ecologists explain booms and crashes

> **Status:** reference note (2026-09), drawn from encyclopedia- and
> model-documentation-level sources (listed below), not primary literature. No
> behaviour or parameter changed for this note.

**The problem.** Predators eat prey, so more predators mean fewer prey, and
fewer prey mean predators starve. Left unchecked this swings hard: predators
breed while prey are plentiful, keep eating after prey start to fall, drive prey
to near zero, then starve themselves. Predators passing the level the prey can
sustain is **overshoot**; the wipeout-and-crash that follows is what we want to
avoid. With our stabilisers switched off the sim does exactly this — reds
overshoot greens by ~34 cells, then both die out.

**How fast a predator eats is the key knob.** The rule for "eating rate vs how
common prey are" is called the **functional response**. There are three standard
shapes:

- **Rises without limit** — twice the prey, twice the eating rate. (Called
  *Type I*; used by the original textbook model.)
- **Rises, then levels off** — a predator eats faster as prey appear but tops
  out, because chasing and handling each meal takes time. This is what our reds
  do: one latched green at a time, at a fixed bite rate. (Called *Type II*.) On
  its own it is the classic cause of overshoot — when prey are common every
  predator is full, so predator numbers grow until the prey run out. The
  boom-and-bust has a famous name, the **paradox of enrichment**: making life
  richer for the prey makes the whole system *less* stable.
- **Slow start** — when prey are rare the predator is unusually bad at finding
  them, and intake only ramps up once prey are common. (Called *Type III*.) The
  effect is a natural **refuge**: rare prey are hard to catch, so enough survive
  to recover.

**The fixes ecologists use**, in plain terms:

- **Share the prey.** The more predators there are, the less each one catches.
  This is our `PRED_RATIO` (the "ratio-dependent" rule: a predator's success
  depends on prey *per predator*, not the raw prey count).
- **Give rare prey a refuge.** Stop hunting when prey become scarce — our
  stop-hunting gate.
- **Let predators starve quickly.** An unfed predator that dies fast cannot
  finish off the last prey — our `PRED_METABOLISM`.
- **Give prey their own food supply.** Prey that regrow from food recover,
  giving predators something to rebound on — our food grid and `FOOD_RESPAWN`.

**What CellSphere actually does:**

| our knob | in plain terms | why it helps |
|---|---|---|
| `PRED_RATIO` | predators share scarce prey | stops them over-hunting once they outnumber prey |
| stop-hunting gate | rare prey are left alone | guarantees prey can recover |
| metabolism + `PRED_METABOLISM` | unfed predators die quickly | predators can't linger and finish prey off |
| food grid + `FOOD_RESPAWN` | prey have their own food supply | prey recover, so the cycle keeps going |
| `PRED_EFF = 1` | predators gain no free energy | `> 1` reliably wipes out the prey |

**What we tried before landing here.** `§1.3` implemented and tested the
textbook fixes, then dropped most of them: a global "never below N" floor (felt
artificial), predator interference (no help), longer handling time (only delayed
the crash — and handling time is what *causes* the problem, not a cure), a
crowding penalty (right idea, wrong feedback), and a weak slow-start threshold
(only worked in a narrow range). Sharing the prey is the one that worked, and it
also has the best pedigree in the theory.

**One caveat.** Ecologists don't agree that "share the prey" describes real
predators: Ginzburg argues for it, Abrams against, and a review concluded the
evidence doesn't clearly favour either. So `PRED_RATIO` is a reasonable, standard
choice — not settled fact.

**Another simulation reaches the same answer.** NetLogo's *Wolf Sheep Predation*
is the closest public equivalent. With unlimited grass it is "ultimately
unstable" (predators overshoot and everything dies); add a regrowing grass
resource and it becomes "generally stable". Its predators also spend energy each
step and die at zero energy — the same metabolism mechanic we use.

**If we drop the gate.** Relying only on shared prey: weak sharing → overshoot
then extinction on all tested seeds; very strong sharing → survives, but prey dip
lower. The smoother replacement for the gate would be a proper slow-start
(*Type III*) rule instead of a hard cutoff; `§1.3` only tested a crude threshold,
so that A/B is still open. `PRED_T3_HALF` now implements that smooth rule (a
Hill sigmoid in local prey count; default `0` = off), so it can be tried in the
Tuner.

**Sources.** Overview-level: [Paradox of
enrichment](https://en.wikipedia.org/wiki/Paradox_of_enrichment), [Functional
response](https://en.wikipedia.org/wiki/Functional_response), [Lotka–Volterra
equations](https://en.wikipedia.org/wiki/Lotka%E2%80%93Volterra_equations),
[Arditi–Ginzburg
equations](https://en.wikipedia.org/wiki/Arditi%E2%80%93Ginzburg_equations),
[Refuge (ecology)](https://en.wikipedia.org/wiki/Refuge_(ecology)), [Predator
satiation](https://en.wikipedia.org/wiki/Predator_satiation), [NetLogo Wolf Sheep
Predation](https://ccl.northwestern.edu/netlogo/models/WolfSheepPredation). Primary:
Rosenzweig 1971 (*Science* 171); Arditi & Ginzburg 1989; Beddington 1975 /
DeAngelis et al. 1975; Roy & Chattopadhyay 2007 (*J. Biosci.* 32).

---

### 1.7 Scan reach: half-lengths were missing from the predator scans (`cell-kkl`, 2026-09)

`predatorSense` derived its radius from the threshold alone
(`r = ceil(PRED_SENSE / CELL_GRID)`) and the latch scan used a literal `1`. The
threshold is a capsule *gap* while `forEachNearby` walks buckets around the
sensor's *centre*, so both capsule half-lengths (up to `MAX_PREY_HALF =
MAX_RADIUS - WIDTH` for a full-energy green) were missing: prey inside the
threshold could fall outside the scanned cube. Fixed with `preyScanRadius()` in
`predator.js` — `scanRadius(threshold + halfLen(red) + MAX_PREY_HALF,
CELL_GRID)` — at both sites. `concentration` already did this (`cell-qjo.1`,
§3.2) and `eatAndRespawn` needs no half-length at all (`foodDist` is
point-to-capsule).

Measured (axis-aligned worst case for a per-axis scan: max-size sensor and prey
on one axis, sweeping the sensor's bucket phase over 11 values):

- `predatorSense` missed 4/11 phases at `PRED_SENSE` 1.0, 3/11 at 1.9, 4/11 at
  2.0, 3/11 at 3.9, 4/11 at 5.0 (worst at the top third of each unit interval).
  The default 1.5 was safe, but sat exactly on `r = 2`, so any raise crossed in.
- The latch missed 1/11 at `PRED_RANGE` 0.8, 2/11 at 0.9, 3/11 at 1.0, because
  `r` stayed 1 while the parameter tunes to 1.0. A missed latch only costs
  acquisition jitter (a red re-scans every substep and keeps its target).
- **At the shipped defaults nothing moves**: `r` is unchanged for `PRED_SENSE`
  1.5 and `PRED_RANGE` 0.18, and an 1800-step seeded run is bit-identical
  (checksum 1695095663, 62 cells: 47 green / 15 red) before and after. At
  `PRED_SENSE` 1.0 the trajectory does change (checksum 929812844 ->
  1890065205), which is the fix widening a scan that was clipping.
- Cost is bucket volume only, and only away from the defaults: x1.00 at
  `PRED_SENSE` 1.5 and `PRED_RANGE` 0.18, x4.63 at `PRED_SENSE` 1.0 and
  `PRED_RANGE` 0.8-1.0, x2.74 at 2.0, x1.65 at 5.0. Measured sense cost stays
  under 0.4 ms per pass at `PRED_SENSE` 5 (vs 0.24 ms before), and the sense
  passes run on `SENSE_PERIOD`, not per substep. Widening `r` at high
  `PRED_SENSE` is what §3.5's shell/diagonal-pruning ideas would offset.
- Guarded by `npm run test:tail` — *scan radius phase coverage* sweeps the phase
  for `concentration`, `predatorSense` and the latch at `RED_SIZE` 0.5 and 1 and
  fails if any target inside its threshold is missed (it failed on all the
  phases above before the fix).

---

### 1.8 Division release: sisters drive head-on and thrash (`cell-jyg`, 2026-09)

> **Status:** fixed structurally (`MITO_AWAY_TURN = 20`); `MITO_REST` default kept at 4.

The two daughters are born facing each other — deliberately, since each tail must
stream outward (§1.5A) — and are held 0.015–0.04 apart kinematic by
`placeMitoChild` for the whole `MITO_TIME`, collision-excluded, carrying an
inherited `vel = heading·0.3` pointed inward that `advance()` never damps (it
skips `mito || splitting` cells). `finalizeMito` then makes them collidable for
the first time and gives them `rest = MITO_REST` with `drive = 0`: they coast
~13 mm closer, end nose to nose (gap ~0.02, `headingRate ≈ 0`), and then, the
instant `rest` expires, thrust straight at each other. Overlap reaches 0.117 and
the response is the soft spring plus the heading kick
`deflectHeading(overlap·8)`: sustained contact at a **mean `headingRate` of
1.70 rad/s** (4.33 summed peak), and since `tailBend ← headingRate` that is the
visible thrash.

Separation is *not* the lever: nearly doubling `MITO_SEP` left the sibling
overlap rate at 38 % (vs 42 % at defaults) and made deep overlaps **more**
common — a longer run-up is a harder hit — and in isolation a bigger `MITO_SEP`
only delays first contact (4.08 → 4.22 → 4.40 s for `MITO_SEP` 2.275/3/4) at an
identical contact count. Zeroing the inherited velocity at release changes
nothing (DRAG 22 damps it within ~0.15 s): thrust causes the collision, not
momentum.

**Fix.** The exit is inherently a ~π turn — the pair is born facing each other
and has to end up aimed apart — so the lever that matters is the *rate*, not the
turning itself: at full authority (`MAX_SPIN`) the re-aim, and any collision
kick, hold the daughters at ~2 rad/s (≈115 °/s), which is the visible thrash and
whips the tail through `tailBend`. Three changes, all in the same window:

1. `finalizeMito` hands each daughter a `sibling` reference, and while `rest > 0`
   `advance()` steers her away from it (a direct `headingRate` term scaled by
   `MITO_AWAY_TURN`, so the pair turns apart before either can thrust head-on).
   It steers the heading *only*: overriding `steer` as well inflates `tailBend`
   (0.54 → 0.92 measured), because the tail's bend follows the steering command.
2. The `MITO_FORAGE` re-aim waits for the rest window to end
   (`forageT > 0 && rest <= 0`): two assists pulling different ways only jitter
   the daughter. (The gate is only sound together with (1) — with the away-turn
   off, gating the forage re-aim leaves the daughters with *no* re-aim during
   rest and they meet head-on: 29/30 overlap, 18 deep.)
3. `MITO_TURN_CAP` (rad/s) caps the daughter's heading rate for the whole exit
   window (`rest + forage`), which is what turns the exit into a smooth pivot.

Measured before/after — whole-run seeded, 600 s, each division tracked 8 s
post-release, baseline built from `aaeb609` (pre-fix) so the comparison is code
against code:

| | seed | sibling overlap | deep (self-caused) | contact substeps | daughter mean rate | daughter peak rate | substeps > 0.5 rad/s | daughter mean bend | turn in 8 s | daughters e+8 s |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 1 | 37/66 (56 %) | 18 (11) | 51 | 0.389 | 1.93 | 126/480 | 0.561 | 6.23 rad | 0.450 |
| baseline | 3 | 19/29 (66 %) | 13 (9) | 103 | 0.380 | 1.88 | 123/480 | 0.539 | 6.08 rad | 0.392 |
| **fixed** | 1 | **9/61 (15 %)** | **0 (0)** | **2** | 0.389 | **0.73** | **63/480** | 0.632 | 6.23 rad | 0.448 |
| **fixed** | 3 | **6/35 (17 %)** | **0 (0)** | **2** | 0.369 | **0.62** | **23/480** | 0.676 | 5.91 rad | 0.396 |

- Peak exit spin cut ~3× (1.9 → 0.6–0.7 rad/s) and the time spent above 0.5 rad/s
  by ~5×; deep self-caused clashes and near-continuous sibling contact are gone
  (9–11 → 0, 51–103 → 2 contact substeps), and the daughters feed exactly as
  before (0.448/0.396 vs 0.450/0.392).
- `MITO_TURN_CAP` sweep, seed 3: 0.7 → peak 0.76 / 302 hot substeps; 0.5 →
  0.59 / 20 (shipped); 0.35 → 0.50 / 8 with the lowest mean (0.275) and turn
  (4.41 rad) but one self-caused deep clash. 0 (no turn at all) returns the
  head-on case.
- Dead end, recorded so it is not retried: the *collision* kick is not the
  visible cause — scaling it 1 → 0.15 moved the daughter spin only
  0.380 → 0.366 rad/s while `tailBend` was unchanged, so it was dropped rather
  than shipped as a knob.
- Still open, smaller: mean tail-bend is a little above baseline (0.63–0.68 vs
  0.54–0.56) because the same turn is now spread over the whole window instead
  of spent in one fast spin; and a light crowd-induced brush between sisters
  remains in ~15 % of divisions (a third cell touching).
- Guarded by `npm run test:tail` — *division separation*: one isolated division
  must not overlap, must part, and neither sister may end up heading at the
  other.

---

### 1.9 Predators eating dividing prey, and the assembly-transfer model (`cell-ljb`, 2026-09)

> **Status:** partly implemented. `cell-08r.1` landed the assembly record
> (`sim.assemblies`, `updateAssemblies`/`assemblyRelease`, `d.asm` on all three
> members, the length/fill ledger and the collapsed predicates); `cell-08r.3`
> landed the exposed-mother gate (`MITO_VULNERABLE`, `MITO_VULN_FRAC`,
> `MITO_DRAIN_SCALE`, `assemblyDrain`, and the retention re-check). With the gate
> off the run is bit-identical (1800-step seed-1 checksum `1695095663`, unchanged
> across a mid-run `reset()`). `cell-08r.2` landed the aura channel (`MITO_AURA`,
> the `aAura` attribute, `max(aura, paralysed)` in render); `cell-08r.4` the
> ledger handover (driven shrink, inheritance `max(0, ENERGY_MAX/4 - taken/2)`,
> meal burst, `fade` retired). The envelope (`.5`) and the sweep (`.6`) are still
> open; the prototype lives on the
> local branch `experiment/mito-vulnerable`
> (`5a27f86`, reverted by `6a7493c`) — `main` was reset to `11f17e3`. §A and §B
> restore that prototype's measurements, which the reset dropped; §C–§I are the
> systematic version. Tasks: `cell-08r` (feature) with `.1`–`.6`, and `cell-ljb`
> (the prototype's narrowing variants, absorbed by §I/§H). §D is the normative
> formulation — one conserved scalar (length), one out-port, and the assembly as
> a single flow with a scheduled sink (the daughters) and an opportunistic one
> (a predator) — and it retires the either/or framings the earlier drafts of this
> section carried.

The question this section answers: can feeding and division be **one transfer**
with one aura and one shrink, instead of two unrelated code paths that happen to
share cells? Yes — provided growth and shrink are kept on separate channels (§D).

#### A. As shipped, a dividing green is untouchable — three times over

1. `validPrey()` excludes `mito`/`splitting`, so neither the mother nor the
   daughters can be sensed or latched for the whole `MITO_TIME` window.
2. `predation()` drops a latch whose target turns `splitting`.
3. **`buildCellGrid()` omits every non-parent `mito`/`splitting` cell**, so the
   daughters are absent from the index the predator scans
   (`forEachNearby(sim.cellGrid, …)`) quite apart from (1). That third gate is
   the load-bearing one and it is not obvious: the prototype's measured
   "daughters eaten: 0" is *structural, not ecological*. It also means the
   cheap-sounding variant "daughters only" is not cheap — it needs a change to
   the shared cell hash, which is the collision index too.

**The one index is the whole sensing surface**, and that decides what "the
assembly is available for sensing" means. `buildCellGrid` is the only index;
`predatorSense`, the latch scan, the green flee scan and the collision solve all
read it; `concentration`/`eatAndRespawn` use the food grid instead. Measured, with
a sensor parked 0.001 from each member of a fresh assembly:

| parked at | member in index? | prey the red's scan can find | reds a green's flee scan can find |
|---|---|---|---|
| mother | **yes** (`mitoParent`) | mother, but `validPrey` still refuses her | mother |
| back daughter | no | *(mother, if in range)* — never the daughter | *(mother, if in range)* — never the daughter |
| front daughter | no | *(mother, if in range)* — never the daughter | *(mother, if in range)* — never the daughter |

So: the assembly is reachable **only through its mother**, and only once a gate
is lifted; the two daughters are invisible to every scan in the game until
`finalizeMito` clears `splitting`. That cuts both ways — a red cannot eat them,
*and* a green cannot see a dividing red's daughters, which materialise as threats
the instant they are released. It also means the ledger's "the flow leaves the
mother and the daughters inherit what is left" (§D) is enforced by the index
rather than by a rule, so anyone who lifts this filter to make daughters edible
gets greens fleeing red daughters mid-division as a side effect. Note the index stores array *indices*, but every
scan consumer runs before the split phase's `splice`s, so no stale-index hazard
within a substep.

Measured on the protected baseline (probe: one red parked inside `PRED_RANGE` of
a dividing mother): mother's energy flat, 0 bites, 0 `predatorSense` passes, the
latch dropped the substep she turns `splitting`, and the red pushed off by the
immovable parent proxy (capsule gap 0.29 → 1.5 over 50 s). The only exposure is a
single substep — `predation` runs before `processSplits` — worth one ordinary
bite, 1.9e-4 energy.

#### B. What the full prototype measured (`MITO_VULNERABLE = 1`, local branch)

Both gates lifted, whole-run seeded, 1200 s:

| seed | flag | green range | red range | divisions | mothers eaten mid-window | daughters eaten | red substeps latched to a divider |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 31..90 | 10..47 | 193 | 0 | 0 | 0 |
| 1 | 1 | 17..54 | 11..58 | 159 | 14 | 0 | 42 879 |
| 2 | 0 | 25..157 | 7..34 | 242 | 0 | 0 | 0 |
| 2 | 1 | 15..59 | 12..48 | 139 | 3 | 0 | 39 032 |
| 3 | 0 | 7..50 | 6..23 | 62 | 0 | 0 | 0 |
| 3 | 1 | 8..50 | 9..40 | 101 | 6 | 0 | 42 992 |

- Mechanically safe: no NaN, no extinction, and a division survives its mother
  being eaten — daughters emerge ≈2 per division (314 from 159; 124 from 62; 196
  from 101). They run off the stored `startPos`/`headBack` and only ever write to
  the parent as a fading body.
- **The meal is free, not bigger.** `PRED_DRAIN` 0.02/s against a mother at
  `ENERGY_MAX` is ~50 s (≈61 s with the measured ratio factor) inside an 80 s
  window, so a red that arrives early gets the whole `ENERGY_MAX`. What the flag
  really buys is 80 s of `drive = 0` plus an immovable collision proxy: the
  predator latches and drains with no chase cost and cannot be shaken off.
  3–14 mothers per run died mid-division — and, as the table's own division
  counts show (159 divisions and 14 eaten mothers on seed 1 → 314 daughters), a
  mid-window kill costs the prey population **almost nothing**, because the
  mother is discarded at `finalizeMito` either way. The harm is the energy handed
  to the red, and the divisions that energy buys. Treat "mothers killed
  mid-window" as a *mechanism* counter, not the harm metric.
- **The prototype's own numbers are not directly comparable to a narrowed
  build.** Its `validPrey` accepts every live green, so `predation`'s ratio loop
  counts the daughters as prey for the whole window (they are in `sim.cells` but
  not in the latch grid), inflating `ratioAttack` and lifting reds over the
  `ratioAttack < 0.5` stop-hunting gate exactly in the scarce phase. §H requires
  the prototype arm to be re-run verbatim, or made reproducible from the knobs.
- **The pack, not the individual, eats the mother.** A single red's tank is
  exactly a mother's pool (`PRED_EFF = 1`), and filling it ends the episode: the
  red's `split` flips and `processSplits` calls `beginDetach` in the same
  substep, so a solo red always leaves her alive with the remainder. Measured
  relay: the satiated red detached, divided, and its two 0.25-energy daughters
  re-latched the same green within seconds and kept draining it. That is the
  mechanism behind the 3-14 kills per run below, and it is why the kill count is
  a *pack* statistic, not a per-predator one. Two reds may also latch one green
  at once (measured: 2.07 × `PRED_DRAIN`).
- **It chains.** `gainEnergy` clamps at `ENERGY_MAX` and flips `split`, so a red
  that finishes a divider is a full red that then divides.
- The ecology leans predator: red ceiling up on all three seeds, prey ceiling
  down on two of three. A real lever, and a strong one.

#### C. Why the division state is not systematic today

The phase record `d.mito` is attached to **one arbitrary member** (the back
daughter), `splitting` is set on all three, and `mitoParent` on the mother, so
every consumer has to consult up to three predicates it does not own. Full
inventory of the 27 references across six files (collapse each to `d.asm`,
`d.asm.parent === d`, or `d.asm !== null`):

| file | sites |
|---|---|
| `collision.js` | `buildCellGrid`'s filter; both skip checks in `solveCollisions`; both `invA = 0` inverse-mass branches; both `deflectHeading` proxy guards |
| `sim.js` | the `drive = 0` pin in `advance`; the death-burst suppression in the dead sweep |
| `cells.js` | the `createCell` initialiser; `updateEnergy`'s early return; the writes in `mitose`, `updateMito`, `finalizeMito` |
| `predator.js` | `validPrey`, `validPredator`, the latch drop in `predation` |
| `food.js` | `eatAndRespawn`, `concentration` |
| `scripts/tail-equivalence.mjs` | the "no tail slot" pool check (`mitoParent`) and the phase lookup (`d.mito`) |

`updateMito` is called per cell and no-ops for everyone but the one daughter that
holds the record. Three of these sites (`food.js:177`, `food.js:221`,
`cells.js:183`) test a **fourth** flag: they are `mito || splitting || split`.
`d.split` is a full-energy cell that has not divided *yet* — deliberately
food-blind and metabolism-exempt — so the collapse is
`d.asm !== null || d.split`, and dropping `d.split` would break task `.1`'s
bit-identical requirement.

Two consequences the spec has to fix rather than inherit:

- **The mother's energy is a dead field.** `updateEnergy` early-returns for
  `mito || splitting`, so her `energy` stays at the pre-division value for the
  whole window, is never rendered (only `fade` scales her matrix in
  `renderBodies`) and is discarded at `finalizeMito`. Probe: mother `E = 1.000`,
  `r = 0.3000`; daughters `E = 0.250`, `r = 0.1500` each; after finalize the
  mother is `dead` with `E` still `1.000`. That frozen `1.0` is precisely the
  budget a predator would eat, and it is already the right number.
- **Energy is affine in length, not linear**, so `2 × childLen = parent length`
  exactly (the silhouette is conserved by design) while
  `2 × E(childLen) = 0.5 × E(parent)`: half the mother's length is all of a
  daughter's energy. Meals therefore have very different sizes — mother 1.0,
  daughter 0.25 — and it is the fact the ledger's inheritance rule (§D) is built
  on.

Leftovers found while writing this: `tailTransfer` in `releaseTail` has no
writer (dead read), and DESIGN's tail-slot bullet still says `createCell`/
`makeCell` claim a tail slot (the claim is in `renderSync`).

#### D. The model: one flow, two sinks — and the ledger

The reason today's code needs three flags, a fade, an escape rule and a pop rule
is that it carries **two** notions of "how much cell there is" — a length and an
energy — and neither is conserved by the events it drives. Make one of them the
state and the other a pure read, and the special cases dissolve.

`mitose()` already builds the record; promote it to the assembly and give it one
owner and one pass:

```js
const asm = {
  parent, back, front,          // members, each with d.asm = asm
  t: 0, dur: P.MITO_TIME,       // phase clock
  L0: parent.radius * 2,        // the length being handed over (captured at mitose)
  h: 0,                         // handover curve 0..1 (today's fadeK / tailGrow)
  startPos, headBack, half,     // existing geometry
  aura: 0,                      // 0..1, broadcasts to d.aura on all members
  state: 'dividing',            // 'dividing' | 'released'
}
```

**The invariant.** One scalar per body — its **length** — with

`length = 2·MIN_RADIUS (floor) + fill`, `radius = length/2`, and the existing
affine read `energy = (radius − MIN_RADIUS)/(MAX_RADIUS − MIN_RADIUS) × ENERGY_MAX`.
Length is what every event conserves; fill is what a predator takes; the floor is
what it costs a body to exist. The ledger for the only division that can occur (a
mother at `ENERGY_MAX`, so `L0 = 2·MAX_RADIUS = 0.60`):

| term | length | fill |
|---|---|---|
| handover `h` | mother `−L0·h`, each daughter `+(L0/2)·h` — **total constant at every instant** | leaves the mother, arrives at the daughters |
| new floors | `+2·MIN_RADIUS` (each daughter's floor) | charged to the parent: `MIN/(MAX−MIN)` of `ENERGY_MAX` |
| feeding | prey `−taken`, predator `+taken` | conserved at `PRED_EFF = 1` |
| metabolism | — | destroyed |
| death | remainder → 0 | destroyed |

Checked against the shipped constants: mother `0.60 = 0.20 floor + 0.40 fill`;
each daughter `0.30 = 0.20 floor + 0.10 fill`; total length `0.60` — **exactly
conserved**; total floor `0.40` (one new floor created); total fill `0.20` (lost,
and equal to that floor). So **a division costs exactly
`MIN_RADIUS/(MAX_RADIUS−MIN_RADIUS)` = 50 % of the parent's energy**, paid into
structure — the model's one creation term, the same one a world-build cell spends
when it appears at `START_RADIUS`. Today that charge is real but unnamed and paid
in one lump at `finalizeMito` (mother `E` 1.0 discarded, daughters 0.25 each);
the ledger pays it *continuously* over the window, which is what turns the
crossfade into state instead of decoration.

- `sim.assemblies` + one `updateAssemblies(sim, dt)` pass replaces the per-cell
  `updateMito` loop, so the phase cannot advance twice and `finalizeMito` lives
  in one place. The `Simulation` constructor and `reset()` own the array — a
  stale assembly would otherwise keep advancing and releasing pre-reset cells.
- **Lifetime.** `d.asm` is set on all three members at `mitose` and cleared on
  every member at `assemblyRelease`. That makes `d.asm !== null` exactly today's
  in-window predicate (`mito || splitting`), so the pin, the food-blindness and
  the metabolism exemption collapse without changing state — and a *released*
  daughter does not keep a pointer that would freeze her for life. The guards
  that also test `d.split` (a full cell that has not divided yet, deliberately
  food-blind and metabolism-exempt) keep it: `d.asm !== null || d.split`.
  `renderSync` reads no mitosis predicate at all (`noTail`/`tailHeir` are
  render-owned).
  As implemented in `cell-08r.1`, only the released *daughters* drop `asm` at
  release. The dead mother keeps hers through the same substep, because the dead
  sweep reads `isAssemblyParent` to suppress her death burst (a division replaces
  her, it does not kill her) and she is spliced out immediately after.
- **One mutation point.** There is no separate pool field: the budget is
  `parent.energy`, the field `drainEnergy`/`setSize` already maintain.
  `assemblyDrain(sim, asm, amount) -> taken` returns the energy actually removed,
  and the predator's gain follows `taken`, not the requested amount —
  `taken <= 0` drops the latch, otherwise `gainEnergy(red, taken × PRED_EFF)` —
  with `taken` itself capped by the taker's room (see the satiation row below).
  Without the follow-`taken` rule a husk at `energy = 0`, or a second red latched
  to the same mother (which §1.1 permits), creates energy from an empty pool, the
  one thing §1.2D forbids.

**Grow and shrink are one flow with two sinks, not two animations.** The
mother's length has a single out-port; the daughters are its scheduled sink and
any predator is an opportunistic one. So "should the assembly grow and shrink?"
has no answer to choose: at handover `h` the mother is `L0(1−h)`, each daughter
`(L0/2)h`, and a bite merely diverts part of the out-flow. Everything else is a
read of that state:

| question | read |
|---|---|
| who shrinks | whoever the flow is leaving |
| what the daughters inherit | `(L0 − taken)/2` each — taking **half** the mother's energy (0.20 of her 0.60 length) leaves them exactly at their floor |
| is a divider "killed" | no: the daughters emerge smaller and starve later if they are under their floor — **delayed, not deleted**, with no kill event to special-case |
| who is sensable | the unit's **envelope** (the union of its members) — one index entry, which is what §A's `mitoParent` exemption already approximates |
| where the budget lives | `parent.energy`; there is no separate pool field to drift |
| what the aura marks | a transfer in flight for this unit |
| when the release happens | `h → 1`, or the source empties — there is no escape switch to set |
| satiation | `taken = min(rate, room)`: a transfer that cannot be banked is not a transfer, so the latch drops and the measured `beginDetach` path takes over |

Render consequence, and it is a real one: the daughters are now **born at their
floor and grow to `L0/2`** as the handover proceeds, instead of being placed at
full child length from `t = 0` with only their tails growing. Their radius, mass
and tail pitch all follow, and the mother's *length* (not a display scale) is
what shrinks. Keep the existing gotcha: **do not multiply a radius ratio
(`length/L0`) into the instance matrix** — the bucket template already carries
the radius, so that would scale every cell a second time (≈⅔ at
`E = 0.5`, ≈⅓ at `E = 0`) while its collision capsule stayed full size.

**The eater's tank caps the bite — and a solo red cannot finish a mother.**
`gainEnergy` clips at `ENERGY_MAX` and flips `split`, and `processSplits` then
sees a full feeding red (`breed === 1 && target.paralysed`) and calls
`beginDetach`: the red releases, coasts `MITO_DETACH` and divides. Measured on a
red with 0.1 of room: it fills at t = 5.433 s with `split`, `detach` and
`target = null` all set in the *same substep*, is clear 0.8 s later, and the
energy it banked in the filling substep is exactly its room (waste ≈ 0). That is
the ledger's `taken = min(rate, room)` in the wild: a latch episode ends at
*saturation*, not at the prey's death.

A mother's pool is exactly one red tank, so no single red that arrives with any
energy can empty her — but the pack assembles itself: measured, the satiated red
released, divided, and its two 0.25-energy daughters re-latched the *same* green
and kept draining it (the green kept falling after the release, 0.87 → 0.79).
That is how the prototype's 3-14 kills per run arise (≈50 s of latched time per
kill at `PRED_DRAIN` 0.02/s). Multiple reds may also latch one assembly at once —
nothing in `predation` enforces exclusivity, and measured two reds on one green
drain `0.0415/s = 2.07 × PRED_DRAIN`. So the drain criterion is
`Σ_over latchers min(E_bite_per_red, room) ≥ taken_needed`, and the ledger turns
`taken_needed` into a *daughter-survival* threshold rather than a kill: `taken`
above half her pool dooms both daughters.

**Derived, not chosen.** An earlier draft of this section made "who shrinks" a
three-way choice (A mother-only / B pool-proportional / C whole-assembly fatal),
plus an escape switch and a consumed-husk exemption. The ledger retires all
three, and with them the accident where a lens of "the assembly" was really a
choice about *which body the flow leaves*. The two things it does **not** decide
are policy, and they stay open in §I: whether several reds may gang up on one
unit, and whether a satiated red may hold the latch and burn the excess (surplus
killing) rather than release.

**When.** `updateAssemblies` writes `parent.mitoExposed = asm.t / asm.dur >=
MITO_VULN_FRAC`, and it must gate **both** the acquisition scan (`validPrey`)
and the *retained* latch, because the retained latch is the dominant measured
path: a green above `MITO_SLOW_FRAC` has `drive` ramped to zero, so it is the
easiest target in the world, and the red is already in contact when it turns
`splitting`. Gated on acquisition only, the predicate leaves the whole 80 s
window open for exactly the reds that cause §B's 39 000-43 000 substeps. So the
retention check becomes: drop the target when it is dead, or when it is in an
assembly that is not yet exposed (and always, when `MITO_VULNERABLE = 0`).

**The gate must open before the parent fades.** `fade` reaches exactly 0 at
`MITO_HOLD + MITO_FADE` = 0.6 of the window, so the natural-looking default
`MITO_VULN_FRAC = 0.6` exposes a body that is already invisible: the shrink is
unobservable, and the aura has nothing to sit on. `MITO_HOLD` (0.2) is the
latest sensible gate — it is also where the parent's own silhouette stops
reading as "one cell about to divide".

**The proxy is the unit's envelope.** The indexed body should be the *union* of
the members' capsules, not the mother's own — which is exactly what `mitoParent`
approximates today by holding a full-length immovable proxy (`invA = 0`) in
`sim.cellGrid` while her own body fades. Under the ledger that union is readable
at any instant, so the proxy follows it: it never disappears mid-window (which is
what happens now when the mother is spliced out — `buildCellGrid` drops her and
the red sails through the daughters' space), and it needs no "consumed husk" flag,
because the mother's length reaching zero is simply the flow having left her. The
union also keeps §A's sensing invariant exact: one entry while the members
overlap, and the daughters enter the index on their own when they separate.

**The release is the flow ending**, not a switch. `assemblyRelease` fires when
`h → 1` or the source empties, so `MITO_ESCAPE` is not a parameter to set — a
short-circuited handover *is* the same event. The daughters always emerge (the
"2 per division" invariant §B measured holds regardless) and what varies is their
inheritance, `(L0 − taken)/2`.

#### E. Visual contract

- **Aura** reuses the existing fresnel rim: `bodyMat`'s `instanceParalysed` hook
  already mixes `vec3(0.89, 0.18, 0.11)` at the rim. Widen it to a float,
  `aAura` (0..1), so the marker can ramp rather than snap. **The ordinary latched
  prey must not regress**: `renderBodies` writes `aAura = max(d.aura, d.paralysed
  ? 1 : 0)`, so a latched non-dividing green still glows exactly as it does
  today. The assembly broadcasts its ramp to every member (`d.aura = asm.aura`),
  because "the whole assembly is being eaten" is the read. Do not reuse
  `d.paralysed` itself for the assembly: `predation` clears it for every cell at
  the top of each substep and `updateAssemblies` runs afterwards, so the marker
  would depend on substep ordering. `paralysed` keeps its physics meaning (drive
  pin, collision exclusion of the latched pair).
- **Shrink** needs no render change and no `fade`: the handover writes each
  member's *length* (mother `L0(1−h)`, daughters `(L0/2)h`), `radius`/`mass` and
  the tail pitch follow, and `renderSync` rehomes the body bucket. The
  instance-matrix scale stays 1 for the assembly (see §D: multiplying a radius
  ratio in as well double-counts it). `fade` becomes redundant for the mother —
  her length already carries the shrink — so drop it rather than stacking a
  second display term on top of the state.
- **Burst** marks a body whose length reached its floor and which is then
  removed: the mother when a drain empties her (the meal feedback, which does
  not exist today — her ordinary exit at `finalizeMito` is a replacement, not a
  death, and stays silent), and any daughter that emerges under its floor (the
  ordinary zero-energy death path already covers those). So the sweep's
  `mitoParent` suppression stays as it is, and there is no second flag on the
  cell.
- Optional, if the rim reads too small at zoom: reuse the `glow.js` billboard
  (its shader already aligns the ellipse with the capsule) with `aAlpha` driven
  by the drain rate; ≤3 instances, no new pipeline.

#### F. Change list

| file | change |
|---|---|
| `cells.js` (`createCell`, `mitose`, `updateMito`, `finalizeMito`) | `asm` record with `L0`/`h`; `d.asm` on all three members and the clearing rule; `sim.assemblies` (constructor + `reset`); `updateAssemblies`; the handover writes each member's length; `assemblyDrain`/`assemblyRelease`; `parent.mitoExposed`; keep `|| d.split` in `updateEnergy`'s early return |
| `sim.js` (`advance`, dead sweep) | one assembly pass; pin via `d.asm`; the burst rule of §E |
| `predator.js` (`validPrey`, `predation`) | mother-only edibility, gating **acquisition and retention**, behind `MITO_VULNERABLE` + `mitoExposed`; `MITO_DRAIN_SCALE` on the bite; `taken = min(rate, room)`; gain bounded by `taken`; exclude the emptied unit from the ratio numerator |
| `collision.js` (`buildCellGrid`, `solveCollisions`) | the predicate rewrite of §C (7 references), and the proxy sized to the **unit's envelope** rather than the mother's body. The `buildCellGrid` *filter semantics* stay as they are for the default cut: daughters keep their exemption, and it remains the real gate if they are ever made edible — split the grid or accept the collision behaviour |
| `bodyPool.js`, `materials.js` | `aAura` float replaces the boolean upload, written as `max(d.aura, d.paralysed)`; the rim hook reads the float; no matrix-scale change (`fade` retired for the mother) |
| `App.vue` / HUD counts, `predation` ratio | an emptied unit is not a live prey even while its envelope is still indexed |
| `constants.js`, `docs/DESIGN.md` | the four knobs of §G, and the generated param table (`node scripts/gen-params-table.mjs --write`; `npm run build` fails on a stale table) |

#### G. Knobs (all under the Mitosis group)

| key | def | purpose |
|---|---|---|
| `MITO_VULNERABLE` | 0 | master gate (the name the prototype branch already uses); `0` must stay bit-identical |
| `MITO_VULN_FRAC` | 0.2 | phase fraction at which the unit becomes exposed. Default it at `MITO_HOLD`: the handover curve retires the mother's body by `MITO_HOLD + MITO_FADE` = 0.6, so a later gate exposes a mother who has already handed over her length — nothing to see, nothing to take |
| `MITO_DRAIN_SCALE` | 0.5 | bite multiplier while the target is a unit. This is the narrowing lever: the gate alone cannot narrow much |
| `MITO_AURA` | 1 | cosmetic gate on the aura channel |

**The two narrowings multiply, so only one may be spent.** What one red can take
from a division is

`E_bite = PRED_DRAIN × ratioAttack × MITO_DRAIN_SCALE × MITO_TIME × (1 − MITO_VULN_FRAC)`

capped by its tank (§D), and shared with every other red on the same unit. The
ledger turns the outcome into a **daughter-survival** threshold rather than a
kill: the daughters inherit `(L0 − taken)/2` each, so `taken` above **half** the
mother's pool (0.5 of `ENERGY_MAX`, i.e. 0.20 of her 0.60 length) leaves them at
or under their floor and they are dead on arrival — delayed death, not a deletion.
At `PRED_RATIO 0.75` and a 50:15 standing population, `ratioAttack = 0.816`:

| profile | `MITO_VULN_FRAC` | `MITO_DRAIN_SCALE` | `E_bite` per red | outcome |
|---|---|---|---|---|
| prototype (§B, verbatim gates) | 0 | 1.0 | 1.31 | far past the threshold; relays finish units |
| strong | 0.2 | 1.0 | 1.05 | an early arrival alone dooms the daughters |
| **partial (default here)** | 0.2 | 0.5 | 0.52 | one red that holds the window just crosses 0.5 — the daughters are born at their floor |
| both levers at once | 0.6 | 0.25 | 0.13 | a nibble: the daughters keep most of their inheritance |

`cell-ljb` listed the gate and the drain as *alternatives*; adopting both at
0.6/0.25 multiplies them into a no-op, which is why the earlier draft's defaults
were incoherent. The default ships the **partial** row, and the strong row is a
documented parameter set rather than the shipped default. `ratioAttack` is the
free variable: it falls toward the `ratioAttack < 0.5` stop-hunting gate exactly
when prey are scarce, so every row weakens in the phase where the effect matters
most.

Put together, the unit's loss over one window is
`taken = Σ_over latchers min(E_bite, ENERGY_MAX − E_red_at_arrival)` — one red
cannot empty a mother alone, because she is exactly one tank, so the reachable
outcomes are a **pair** of hungry reds on one unit (nothing in `predation`
enforces exclusivity) or a **relay**: a satiated red detaches, divides, and its
two 0.25-energy daughters re-latch. Whether the pack may gang up on one unit, and
whether a satiated red may hold the latch to burn the excess, are §I.4.

#### H. Verification

- `npm run test:tail` — its mitosis assertions (division separation, and the pool
  check `cell i has no tail slot` which keys off `mitoParent`) must stay green,
  and must still pass with an early release.
- `npm run test:headless` — the boundary it enforces is the *import graph*:
  `d.aura` is physics state, only `aAura` is render.
- Seeded whole-run checksum probe (§1.7 method): the §F refactor alone must be
  bit-identical, and `MITO_VULNERABLE = 0` must stay bit-identical after the
  whole feature lands.
- Probe suite (throwaway script, per-case parameter overrides):
  1. **acquired after the gate** — a red parked inside `PRED_RANGE` of a
     divider: 0 latch substeps before `mitoExposed`, latch held after.
  2. **retained across the split** — a red latched *before* the division begins:
     with the gate closed it must let go, with the gate open it keeps the latch.
     This is the dominant path and the case the first probe cannot see.
  3. **the handover ledger** — through an undisturbed division, at every substep,
     `mother.length + back.length + front.length = L0` to within float error, the
     fill destroyed equals the floor created, and at release each daughter is at
     `L0/2` (`E` 0.25). With `MITO_DRAIN_SCALE` forced to 1.0 the same identity
     holds with `taken` subtracted and the daughters emerge at `(L0 − taken)/2`.
  4. **satiety and the relay** — a red with 0.1 of room: it fills, `split`,
     `detach` and `target = null` land in the same substep, the bite it banks
     equals its room and never more, it is clear after `MITO_DETACH`, and its two
     daughters re-latch the *same* unit (the relay). Separately: two hungry reds
     latch one mother and drain at ≈2 × `PRED_DRAIN`.
  5. **the inheritance threshold** — a drain past half the pool leaves the
     daughters at or under their floor: they release on schedule and die through
     the ordinary zero-energy path (two bursts), never by being deleted; a drain
     under half leaves them alive and thinner. This replaces the old
     consumption/escape cases — there is no kill event to test.
  6. **the envelope** — the unit stays in `buildCellGrid` as one union-sized
     entry for the whole window (a third cell is still deflected by it after the
     mother's own length has reached 0), and the daughters enter the index only
     at release.
  7. no NaN anywhere; tail-slot handover intact when the handover short-circuits.
- Acceptance: **≥5 seeds × ≥3600 s** whole-run seeded, baseline vs narrowed, with
  **paired same-seed deltas and medians, not min/max ranges** (a cycle is a few
  hundred seconds, so a 1200 s run is ~4 periods and its ranges are cycle phase).
  Log the causal quantities, not only the outcome: energy delivered per assembly
  meal, **latchers per assembly, per-episode arrival energy and the room it left
  (the tank cap), the relay count (a red dividing off an assembly and its
  daughters re-latching it)**, red divisions within one window of a meal, latch
  *events* as well as substeps, and the concurrent `ratioAttack`. Without the
  tank and team columns a kill-count change cannot be attributed to the gate, the
  drain scale, or the number of reds that happened to be nearby.
  Thresholds must be falsifiable: "narrowed must cut
  energy delivered per meal and latch events by ≥50 % against the prototype arm,
  with the red-ceiling median within the baseline's interquartile range and no
  NaN or extinction" — and, because the harm now lands as inheritance, also
  **the daughters' released-energy distribution** (median and lower quartile,
  with the fraction under their floor counted separately): a change that looks
  small in the ceilings but moves that distribution has moved the lever.
- The **prototype arm must be reproduced verbatim** from the branch, or made
  reproducible from the knobs. The branch's `validPrey` returns true for every
  live green, and `predation`'s ratio loop iterates `sim.cells`, so the prototype
  counts the *daughters* as prey for the whole window (≈3 per division, ~13
  concurrent assemblies on seed 1) while the narrowed build counts only the
  exposed mother: part of any ceiling difference would be a ratio-response
  change, not a gating change.
- `cell-ljb` is the disposition record for this section: its variant 1 is §I.2,
  variant 2 is `MITO_VULN_FRAC`, variant 3 is `MITO_DRAIN_SCALE`, and its
  acceptance sweep is absorbed by task `cell-08r.6`.

#### I. Open decisions

1. **Settled by the ledger**: the length invariant, the single out-port, the
   daughters' inheritance `(L0 − taken)/2`, the unit-envelope proxy and the
   release rule. This retires the old A/B/C choice, `MITO_ESCAPE` and the
   consumed-husk exemption, which are kept above only as the earlier draft's
   options.
2. **Settled and shipped in `cell-08r.4`**: the daughters grow continuously
   through the window (born at their floor, energy 0 -> `MIN_RADIUS`) instead of
   being placed at their full child length at `t = 0`, and the mother's `fade` is
   retired — her length carries the shrink. The §B measurements were taken
   against the old crossfade, so the prototype arm must be re-run (§H) before any
   comparison.
3. Do the daughters ever become edible — i.e. do we lift the shared
   `buildCellGrid` filter? Out of scope for the default cut (they are invisible
   to the latch scan today), and the measured answer to "what happens if we do"
   does not exist yet.
4. Satiety and ganging up. The tank already caps one red's intake, so the live
   levers are: **may several reds latch one unit at once** (§B's prototype
   allowed it — nothing in `predation` enforces exclusivity, and a pair drains at
   2.07 × `PRED_DRAIN`), and **may a satiated red hold the latch past
   `ENERGY_MAX`** to take more than it can bank? The second is surplus killing:
   it needs an explicit "don't `beginDetach` while draining a unit" rule, and the
   excess is destroyed rather than banked — a third ledger term that would have
   to be named.
5. The parent task's priority: `cell-08r` is P3 to match `cell-ljb`, but this
   moves the balance the way `cell-k2g` (P2) and `cell-dmd` (P1) did. Raise it if
   the work should outrank them.

---

## 2. Cell–cell collision

> **Status:** exploration (`cell-dy6`, `cell-b0t`). **No Tier-1 change was
> shipped** — the bound tightening measured neutral and was reverted.

Scope: `src/collision.js`, `src/constants.js`, `src/cells.js`. All collision code
is plain JS on the CPU; there is no physics engine.

### 2.1 Current algorithm

A cell is a capsule of axial half-length `radius` and cross-section radius
`width`; the collision core-segment half-length is `radius − width`
(`makeBodyGeo` builds `CapsuleGeometry(width, 2·(length−width))`). `mass =
max(radius²·0.25, 0.05)`; reds scale length+width by `RED_SIZE`. `mitoParent`
marks the faded dividing parent kept as an **immovable collision proxy**.

- `buildCellGrid()` clears and re-inserts every `advance`, skipping
  `(mito || splitting) && !mitoParent`, storing the array index. The same grid is
  reused by `forEachNearbyCell`, `predatorSense` (`r=2`), and `predation` (`r=1`).
- `solveCollisions(simDt)` runs a **single-sweep Gauss–Seidel soft spring**:
  27-bucket scan with a bounding-sphere early-out
  (`bound = ra + rb + wa + wb`), then `capsuleDist` (Ericson closest-points
  between two segments, returns `dist` + normal `_col`, no allocation), then
  skip unless `dist < wa + wb`.
- Response per contact: inverse masses (`mitoParent` → 0), spring velocity
  update `(overlap·SPRING)/invSum` scaled by `simDt`, heading kick
  `deflectHeading` (skips `paralysed`, caps at `0.4·COLLISION_KICK`), positional
  correction, and a per-pair `setLength(SURFACE)` re-projection.
- `j <= i` dedups unordered pairs; grid stores global indices, and
  `cells.splice` runs after `solveCollisions`.
- Complexity `O(n + candidates)`, candidates grow ~quadratically in surface
  density at fixed `CELL_GRID`. At `simRate = 50` the whole pass (and grid
  rebuild) runs ~50×/frame — the main scaling wall.

### 2.2 Correctness and rough edges

Correct: true capsule–capsule distance (avoids phantom contacts), conservative
center early-out, pair dedup, immovable `mitoParent` proxy, consistent normal
sign, correct `contact = width sum`.

Rough edges: the center bound is loose (`ra+rb+wa+wb`; the tight valid bound is
`ra+rb`) but tightening measured neutral; the response is rate-based, not
projected (overlap is never resolved in one step); per-pair sphere re-projection
repeats `sqrt`; single order-dependent sweep; grid is not rebuilt after mid-loop
moves; coincident centers yield a zero normal; `deflectHeading` saturates.

Allocations: `buildCellGrid` allocates bucket arrays every substep (reusing them
measured **slower**, so `clear()` is kept); `capsuleDist` and
`deflectHeading → signedAngleTo` are allocation-free via `_col`/scratch vectors.

### 2.3 Options (ranked)

**Tier 1 — trivial, behavior-preserving.** Hoist `setLength(SURFACE)` out of the
pair loop; tighten the bound to `ra + rb`; de-allocate `signedAngleTo` (already
fixed); incremental grid key (n/a — cells move); skip `deflectHeading` for tiny
overlaps (negligible). **Measured (`cell-b0t`):** the bound tightening was
bit-identical in a seeded fingerprint and cut `capsuleDist` calls, but `collide`
stayed within noise at n≈78 (0.100 vs 0.100 ms/step) and was reverted. The
expected 2–3× does not hold for Tier-1.

**Tier 2 — moderate effort.**

- Dense typed-array grid instead of `Map` (16³ `Int32Array` head + next-link
  list): 2–5× broadphase at n=500; also update `predator.js`.
- Tune `CELL_GRID` (with the tight bound `CELL_GRID ≈ 0.7` cuts candidate volume
  ~2×; caveat: `predatorSense` uses `ceil(PRED_SENSE/CELL_GRID)`, so a smaller
  grid enlarges its scan — retune).
- Squared-distance gate before the full capsule solve (1.5–3× narrowphase).
- Adaptive sphere approximation for near-parallel headings (~5× cheaper,
  slightly different feel).
- Persistent neighbor lists / temporal coherence (5–10× broadphase if rebuilt
  every K substeps; complex with births/deaths/mitosis).
- Sweep-and-prune on one axis; may not beat a tuned hash on a shell.

**Tier 3 — bigger tradeoffs.** Decouple collision cadence from substeps (~2× at
high `simRate`, softer contacts); impulse-only vs position-only PBD; merge cell
and food grids (marginal); Morton/Z-order layout (marginal); cap neighbors or
index-window limits (**misses collisions — not recommended**); sleep far cells
(breaks the global ecology); coarse repulsion field (loses hard non-overlap and
orientation); physics engine / GPU compute (heavy at n≤500, hard to
headless-test).

**Radical rethinks.** (A) SPH-style density-field soft repulsion: `O(n+grid)`,
loses exact non-overlap and capsule orientation; best past n≈1000. (B) GPU
spatial hash + compute narrowphase: thousands of cells, needs WebGPU + readback,
very high effort. (C) Analytic no-overlap PBD projection: guaranteed non-overlap,
GPU-friendly, loses the soft squashy feel.

### 2.4 Recommended next steps

1. No Tier-1 tweak was worth shipping (`cell-b0t`).
2. Re-measure with `sim.perf` (`collide` bucket) at n=100/500 and `simRate=1/50`.
3. If broadphase dominates, prototype the dense typed-array grid.
4. Consider `CELL_GRID ≈ 0.7` only after checking the predator scan tradeoff.

---

## 3. Food sensing

> **Status:** exploration. Tier-1 items 1–3 shipped as `cell-qjo.1`–`.3`;
> clump-attractor prototype evaluated under `cell-qjo.5`.

Scope: `src/food.js`, `src/grid.js`, `src/constants.js`, `src/sim.js`,
`src/predator.js`.

### 3.1 Structure

- Food uses a **`Map` spatial hash** keyed by an integer `gridKey`
  (`src/grid.js`: base-`SPAN = 4096`, `OFFSET = 2048` bias for negatives; fast
  Number key, no string GC). It is built **once**
  (`buildWorld → buildFoodGrid`) and mutated **incrementally** on eat/respawn, so
  membership always matches `food.visible`. Bucket size `GRID = 0.35`.
- The **cell grid** is separate (`CELL_GRID = 1.0`) and rebuilt every substep,
  because cells move.
- `forEachNearby(grid, cx, cy, cz, r, cb)` walks a solid cube of `(2r+1)³`
  buckets and honours an early-out no caller uses. `scanRadius(reach, bucket) =
  1 + floor(reach/bucket)` guarantees coverage for a point anywhere in the
  center bucket.
- `concentration()` derives `r = scanRadius(sense + halfLen + FOOD_RADIUS_MAX,
  GRID)` (default `r = 2`); `eatAndRespawn` uses `r = 1`; `predatorSense` uses
  `ceil(PRED_SENSE / CELL_GRID)`. `sense = width + SENSE_BOOST`.
- `foodDist` returns the raw offset, so `foodDir` grows with distance;
  `signedAngleTo` projects it into the tangent plane for steering, but `foodPeak`
  mixes distance with coherence.

### 3.2 Cost

Per green cell, `concentration` is `O(buckets)` `Map.get` + `O(candidates)`
`foodDist`. At `FOOD_COUNT = 3000` on area ~322, occupancy is ~1 visible
food/bucket, so the `r = 2` cube visits 125 buckets and ~10² candidates, skewed
by clumping (85% in ~12 clumps). `SENSE_PERIOD = 0.05` is ~3 substeps ≈ 20
passes/sim-second, multiplied ~linearly by `simRate` (≈1000 passes/s at 50×).
The hot path is allocation-free.

**`SENSE_BOOST` saturation bug (fixed).** `r = 2` guaranteed coverage only to
`3·GRID ≈ 1.05` (worst case 0.70); the default requirement
(`sense + halfLen + maxFoodR ≈ 0.46`) fit, but the slider became a no-op above
roughly `SENSE_BOOST ≈ 0.5–0.6` (`SENSE_BOOST` ranges 0–2). Deriving `r` from
`sense` removed the clip without changing defaults (verified bit-exact).

### 3.3 Shipped Tier-1 (`cell-qjo.1`–`.3`)

1. Right-size the concentration radius from `sense` (bug fix, no default win).
2. Squared-distance early reject in `foodDist` (exact via triangle inequality).
3. Swap-remove in `removeFoodFromGrid` (backfill with last entry + `pop`, plus a
   dev stale-`gridKey` warning; bucket order changes, semantically irrelevant).

Measured after 1–3 (65 cells / 3000 food): `sense` −35% (0.191 → 0.124 ms),
`eat` −52% (0.134 → 0.065 ms).

### 3.4 Clump attractors rejected (`cell-qjo.5`)

Prototyped behind `SENSE_MODE = 1` (sense each clump centre, weight
`1 − dist/reach`, `reach = sense + theta·SURFACE`). The `sense` bucket is **4×
cheaper** (0.125 → 0.030 ms at ~50–65 cells), but chemotaxis collapses: mean
cosine between `foodDir` and the direction to the nearest visible food falls from
**0.64 to −0.10**, and greens over-graze (seeded 90s: green 46 → 64). A clump
centre is a poor stand-in for the local spec field, especially inside a clump.
**Keep the per-spec scan; do not default clump sensing.** `SENSE_MODE` stays 0.

### 3.5 Remaining options

- **Coarsen / stagger sensing** (open): raise `SENSE_PERIOD` (0.05 → 0.15) and/or
  round-robin cells; up to ~3× with light smoothing. Also consider
  `senseAccum -= SENSE_PERIOD` instead of `= 0` (currently quantizes the period
  to substep-dt multiples; low priority at the default `simRate`).
- **Coarse density/potential field:** splat a kernel on eat/respawn, sample
  density + gradient with bilinear interpolation; `O(N)` independent of
  `FOOD_COUNT`. Only worth it above the current `FOOD_COUNT`.
- Monte-Carlo subsampling (cap candidates K≈12–24, ~2.5×, noisy); cone/vision
  sensing (~50–70% fewer candidates, more biological); scatter/batched sensing
  (`O(food)`); 2D shell grid (the 3D cube's interior is empty, ~2–4× traversal);
  GPU density texture (overkill at 3000, hard to headless-test).

---

## 4. Tail

> **Status:** current. The tail is a **damped spring chain** whose `O(1)` control
> runs every sim step and whose `O(S²)` pose integrates only while tails are
> drawn. Rendering epic `cell-5tt`: **`.1`–`.5` shipped**. An experimental
> **kinematic mode** (`TAIL_MODE`, `cell-h2o`) swaps the chain for a
> force-rotated rigid root plus positional follow. See `DESIGN.md` for the
> generated tail parameter table.

### 4.1 Model

`sim.advance` splits the tail into two passes:

- **`updateTailControl`** — `O(1)`, runs for **every** cell on **every** step,
  even while tails are hidden. It re-aims `tailCarrier` toward behind-heading at
  `TAIL_CARRIER_RATE`; advances `tailPhase += dt·TAIL_OSC_FREQ` when
  `drive > 0.02` or `|headingRate| > 0.05`; integrates `tailLag` from
  `steer + headingRate` (decaying at `TAIL_TRAIL_RATE`); and sets
  `tailBend = clamp(TAIL_RUDDER_GAIN·tailLag, ±TAIL_ARC_MAX)`. This is the
  physical actuator the body reads.
- **`updateTailPose`** — `O(S²·TAIL_DYN_SUB)`, runs only while tails are visible.
  It builds the analytic guide spine `q[j]` from the root at the body rear
  (`TAIL_HINGE` tuck): each step is the carrier rotated by
  `TAIL_MOTOR_AMP·whip·sin(tailPhase − TAIL_WAVE·j) − TAIL_ARC·bend·j·ramp`,
  `whip = max(drive, |bend|·1.5)`, then integrates `tailPts`/`tailVel` toward `q`
  over `TAIL_DYN_SUB` substeps.

The body consumes only `tailBend`, in the movement block:

```js
d.headingRate += TAIL_TURN * (d.tailBend || 0) * dt
```

```text
updateTailControl(sim, d, dt):        # always, even while hidden
  n0     = normalize(d.pos)
  behind = tangent-project(-d.heading, n0)
  pitch  = TAIL_BODY * 2 * d.radius / S * d.tailGrow
  tailCarrier -> behind          at TAIL_CARRIER_RATE
  if drive > 0.02 or |headingRate| > 0.05:
      tailPhase += dt * TAIL_OSC_FREQ
  tailLag += (steer + headingRate) * dt;  tailLag -= TAIL_TRAIL_RATE * tailLag
  tailBend = clamp(TAIL_RUDDER_GAIN * tailLag, ±TAIL_ARC_MAX)

updateTailPose(sim, d, dt):           # only while tails are visible
  build guide spine q[0..S] from root (wave + trailing arc)
  repeat TAIL_DYN_SUB times:
      gather guide + length + beam forces -> acc[j]
      add self-avoidance contacts         -> acc[]
      integrate v[j] then p[j]            # damp, tangent-project, clamp VMAX
  for i in 0..S: tailDirs[i] = normalize(pts[i+1] - pts[i])
```

Each pose substep runs three passes — gather accelerations, add self-avoidance
contacts, then integrate — so pair forces act symmetrically. Forces: **guide
spring** toward `q[j]` (stiff `TAIL_MOTOR_K` at the root motor joints
`j <= TAIL_MOTOR_JOINTS`, weak `TAIL_DRAG_K` elsewhere); **length springs** to
`j±1` at `pitch` (`TAIL_LEN_K`, damped by `TAIL_LEN_DAMP`); **local beam**
`TAIL_BEND_K·(pₗ + pᵣ − 2pⱼ)` resisting curvature; **self-avoidance** for
non-adjacent joints closer than `TAIL_CONTACT_D` (`TAIL_CONTACT_K`). Integration
is `v = (v + a·h)·e^(−TAIL_DAMP·h)` with `h = dt/TAIL_DYN_SUB`, projected to the
tangent plane and clamped to `VMAX = 40`; positions are re-projected to
`SURFACE`. The loop is allocation-free (per-cell arrays + shared `sim._vN`
scratch; self-avoidance normals come from a module-level `_norm` array, fixing
the old `sim._v1` aliasing bug, `cell-bjm`).

### 4.2 Data structures

**Per-cell CPU chain** (`S = TAIL_SEGMENTS = 9` joints, `S+1 = 10` points):

| Field | Type | Pass | Role |
|---|---|---|---|
| `tailPts` | `Vector3[]` | pose | joint positions; `[0]` = root at body rear |
| `tailVel` | `Vector3[]` | pose | joint velocities, tangent to the sphere |
| `tailVT` | `Vector3[]` | pose | per-substep acceleration accumulator |
| `tailQ` | `Vector3[]` | pose | analytic guide targets `q[j]` |
| `tailDirs` | `Vector3[]` | pose | unit segment tangents (render input) |
| `tailCarrier` | `Vector3` | control | drag axis / orientation memory |
| `tailPhase` | number | control | traveling-wave phase (rad) |
| `tailLag` | number | control | turn-lag memory |
| `tailBend` | number | control | clamped arc bend — the only field the body reads |
| `tailGrow` | number | shared | 0..1 tail-length scale |

Control fields survive a hidden-tail step; pose fields are frozen while hidden
and re-aimed by `warmTail`. The arrays are allocated once at birth and mutated in
place — `updateTailPose` allocates nothing per step.

**GPU representation** (`sim.tailChunks`): `tailGeo` is a capless cylinder
(radius 0.014, 6 radial segments, local X = segment direction); `tailMat` is
`MeshLambertMaterial`. Each segment is one instance but there is **no
`instanceMatrix`**: a chunk carries four compact `InstancedBufferAttribute`s
(`aSegPos`, `aSegX`, `aSegY`, `aSegScale`), and the vertex shader builds the
transform (`z = x × y`) — 11 floats/segment instead of 16. A chunk is
`{ mesh, live, owners, attrs, attrList }` with
`TAIL_CHUNK_SIZE = TAIL_CHUNK_CELLS · S = 576`, `frustumCulled = false`,
`DynamicDrawUsage`, and a per-chunk geometry clone. Cell slots are packed
`0..live-1` (`claimTailSlot`/`freeTailSlot` swap-remove), so
`mesh.count = live·S`; `owners[slot]` maps back to the cell. `placeTail` writes
the attributes and adds per-slot update ranges; one `needsUpdate` per attribute
per dirty chunk per frame.

### 4.3 Decoupling invariant

Only `tailBend` feeds motion, and `tailPts`/`tailDirs`/`tailPhase` are cosmetic,
so **toggling the tail display must not change `pos`/`vel`/`heading`/
`headingRate`**. Structurally: `advance` always runs `updateTailControl` (which
alone sets `tailBend`); only `updateTailPose` and `renderTails` are gated on
`tailsHidden`. Guarded by `npm run test:tail`
(`scripts/tail-equivalence.mjs`), which checks identical seeded state checksums
for tails on/off, that `warmTail` never touches `tailLag`/`tailBend`/`tailPhase`,
that `tailPhase` advances by `dt·TAIL_OSC_FREQ` only while driving, that joints
stay on the surface, and that the pose stays finite after a long run.
`updateTailState` remains a thin `control + pose` wrapper for tests. The harness
needs two discarded warm-up runs because lazily created module-level THREE
geometry/pool UUIDs consume `Math.random` and shift the seeded stream.

The one-substep feedback lag (the body consumes the previous substep's
`tailBend`) is deliberate; removing it ("Stage B") changes loop gain and was
dropped.

### 4.4 What steers vs what is cosmetic

- **The traveling wave is cosmetic.** It shapes `q[j] → tailPts`, read only by
  `placeTail`; it never touches motion and costs no energy.
- **The arc (`bend`) is the actuator.** A symmetric sine has ~zero mean lateral
  impulse; the `−TAIL_ARC·bend·j` mean-curvature term produces yaw via
  `TAIL_TURN·tailBend`.
- A whip can only turn the body if it is time-asymmetric. This sim computes no
  reaction from tail momentum, so a whip has no mechanical path to the body
  today. Options: (1) pulse / C-start whip deriving body torque from
  `Σ m·v·lever` (most physical, most work); (2) traveling bend envelope
  (cheap, mostly visual); (3) asymmetric wave with a net-curvature/DC term.
- Phase advances in the sim step, so wave frequency scales with `simRate`
  automatically — the old render-time `TAIL_WAVE_MAX_HZ` Nyquist cap is gone.

### 4.5 Kinematic mode (`TAIL_MODE = 1`, `cell-h2o`)

Replaces the `O(S²)` spring chain in `updateTailPose` with a positional model.
The guide spine `q[j]` is still built exactly as above; root paddle joints
`j = 1..TAIL_MOTOR_JOINTS` are force-rotated straight onto `q[j]` with velocities
zeroed; each remaining joint follows the segment ahead with a first-order
direction lag
`dir_j ← normalize(lerp(dir_j, dir_{j−1}, 1 − e^{−TAIL_FOLLOW_RATE·dt}))`,
placed at `pts[j−1] + dir_j·pitch` and re-projected to `SURFACE`.
`TAIL_FOLLOW_RATE` sets the response: high = rigid rod, low = floppy, laggy.
There is no self-avoidance, so a very low rate can fold the tail. The mode is
**pose-only** and ~3× cheaper; `test:tail` verifies both modes produce identical
motion checksums.

### 4.6 Cost

- **Sim:** control is `O(1)` per cell per step and always runs; chain integration
  is `O(S²·TAIL_DYN_SUB)` and is paid only while visible (the hidden case costs
  just the control pass).
- **Render:** `renderTails` clears each chunk's update ranges, calls `placeTail`
  per cell, and issues one `needsUpdate` per attribute per dirty chunk per frame.
  `placeTail` writes 9 segments/cell straight into typed arrays (no matrix build,
  no cross product) and adds update ranges when `sim.renderer` is set. Only
  `live·S` instances are submitted per chunk; zeroed far-side and reserved slots
  are excluded from `count`. At ~65 cells → 2 chunks → 585 instances submitted
  (was 1152, ~half degenerate). CPU is still `O(cells·S)`; true `O(cells)` needs
  a GPU chain.

`cell-5tt` shipping history: `.1` chunk-local packed slots with exact
`mesh.count` + swap-remove compaction; `.2` per-slot partial uploads (one
`needsUpdate` per chunk per frame); `.3` direct basis build + sphere-normal up
vector; `.4` capless-cylinder `MeshLambertMaterial` segment; `.5` per-segment
transform moved to the vertex shader via four compact instanced attributes.

### 4.7 Alternative designs considered

Analytic traveling-wave ribbon (the model the restore replaced — cheap and
deterministic, loses emergent drag/whip); position-history trail (zero dynamics,
speed-dependent length); bone/IK tail (O(1)–O(3), trivial LOD, keeps the
`tailBend` actuator); GPU population chain (highest ceiling, hard to
headless-test).

### 4.8 History and open follow-ups

- The chain was briefly replaced by an analytic pose + one lag filter (epic
  `cell-asu`) and **restored** because the chain looks better (emergent drag lag,
  whip, self-avoidance). The physical coupling (`tailBend → headingRate`) never
  changed. Restoring the chain also brought back the sim-step phase advance.
- **GPU spring chain (`cell-igf`) closed, won't do.** Headless measurement showed
  the tail pose (`0.27` ms spring / `0.16` ms kinematic at 77 cells) and
  `renderTails` (`~0.05` ms) are negligible against the 16.7 ms frame budget;
  reopen only with a browser frame profile showing the tail as the top cost.
- Kinematic vs spring-chain (`cell-owg`) is the open decision — compare in the
  Tuner and keep, retune (`TAIL_FOLLOW_RATE`) or drop `TAIL_MODE`.
- Optional momentum-driven "C-start" whip (§4.4).

---

## 5. Alternating turn/move gait

> **Status:** prototype shipped (`cell-d4z`, 2026-09), **default on**
> (`GAIT_MODE = 1`; flipped from 0 by request). Full 1800s x 5-seed sweep done
> (`cell-aj9`): all configs bounded, no extinction, no NaN. Run-and-tumble added
> (`cell-mml`, default off). Harnesses: `scripts/gait-experiment.mjs`,
> `scripts/gait-sweep.sh`.

This is the untested *windowed pivot* variant left open in §1.5D (`cell-1eo`):
instead of steering and thrusting continuously, a cell alternates a **TURN**
phase (low forward drive, boosted steer -> a tight pivot) with a **MOVE** phase
whose forward speed is set by a **forward mode**.

### 5.1 Model (`src/gait.js`)

- **Phase.** `d.gait` is `MOVE` or `TURN`; `d.gaitT` times the phase.
  `MOVE -> TURN` when the steering demand `|d.steer|` reaches `GAIT_TURN_ON`, or
  after `GAIT_MOVE_TIME` if there is still demand. `TURN -> MOVE` when demand
  falls to `GAIT_TURN_OFF`, or after the `GAIT_TURN_TIME` cap. `|steer|` (already
  clamped to `[-1, 1]`) is the turn-demand proxy; a cell with no target never
  leaves `MOVE` unless the tumble timer is on.
- **Tumble (opt-in).** `GAIT_TUMBLE > 0` makes a target-less cell
  (`demand <= GAIT_TURN_OFF`) enter a *forced* `TURN` after `GAIT_TUMBLE`
  seconds, with a random turn direction (`GAIT_TUMBLE_STEER` magnitude) held for
  the full `GAIT_TURN_TIME`. A chemotactic turn still ends early on-target; a
  forced tumble does not. This is run-and-tumble: a cell tracking nothing
  re-randomises its heading instead of running straight (`cell-mml`).
- **Mode.** In `MOVE`, `d.gaitMode` is picked from cell state: food contact
  (`d.slow <= GAIT_EAT_SLOW`) -> **eat**; else energy fraction above
  `GAIT_DRIFT_FRAC` -> **drift**; else **general**. `TURN` always uses the turn
  multipliers.
- **Writes.** `TURN`: `drive *= GAIT_TURN_DRIVE`, `steer *= GAIT_TURN_STEER`.
  `MOVE`: general/drift scale `steer` by `GAIT_MOVE_STEER` (go straighter);
  drift also scales `drive` by `GAIT_DRIFT_DRIVE`; eat scales `drive` by
  `GAIT_EAT_DRIVE` (stacks on the existing graze `d.slow`). Only `drive` and
  `steer` change, so the tail control (`tailBend -> headingRate`) is untouched
  and the sim/view split still holds.
- **Gates.** Off outside `paralysed/rest/detach` and while latched onto a
  paralysed prey; `GAIT_PREY` / `GAIT_PRED` select which breed uses it.
- `GAIT_MODE = 0` returns immediately: the shipped locomotion is byte-identical
  (`test:headless` also runs a gait-on 600-step physical check).

The mode multipliers are deliberately ordinary: the point of the prototype is
that the *alternation* is now explicit and tunable, not that these defaults are
right.

### 5.2 Full sweep (`scripts/gait-sweep.sh`, 1800s, seeds 1-5)

One process per config, five seeds each; `cross` = total red-green curve
crossings over the five runs; `turn%` = mean cell-time in `TURN`; `bDrive` /
`rDrive` / `rSpeed` are per-cell means. No run had a NaN; `ex` is the number of
seeds with an extinction.

| config | ex | cross | green | red | births | bDrive | rDrive | rSpeed | turn% b/r |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 0 | 6 | 18..193 | 4..125 | 583 | .053 | .115 | .189 | 0 / 0 |
| gait (default) | 0 | 13 | 8..91 | 5..51 | 360 | .037 | .084 | .152 | 19 / 28 |
| prey-only | 0 | 17 | 19..156 | 7..90 | **635** | .036 | .109 | .194 | 20 / 0 |
| pred-only | 0 | 4 | 12..100 | 2..44 | 370 | .051 | .083 | .156 | 0 / 26 |
| `TURN_DRIVE 0.35` | 0 | 10 | 16..220 | 4..96 | 532 | .044 | .085 | .158 | 19 / 35 |
| `TURN_DRIVE 0.5` | 0 | **29** | 17..293 | 3..179 | **746** | .049 | .087 | .170 | 21 / 36 |
| `MOVE_TIME 1.2` | 0 | 10 | 13..138 | 3..61 | 443 | .040 | .079 | .159 | 18 / 28 |
| `DRIFT_FRAC 1` (no drift) | 0 | 16 | 9..217 | 2..140 | 536 | .041 | .086 | .166 | 21 / 31 |
| `TUMBLE 2` | 0 | 8 | 12..182 | 4..88 | 463 | .040 | .073 | .160 | 24 / 32 |

An earlier 1200s seeds-1-2 pass plus 2400s seeds-1-3 runs showed the same
picture, and caught the one fragile corner: `MOVE_TIME 1.5` with weak move
steering (`STEER 0.25`) nearly crashed seed 1 (green 6..50). The shipped script
keeps the milder `MOVE_TIME 1.2`.

### 5.3 Reading and decision (`cell-aj9`)

- **Safe.** Every config survived 1800s on all five seeds and stayed bounded and
  finite, so the prototype is safe to keep exposed in the Tuner.
- **The gait amplifies the cycle.** Baseline already oscillates (6 crossings);
  the pivot/demand gate roughly doubles-to-quintuples that (default 13, prey-only
  17, `TURN_DRIVE 0.5` 29). This is the intended direction — a more pronounced
  but still bounded red-green cycle, not a collapse.
- **Most configs cost prey productivity.** Default gait and pred-only cut births
  to ~360-370 (prey `drive` down), while `TURN_DRIVE 0.5` and prey-only keep or
  raise births (746 / 635) because they pivot without throttling prey as much.
- **Predator-only is the mildest change** (4 crossings, like baseline): pivoting
  reds alone does little; the added cycle comes from the prey gait / interaction.
- **`TURN_DRIVE 0.5` is the standout knob** — highest births and amplitude
  (green 293 / red 179) with 29 crossings: a lively, bounded cycle. `DRIFT_FRAC 1`
  vs default is within noise, so "drift hurts reds" is not confirmed at this
  sample size.
- **Decision at the time (`cell-aj9`): keep `GAIT_MODE = 0` default.** No config dominates baseline on
  every criterion, and five seeds is too few to flip a shipped default. If a
  stronger cycle is wanted, start from `GAIT_TURN_DRIVE = 0.5` (prey-only if
  productivity matters), then re-run the sweep with more seeds.

### 5.4 Run-and-tumble and open follow-ups (`cell-mml`)

Run-and-tumble is implemented (`GAIT_TUMBLE`, `GAIT_TUMBLE_STEER`; default off).
In the sweep its row (8 crossings, births 463, turn 24/32, lowest red speed
.073) raises turn duty as designed but is not a clear win, so it stays default
off. Remaining:

- The sweep is still seed-limited (5); confirm `TURN_DRIVE 0.5`'s amplitude
  before adopting, and check its cycle period with the RateChart autocorrelation.
- `eat` mode is currently just a multiplier on the existing graze slowdown
  (`GRAZE_RATE` already near zero); giving it a small forward creep would make
  "slow eating" move while feeding, and needs its own A/B.
- The "windowed pivot" now has a positive result (§1.5D): gating the throttle to
  strong steering demand tightens turns without the permanent-throttle collapse.

---

## 6. Render bug post-mortem

Two rendering bugs, both resolved by auditing the render path numerically rather
than tweaking materials. Only the conclusions that carry forward are kept.

### 6.1 "Cell goes black / body vanishes, tail remains"

A far-side cell lost its body but kept its tail: far-side culling only hid
`cos ≤ −0.06`, while the opaque shell eclipses bodies in a wider limb band
(~`cos ∈ [−0.06, 0.2)`). `polygonOffset` couldn't help — those bodies are
genuinely behind the shell. A second artifact was an opaque **emissive nucleus**
`InstancedMesh` that glowed irrespective of lighting; it was removed and
re-adding it was reverted.

**Fix:** **never cull bodies** (the opaque shell depth-occludes them naturally)
and **cull tails at the horizon** (`sideHidden = cosFace <= 0`; `placeTail`
clears a hidden cell's tail, `renderBodies` ignores `sideHidden`).

### 6.2 "Bodies blink on scroll-zoom" (`cell-6uj`)

Pooled `InstancedMesh`es were `frustumCulled` against a `boundingSphere` cached
on first render. A body pool born with one cell froze its sphere at ~one capsule
radius, so zooming in dropped whole buckets at random. The wide default framing
hid it.

**Fix:** `frustumCulled = false` on every shell-spanning pool — `createBodyChunk`
and `ensureTailChunk` (`src/cells.js`), `foodMesh` (`src/sim.js`), and each tail
chunk.

### 6.3 Lessons

- Two independent culling layers exist: cell-level `sideHidden` (per-cell,
  recomputed each frame) and mesh-level `frustumCulled` (three.js, per pool,
  one-shot cached sphere). A pool spanning more space than its sphere **must**
  set `frustumCulled = false`.
- With an opaque occluder, cull conservatively (hide only the far side) and let
  the shell do real occlusion; a clever "behind the shell" test over-hides the rim
  because the near cap sticks out.
- A separate emissive mesh is lighting-independent and must stay in sync.
- Re-test under the narrowest view (zoom all the way in) before declaring a
  render bug fixed; don't trust comments over behavior (`grep frustumCulled src/`).
- Code pointers: `src/render.js` `renderView`, `src/math.js` `cosFace`,
  `src/cells.js` `renderBodies`/`placeTail`/chunk pools, `src/sceneSetup.js`
  shell + lighting, `src/constants.js` `CULL_COS`.

---

## Appendix — experiment method

Balance/exploration harnesses used Vite `ssrLoadModule('/src/sim.js')`, seeded
`mulberry32` `Math.random`, and `new Simulation(); buildWorld(); step(1/60)` with
no WebGL. Parameters were overridden via `setParam` after `resetParams()`. A
discarded warm-up run preceded each sweep so lazy geometry/pool PRNG draws
wouldn't skew the first set. Candidates were scored on: no extinction over
≥1800s, bounded amplitude, red lagging green, and no NaN. Temporary scripts were
removed after each pass; `scripts/tail-equivalence.mjs` shows the reproducible
seeded-run pattern. The gait harnesses (`scripts/gait-experiment.mjs` and
`scripts/gait-sweep.sh`/`gait-sweep.mjs`, §5) are kept as plain-Node variants of
the same method: they override `P` directly, disable pose, run one process per
config in parallel, and report population ranges, crossings, births and
locomotion stats.
