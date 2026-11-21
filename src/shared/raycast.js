import * as THREE from 'three';

// Pure-math hitscan used by both client and server, so a shot resolves the
// same way on both: ray vs. the map's axis-aligned boxes and ray vs. the
// characters' yaw-rotated hitboxes (shared/hitboxes.js).

// Slab test against an axis-aligned box. Returns { t, nx, ny, nz } or null.
function slab(ox, oy, oz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz, far) {
  let tmin = 0;
  let tmax = far;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  // x
  if (Math.abs(dx) < 1e-12) {
    if (ox < minx || ox > maxx) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (minx - ox) * inv;
    let t2 = (maxx - ox) * inv;
    let n = -1;
    if (t1 > t2) [t1, t2, n] = [t2, t1, 1];
    if (t1 > tmin) [tmin, nx, ny, nz] = [t1, n, 0, 0];
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // y
  if (Math.abs(dy) < 1e-12) {
    if (oy < miny || oy > maxy) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (miny - oy) * inv;
    let t2 = (maxy - oy) * inv;
    let n = -1;
    if (t1 > t2) [t1, t2, n] = [t2, t1, 1];
    if (t1 > tmin) [tmin, nx, ny, nz] = [t1, 0, n, 0];
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // z
  if (Math.abs(dz) < 1e-12) {
    if (oz < minz || oz > maxz) return null;
  } else {
    const inv = 1 / dz;
    let t1 = (minz - oz) * inv;
    let t2 = (maxz - oz) * inv;
    let n = -1;
    if (t1 > t2) [t1, t2, n] = [t2, t1, 1];
    if (t1 > tmin) [tmin, nx, ny, nz] = [t1, 0, 0, n];
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin === 0 && nx === 0 && ny === 0 && nz === 0) return null; // started inside
  return { t: tmin, nx, ny, nz };
}

// Ray vs. Box3-like { min, max }.
export function rayBox(o, d, b, far) {
  return slab(o.x, o.y, o.z, d.x, d.y, d.z, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z, far);
}

// Ray vs. a hitbox { x, y, z, hx, hy, hz, yaw } (rotated about y).
export function rayHitbox(o, d, h, far) {
  const c = Math.cos(h.yaw);
  const s = Math.sin(h.yaw);
  // World -> box space (inverse of rotation.y = yaw).
  const rx = o.x - h.x;
  const rz = o.z - h.z;
  const lox = rx * c - rz * s;
  const loz = rx * s + rz * c;
  const ldx = d.x * c - d.z * s;
  const ldz = d.x * s + d.z * c;
  const r = slab(lox, o.y - h.y, loz, ldx, d.y, ldz, -h.hx, -h.hy, -h.hz, h.hx, h.hy, h.hz, far);
  if (!r) return null;
  // Normal back to world space.
  const nx = r.nx * c + r.nz * s;
  const nz = -r.nx * s + r.nz * c;
  return { t: r.t, nx, ny: r.ny, nz };
}

// Closest hit along a ray.
//   colliders - map boxes ({ min, max })
//   bodies    - [{ entity, shapes: hitboxesAt(...) }]
// Returns { point, normal, distance, entity, part } or null.
export function castRay(origin, dir, far, colliders, bodies = []) {
  let best = null;
  let bestT = far;
  for (const b of colliders) {
    const r = rayBox(origin, dir, b, bestT);
    if (r && r.t < bestT) [bestT, best] = [r.t, { r, entity: null, part: null }];
  }
  for (const body of bodies) {
    for (const h of body.shapes) {
      const r = rayHitbox(origin, dir, h, bestT);
      if (r && r.t < bestT) [bestT, best] = [r.t, { r, entity: body.entity, part: h.part }];
    }
  }
  if (!best) return null;
  return {
    point: new THREE.Vector3().copy(origin).addScaledVector(dir, bestT),
    normal: new THREE.Vector3(best.r.nx, best.r.ny, best.r.nz),
    distance: bestT,
    entity: best.entity,
    part: best.part,
  };
}

const _d = new THREE.Vector3();
// True if nothing in `colliders` blocks the straight line from -> to.
export function segmentClear(from, to, colliders) {
  _d.subVectors(to, from);
  const len = _d.length();
  if (len < 1e-4) return true;
  _d.divideScalar(len);
  for (const b of colliders) if (rayBox(from, _d, b, len)) return false;
  return true;
}
