// Axis-aligned box physics. Bodies are upright boxes: `position` is the
// center of the feet, `radius` is half-width, `height` goes up from the feet.
// World colliders are THREE.Box3s. Movement resolves one axis at a time,
// which gives wall-sliding for free.

const EPS = 0.001;
const AXES = ['x', 'z', 'y'];

export function overlaps(px, py, pz, r, h, b) {
  return (
    px + r > b.min.x &&
    px - r < b.max.x &&
    pz + r > b.min.z &&
    pz - r < b.max.z &&
    py + h > b.min.y &&
    py < b.max.y
  );
}

export function overlapsAny(pos, r, h, colliders) {
  for (const b of colliders) if (overlaps(pos.x, pos.y, pos.z, r, h, b)) return true;
  return false;
}

// Moves body by its velocity over dt, stopping at colliders.
// body: { position: Vector3, velocity: Vector3, radius, height }
export function moveBody(body, dt, colliders) {
  const result = { onGround: false, hitCeiling: false, hitWall: false };
  const p = body.position;
  const v = body.velocity;
  const r = body.radius;
  const h = body.height;

  // Substep so fast movement can't tunnel through thin geometry.
  const maxMove = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) * dt;
  const steps = Math.max(1, Math.ceil(maxMove / (r * 0.9)));
  const sdt = dt / steps;

  for (let s = 0; s < steps; s++) {
    for (const axis of AXES) {
      const d = v[axis] * sdt;
      if (d === 0) continue;
      p[axis] += d;
      for (const b of colliders) {
        if (!overlaps(p.x, p.y, p.z, r, h, b)) continue;
        if (axis === 'y') {
          if (d < 0) {
            p.y = b.max.y + EPS;
            result.onGround = true;
          } else {
            p.y = b.min.y - h - EPS;
            result.hitCeiling = true;
          }
        } else {
          p[axis] = d > 0 ? b.min[axis] - r - EPS : b.max[axis] + r + EPS;
          result.hitWall = true;
        }
        v[axis] = 0;
      }
    }
  }
  return result;
}
