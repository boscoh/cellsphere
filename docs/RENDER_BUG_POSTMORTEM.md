# Render bug post-mortem

Two rendering bugs plagued the session. Both were invisible to material tweaks
and only got root-caused by **auditing the render path numerically instead of
guessing** at opacity/lighting/culling. Both are resolved.

**TL;DR**

1. **"Body vanishes, tail remains"** — the opaque shell eclipsed bodies in a band
   wider than the far-side cull threshold, so far-side cells were occluded but
   their *tails* still drew. Fix: **never cull bodies** (let the opaque shell
   occlude them naturally) and **cull tails at the horizon**.
2. **"Bodies blink on scroll-zoom"** — pooled `InstancedMesh`es were
   `frustumCulled` against a stale, localised bounding sphere frozen at first
   render, so zooming dropped whole buckets at random. Fix: **`frustumCulled =
   false`** on every shell-spanning pool.

The long investigation trail (hypotheses tested, per-frame audits) is trimmed
below; only the conclusions and reasoning that carry forward are kept.

---

## Post-mortem #1 — "cell goes black / body vanishes, tail remains"

**Status:** resolved (2026-09-04).

### Symptom (as reported)

- A body intermittently rendered **black/dark**, with a bright capsule "inside" it.
- Later, narrow: **rotate the camera up → a far-side cell loses its body**, leaving
  an isolated glowing capsule / a tail with no body.
- The isolated capsule was **uniformly bright regardless of orientation** — the clue
  that it was an **emissive** draw, not a shaded body.

### Why guessing failed

Opacity, discard-threshold, `DoubleSide`, lighting, and `polygonOffset` each
*moved* the artifact but never fixed it, because we were reasoning about composite
render order without seeing GPU output. The method that worked was to **extract the
decision logic into pure, headless-testable functions** (`cosFace`,
`raySphereNear`, `bodyShellGap` + an `auditShell`) and audit them numerically, and
to expose render layers as **live toggles** to bisect by eye. Those toggles were
diagnostic scaffolding and were removed after the fix.

### Root causes

1. **Shell-occlusion culling gap (dominant).** Far-side culling only hid
   `cos ≤ -0.06`, but the opaque shell eclipses bodies in a wider **limb band**
   (~`cos` in `[-0.06, 0.2)`) right up to the silhouette. A cell there had its
   **body hidden by the sphere** while its opaque tail kept drawing → "tail with no
   body." `polygonOffset` couldn't help: those bodies are genuinely *behind* the
   shell, not z-fighting.
2. **A separate emissive nucleus (second artifact).** An opaque emissive
   `InstancedMesh` indexed by cell index. Being emissive, it glowed regardless of
   lighting/body opacity, so whenever a body was eclipsed (or the shared
   mother/daughter slot resolved to the young daughter) it read as an isolated
   glowing capsule. Removed; later re-add experiments were reverted. The current
   build has **no nucleus** — the bug was the cull, not the nucleus.

### Fix

- **Bodies are never culled.** A near-facing body is in front of the shell
  (visible); a far-side body is *behind* the shell and depth-occluded. So the body
  is always correct with zero culling.
- **Tails are culled at the horizon** (`sideHidden = cosFace <= 0`). The artifact
  was a far-side *tail* poking past the shell's silhouette; `placeTail` clears a
  hidden cell's tail, while `renderBodies` ignores `sideHidden`.
- Verify: `npm run build` + headless mitosis smoke test.

---

## Post-mortem #2 — "bodies disappear and reappear at random on scroll-zoom"

**Status:** resolved (2026-09-04), beads `cell-6uj`. Invisible to the first
investigation because it only shows under a *narrow* view cone.

### Symptom

Scroll-zoom made individual bodies vanish/return **at random** — a different subset
each time. Orbiting alone was fine; the trigger was the view cone narrowing/widening.

### Root cause

Mesh-level **`frustumCulled`** was never touched (the "bodies are never culled"
comment only governed cell-level `sideHidden`). Every pooled `InstancedMesh`
(`bodyPools`, `tailMesh`, `foodMesh`) was culled by three.js against a single
`boundingSphere` cached on **first render**:
- A body pool is born with one cell, so its sphere is frozen at **~one capsule
  radius** at that first cell — localised, never covering the shell, never recomputed.
- Default framing (camera ~14 away, 55° FOV) is wide enough to contain it → nothing
  culled → looks fine.
- **Zooming in** narrows the cone; any bucket whose frozen sphere falls outside is
  dropped that frame, then redrawn when it re-enters → bodies blink. Which buckets
  are affected depends on where each sphere sits vs. where you zoomed → "random".

### Fix

Disable frustum culling on every shell-spanning pool (the cached sphere is never
accurate, and `frustumCulled` buys nothing):

- `src/cells.js` `createBodyChunk` — `mesh.frustumCulled = false`
- `src/cells.js` `ensureTailChunk` (tail was a single `tailMesh`, now chunked) — `mesh.frustumCulled = false`
- `src/sim.js` `buildWorld` — `foodMesh.frustumCulled = false`

The chunked pools also retain this flag per chunk. Headless audit here confirms
`0` spurious culls and all pools `frustumCulled === false`.

---

## Lessons that carry forward

- **Two independent culling layers exist.** Cell-level `sideHidden` (per-cell,
  recomputed each frame) and **mesh-level `frustumCulled`** (three.js, per pool,
  against a one-shot cached sphere). A pool of instances spanning more space than
  its bounding sphere *must* set `frustumCulled = false`.
- **Opaque vs. transparent sort in separate passes.** A transparent body can be
  eclipsed by an opaque object (the shell, a tail) in front of it; a material tweak
  can't fix that.
- **When the occluder is opaque**, cull conservatively — hide only the far side and
  let the shell do the real occlusion. A clever "is it behind the shell" test
  over-hides the rim because the body's near cap sticks out.
- **A separate emissive mesh is lighting-independent.** If something never changes
  brightness, it's emissive, and it must stay in sync with whatever it's inside.
- **A wide default framing hides culling bugs.** Re-test under the narrowest view
  the user can reach (zoom all the way in) before declaring a render bug fixed.
- **Don't trust comments over behavior.** "Bodies are never culled" documented
  intent while the default flag did the opposite. `grep frustumCulled src/`.

## Code pointers

- `src/render.js` — `renderView(sim, tailScale)`: the whole draw path (tail scale/
  visibility via `sim.tailChunks`, far-side tail occlusion via `sideHidden`,
  bodies + tails, controls, render). No toggle object or `bodyShellGap`/`auditShell`
  remain (removed on cleanup).
- `src/math.js` — `cosFace` (occlusion culling).
- `src/cells.js` — `renderBodies` (per-cell `d.fade` scale), `placeTail` (clears a
  `sideHidden` cell's tail), body/tail chunk pools (`createBodyChunk`,
  `ensureTailChunk` — all `frustumCulled = false`).
- `src/sceneSetup.js` — camera framing + viewer-constant lighting + the opaque
  `FrontSide` shell (`MeshBasicMaterial`, radius `SPHERE_RADIUS`).
- `src/constants.js` — `CULL_COS` (= 0), `SPHERE_RADIUS`, `SURFACE`, `WIDTH`.
