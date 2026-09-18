// One key scheme and one neighbourhood scan shared by the food and cell spatial
// hashes. Both are Map<key, index[]>; callers own insert/remove and any
// per-entry filtering (for example food visibility).

// Keys pack three signed coordinates with a +2048 offset into a 4096 span.
// Coordinates beyond +/-2048 would alias onto other cells of the grid.
const OFFSET = 2048
const SPAN = 4096

export function gridKey(cx, cy, cz) {
  return ((cx + OFFSET) * SPAN + (cy + OFFSET)) * SPAN + (cz + OFFSET)
}

// Radius (in buckets) that guarantees forEachNearby covers every entry within
// `reach` of a point anywhere inside the centre bucket. A whole-bucket scan
// reaches only r*bucketSize past the point, so the +1 pays for a point sitting
// on the far edge of its own bucket.
export function scanRadius(reach, bucketSize) {
  return 1 + Math.floor(reach / bucketSize)
}

export function forEachNearby(grid, cx, cy, cz, r, cb) {
  for (let ox = -r; ox <= r; ox++) {
    for (let oy = -r; oy <= r; oy++) {
      for (let oz = -r; oz <= r; oz++) {
        const bucket = grid.get(gridKey(cx + ox, cy + oy, cz + oz))
        if (!bucket) continue
        for (let k = 0; k < bucket.length; k++) {
          if (cb(bucket[k]) === false) return
        }
      }
    }
  }
}
