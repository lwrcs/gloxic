// Character hitboxes, shared by the client (drawing, bots, local hit
// effects) and the server (authoritative hit registration). One table so
// what you see is exactly what the server tests against.
//
// Boxes are upright and turn with the character's yaw. Sizes are for a
// standing 1.8 m character; crouching squashes legs and torso and lowers
// the head (which keeps its size).

export const STAND_HEIGHT = 1.8;

export const BODY_PARTS = [
  { part: 'legs', w: 0.4, h: 0.8, d: 0.25, y: 0.4 },
  { part: 'body', w: 0.55, h: 0.7, d: 0.32, y: 1.15 },
  { part: 'head', w: 0.28, h: 0.28, d: 0.28, y: 1.65 },
];

// Hitboxes for a character standing at `pos` (feet), facing `yaw`, with
// current `height`. Returns [{ part, x, y, z, hx, hy, hz, yaw }] (centers
// and half sizes).
export function hitboxesAt(pos, yaw, height = STAND_HEIGHT) {
  const s = height / STAND_HEIGHT;
  return BODY_PARTS.map((b) => {
    const head = b.part === 'head';
    return {
      part: b.part,
      x: pos.x,
      y: pos.y + (head ? height - (STAND_HEIGHT - b.y) : b.y * s),
      z: pos.z,
      hx: b.w / 2,
      hy: (head ? b.h : b.h * s) / 2,
      hz: b.d / 2,
      yaw,
    };
  });
}
