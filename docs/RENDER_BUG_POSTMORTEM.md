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

- `src/render.js` — `renderView(sim, tailScale)` owns the draw path and reads a
  `renderOptions` object (`drawShell / drawFood / drawTails / drawBodies /
  cull / bodyDepthWrite / forceOpaqueBodies`), so each layer can be turned on/off
  to bisect. `sim.render()` just delegates to it; the old `updateVisibility`
  moved here.
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

- **Cull by actual occlusion** (`src/render.js updateVisibility`): hide a cell
  (body **and** tail together) whenever the ray to it passes through the shell —
  `bodyShellGap(...) > 0` — falling back to `cosFace <= CULL_COS`. This makes
  body and tail appear/vanquish **together** at the limb. Post-fix the audit
  reports `not-hidden-but-occluded = 0` at every elevation; the only regions
  newly hidden are the self-occluded limb ring (not the front face).
- **Remove the nucleus** (`materials.js` `nucleusGeo/nucleusMat`, `cells.js`
  `renderNuclei`, `sim.js` buildWorld/reset/dispose/render): cells are now plain
  translucent capsules; no separate emissive core to leak. (Lighting was also
  softened at the same time so capsule shadow sides never clip near-black.)
- **Verify**: `npm run build` + headless `auditShell` + a mitosis smoke test.

## How to reason about similar render bugs here

- Opaque objects (tail, shell, food) and transparent objects (bodies) are sorted
  in **separate passes**; a transparent body can be eclipsed by an opaque object
  in front of it, and you can't fix that with a material tweak.
- Culling must reflect **actual occlusion**, not just a normal-dot heuristic,
  when the occluder (the sphere) is opaque and the culled thing (a body) sits
  just outside it.
- A separate **emissive** mesh is lighting-independent — if you see a shape that
  never changes brightness, it's emissive, and it must be kept in sync with
  whatever it's supposed to be "inside".
- When visual bugs resist material/setting fixes, **stop tweaking and make the
  decision logic pure + headless-testable**, then audit it with numbers. Bisect
  layers with `sim.renderOptions`.

## Code pointers

- `src/render.js` — pipeline, `renderOptions`, occlusion culling, `bodyShellGap`,
  `auditShell`.
- `src/math.js` — `cosFace`, `raySphereNear`.
- `src/cells.js` — `renderBodies` (per-cell shrink scale via `d.fade`),
  `placeTail` (clears tail when `sideHidden`), mitosis parent shrink
  (`pd.fade = 1 - fadeK`), daughter tail handoff (`back` grows, `front` inherits).
- `src/sceneSetup.js` — camera framing + viewer-constant lighting (hemisphere fill).
- `src/constants.js` — `CULL_COS`, `SPHERE_RADIUS`, `SURFACE`, `WIDTH`.
