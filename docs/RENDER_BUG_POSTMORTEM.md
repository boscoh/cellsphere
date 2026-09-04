# Render bug post-mortem — "cells go black / body vanishes leaving only a tail"

**Status:** resolved (2026-09-04). This was the longest-running, most-frustrating
bug of the session. It turned out to be **two compounding rendering defects**,
and the second one only became clear after we stopped guessing and refactored
the render path into something we could audit numerically.

## Symptoms (as reported, in order)

1. A bacterium's capsule body intermittently rendered **black/dark**, with a
   bright pale-green capsule visible inside it ("the nucleus").
2. After several mitigation attempts, the remaining report: **rotate the camera
   up → bacteria moving to the top of the screen lose their body, leaving only
   their tail** — an isolated glowing capsule / a tail with no body.
3. The isolated bright capsule was *uniformly* bright regardless of orientation
   (an **emissive** material) — the key clue that it was a separate emissive
   draw, not a shaded body.

## The render path as it stood

- **Bodies**: pooled `InstancedMesh`s, one per length bucket, all sharing one
  `bodyMat` (`transparent:true`, opacity 0.9, `depthWrite` default true). A
  custom `onBeforeCompile` multiplies `diffuseColor.a` by a per-instance
  `instanceOpacity` attribute (used by the mitosis fade) and discards fragments
  below a small alpha threshold.
- **Tails**: one `InstancedMesh` of capsule segments, **opaque** (`tailMat`).
- **Nucleus** (a re-added feature): a separate **opaque, emissive** `InstancedMesh`
  indexed by the cell index. Mitosis gives the **front daughter the parent's
  index** (`createCell(sim, d.index, ...)`), so mother and front daughter write
  the *same* nucleus instance slot.
- **Shell**: an opaque `FrontSide` sphere (`sphereShell`), radius `SPHERE_RADIUS`;
  cells sit at `SURFACE = SPHERE_RADIUS + 0.06`.
- Culling: `updateVisibility` sets `sideHidden` from a dot threshold,
  `cosFace(pos, camDir) <= CULL_COS` (`CULL_COS = -0.06`).

## How we actually hunted it (the method that worked)

Blind tweaks (opacity, discard threshold, DoubleSide, lighting, polygonOffset)
each "moved" the artifact but never fixed it, because we were reasoning about
composite rendering order without being able to see the GPU output. What worked
was to **extract the decision logic into pure, headless-testable functions and
audit them numerically**, plus push the render path into an explicit,
toggleable pipeline:

- `src/render.js` — `renderView(sim, tailScale)` owns the draw path and used to
  read a `renderOptions` object (`drawShell / drawFood / drawTails / drawBodies /
  cull / bodyDepthWrite / forceOpaqueBodies`) so each layer could be flipped on/off
  to bisect. `sim.render()` just delegates to it; the old `updateVisibility`
  moved here. **These toggles were diagnostic scaffolding and have since been
  removed** — `renderView` now draws the full intended pipeline, with far-side
  tail occlusion always on.
- `src/math.js` — pure `cosFace(pos, camDir)` and `raySphereNear(origin, dir, r)`.
- `src/render.js` — `bodyShellGap(pos, camPos, shellRadius, bodyRadius)`: signed
  distance from a cell's near surface to the shell's front surface along the
  camera ray (`>0` ⇒ shell in front of the body); plus a headless `auditShell`.

## Hypotheses tested — and ruled out (with evidence)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Back-face / winding flip on some instance | **rejected** | Headless probe over a long sim incl. divisions: `0` negative scales, `0` non-finite quats, `0` negative-determinant matrices. `compose` from a quaternion always yields det>0, and far-side cells are culled, so a true back face isn't even viewable. |
| Body↔nucleus mismatch (body missing, nucleus drawn) | **rejected** | Scanned 4000 frames with divisions + starvation: `0` frames where a cell's body-bucket mesh was null / slot out of range / `fade≈0` while a nucleus would draw. |
| Transparent body z-fighting the shell near the limb | **confirmed** as the chronic cause | `bodyShellGap` audit: at every camera elevation there's a **limb band** (`cos` roughly `[-0.06, 0.2)`) the dot-cull `CULL_COS=-0.06` does **not** cull, where the opaque shell front sits ~1–3 units in front of the body. So the body is eclipsed but the cell isn't culled → its **opaque tail still draws** → "tail with no body". `polygonOffset` couldn't help because those bodies are genuinely behind the shell, not z-fighting. |
| Emissive nucleus rendering on its own | **confirmed** as the second artifact | The nucleus is a separate **opaque emissive** mesh indexed by cell index; mitosis shares the parent's index with the front daughter. Being emissive, it always glows regardless of lighting/body opacity, so whenever the body was eclipsed or the shared slot resolved to the young daughter, it read as an isolated glowing capsule. |

## Root causes

1. **Chronic / dominant — shell-occlusion culling gap.** The far-face culling
   threshold hid only `cos <= -0.06`, but the opaque shell eclipses bodies in a
   wider limb band right up to the silhouette. Cells there got their **body
   hidden by the sphere** while their (opaque) tail kept drawing → the "body
   disappears, tail remains" seen on rotate-up.
2. **Second artifact — the nucleus.** A separate opaque emissive instanced mesh,
   awkward to track per-cell because mitosis reuses the parent index for the
   front daughter; it escaped/drew alone and made the composite look like a
   black shell exposing a glowing core.

## Fixes

- **Don't cull bodies; cull tails at the horizon** (`src/render.js` +
  `src/cells.js`): bodies are never culled — a near-facing body is in front of
  the opaque shell (visible), a far-side body is *behind* the shell and depth-
  occluded naturally. So the body is always correct with no culling. The artifact
  is a far-side **tail poking past the shell's silhouette** while its own body is
  occluded. Fix: `sideHidden` (now `cosFace <= 0`, i.e. the horizon, via
  `CULL_COS = 0`) clears only the **tail** (`placeTail`); `renderBodies` ignores
  it.
  > Derived from the toggles: cull-off hid nothing about the body (bodies were
  > fine) but the tails still poked; the offending culls (cos threshold
  > `-0.06`, or a ray-through-shell test) hid *bodies* unnecessarily. Bodies
  > don't need culling at all.
- **Remove the nucleus** (`materials.js` `nucleusGeo/nucleusMat`, `cells.js`
  `renderNuclei`, `sim.js` buildWorld/reset/dispose/render): cells are now plain
  translucent capsules; no separate emissive core to leak. (Lighting was also
  softened at the same time so capsule shadow sides never clip near-black.)
  A later attempt to restore the nucleus with a per-cell slot + occlusion gating
  was reverted at the user's request — the visual bug was the cull, not the
  nucleus.
- **Verify**: `npm run build` + a headless mitosis smoke test.

## How to reason about similar render bugs here

- Opaque objects (tail, shell, food) and transparent objects (bodies) are sorted
  in **separate passes**; a transparent body can be eclipsed by an opaque object
  in front of it, and you can't fix that with a material tweak.
- When the occluder (the shell) is opaque and the culled thing (a body) sits
  just outside it, **cull conservatively** — hide only the far side and let the
  opaque shell do the real occlusion. A clever "is it behind the shell" test
  over-hides the rim because the body's near cap sticks out.
- A separate **emissive** mesh is lighting-independent — if you see a shape that
  never changes brightness, it's emissive, and it must be kept in sync with
  whatever it's supposed to be "inside".
- When visual bugs resist material/setting fixes, **stop tweaking and expose the
  layers as live toggles** (`sim.renderOptions`, wired to keys) and bisect by
  eye. Verify the hypothesis with a **real-world toggle** (e.g. `c` cull-off),
  not just a numeric audit that reuses the same assumption you're testing. These
  toggles were temporary — once the bugs were root-caused and fixed they were
  removed; don't ship them for production.

---

# Post-mortem #2 — "bodies disappear and reappear at random when I scroll-zoom" (2026-09-04)

**Status:** resolved (2026-09-04), beads `cell-6uj`. This one was invisible to the
first investigation because it only shows up under a *narrow* view cone — the far
framing hid it completely.

## Symptom

Scrolling to zoom made individual capsule bodies vanish and return **at random** —
a different subset each time. Orbiting alone was fine; the trigger was specifically
the camera narrowing/widening (scroll zoom).

## Root cause: pooled `InstancedMesh` frustum culling against a stale, localised sphere

The render layer's *cell-level* logic said "bodies are never culled"
(`render.js` `cull` comment), but that only governed `sideHidden`. The **mesh-level
`frustumCulled` flag was never touched** (`grep frustumCulled src/` → nothing), so
three.js culled every pooled `InstancedMesh` by default against a single bounding
sphere:

- Body pools (`cells.js` `getPool`), `tailMesh`, and `foodMesh` are all pools whose
  instances are spread across the whole shell (radius ~5).
- three.js caches `boundingSphere` on **first render**. A body pool is born with one
  cell, so its sphere is frozen at **~one capsule radius (probe: r ≈ 0.10–0.30),
  positioned at that first cell** — it is localised, never covers the shell, and is
  **never recomputed** (thin `cells.js` reference to `computeBoundingSphere`).
- In the default framing (camera ~14 away, 55° FOV) the frustum is so wide it still
  contains that sphere → nothing is culled, so a normal view looks fine.
- **Scroll-zoom in** narrows the view cone. Any bucket whose frozen sphere falls
  outside the cone has its **entire instance set** dropped that frame, then drawn
  again as soon as the sphere re-enters → bodies blink on/off. Which buckets are
  affected depends on where each sphere happens to be vs. where you zoomed — hence
  "random".

## How it was proven

Headless audit (no GL): built the sim, seeded each pool's bounding sphere the
moment its mesh was born (exactly three.js's lazy cache), kept it stale, then swept
a camera between far (`dist ≈ 18`) and close (`dist ≈ 2.3`) while orbiting, and
counted cells that were on-screen in the camera frustum yet belonged to a mesh that
`intersectsObject` rejected:

```
far-view     worst spurious culls: 0
zoom-in      worst spurious culls: 14   <- whole visible bodies dropped
```

A single bucket frozen at one cell (r=0.2) vs. a cell that later joined on the
other side of the shell is the minimal repro: with a close camera pointed at the new
cell, the stale sphere is out of the cone so the bucket is culled even though the
cell is dead-centre.

## Fix

Disable frustum culling on the pooled instanced meshes — they always span the
shell, `frustumCulled` buys nothing, and their spheres are never accurate:

- `src/cells.js` `getPool` — `entry.mesh.frustumCulled = false`
- `src/sim.js` `buildWorld` — `tailMesh.frustumCulled = false`, `foodMesh.frustumCulled = false`

Re-run of the same audit after the fix: `0` spurious culls at both far and close
zoom. `npm run build` passes.

## Takeaways (add to the reasoning list above)

- There are **two culling layers**: the cell-level `sideHidden` (correct, per-cell,
  recomputed every frame) and the **mesh-level `frustumCulled`** (three.js, per
  each pool, against a stale cached sphere). A pool of instances that spans more
  space than its one-shot bounding sphere *must* have `frustumCulled = false`.
- A wide default framing can hide a culling bug entirely — always re-test under the
  narrowest view the user can reach (zoom all the way in) before calling a render
  bug fixed.
- Don't trust comments that say "bodies are never culled"; the comment documents
  *intent* while the default flag still did the opposite. `grep frustumCulled src/`.

## Code pointers

- `src/render.js` — `renderView(sim, tailScale)` is the whole draw path now:
  sets tail scale/visibility, far-side tail occlusion (`updateVisibility` →
  `sideHidden`), draws bodies + tails, updates controls and renders. No
  `renderOptions` object, `bodyShellGap`/`auditShell`, or layer toggles remain —
  they were diagnostic scaffolding for these bugs and were removed on cleanup.
- `src/math.js` — `cosFace` (used by occlusion culling).
- `src/cells.js` — `renderBodies` (per-cell shrink scale via `d.fade`),
  `placeTail` (clears tail when `sideHidden`), mitosis parent shrink
  (`pd.fade = 1 - fadeK`), daughter tail handoff (`back` grows, `front` inherits).
- `src/sceneSetup.js` — camera framing + viewer-constant lighting (hemisphere fill).
- `src/constants.js` — `CULL_COS`, `SPHERE_RADIUS`, `SURFACE`, `WIDTH`.
