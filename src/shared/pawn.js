import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { moveBody, overlapsAny } from '../physics/collision.js';
import { isBackstab } from '../weapons/Weapon.js';

// The player simulation shared by the client (prediction) and the server
// (authority). Everything a player does is driven by commands: one per
// 64 Hz tick, holding the buttons and view angles for that tick. Running
// the same commands through runCmd() on both sides gives the same result,
// which is what makes client-side prediction line up with the server.
//
// A "pawn" is anything with: position, velocity, onGround, crouching,
// height, radius, yaw, pitch, alive, frozen, ads, weapons[], weaponIndex.

// Command buttons (bit flags).
export const BTN = {
  FORWARD: 1,
  BACK: 2,
  LEFT: 4,
  RIGHT: 8,
  JUMP: 16,
  CROUCH: 32,
  WALK: 64,
  FIRE: 128, // trigger held
  FIRE_PRESS: 256, // trigger pressed this tick (semi-auto weapons)
  ADS: 512,
  RELOAD: 1024,
  RECOIL_VIEW: 2048, // "view follows recoil": the client turns the view, the server doesn't offset shots
};

const _dir = new THREE.Vector3();
const _euler = new THREE.Euler();

// Unit view direction for yaw / pitch (radians).
export function aimDirection(yaw, pitch, out = new THREE.Vector3()) {
  return out.set(0, 0, -1).applyEuler(_euler.set(pitch, yaw, 0, 'YXZ'));
}

// Logical eye: where shots come from (the camera eases toward it).
export function eyeOf(p, out = new THREE.Vector3()) {
  return out.set(p.position.x, p.position.y + p.height - CONFIG.player.eyeOffset, p.position.z);
}

// Spray pattern scale from stance / movement / ADS (CONFIG.spreadScale).
export function patternScale(p) {
  const S = CONFIG.spreadScale;
  if (!S.enabled) return 1;
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  const moving = Math.min(1, Math.max(0, (speed - 1) / (CONFIG.player.runSpeed - 1)));
  const hipScale = S.still + (S.moving - S.still) * moving;
  let scale = hipScale + (S.ads - hipScale) * (p.adsT ?? p.ads ?? 0); // adsT: client (smooth), ads: server (held)
  if (!p.onGround) scale *= S.air;
  if (p.crouching) scale *= S.crouch;
  return scale;
}

// One tick of movement. Returns { quiet, wasOnGround, fallSpeed, jumped }.
export function stepMove(p, buttons, yaw, dt, colliders) {
  const cfg = CONFIG.player;
  const frozen = !!p.frozen;
  const b = frozen ? 0 : buttons;

  // Crouch; only stand up if there's room above.
  if (b & BTN.CROUCH) p.crouching = true;
  else if (p.crouching && !overlapsAny(p.position, p.radius, cfg.height, colliders)) p.crouching = false;
  p.height = p.crouching ? cfg.crouchHeight : cfg.height;

  // Desired horizontal velocity relative to where we look.
  const ix = (b & BTN.RIGHT ? 1 : 0) - (b & BTN.LEFT ? 1 : 0);
  const iz = (b & BTN.FORWARD ? 1 : 0) - (b & BTN.BACK ? 1 : 0);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  let wx = -sin * iz + cos * ix;
  let wz = -cos * iz - sin * ix;
  const len = Math.hypot(wx, wz);
  const walking = !!(b & BTN.WALK);
  const speed = p.crouching ? cfg.crouchSpeed : walking ? cfg.walkSpeed : cfg.runSpeed;
  if (len > 0) {
    wx = (wx / len) * speed;
    wz = (wz / len) * speed;
  }

  // Accelerate toward it (snappy on the ground, floaty in the air).
  const accel = (p.onGround ? cfg.groundAccel : cfg.airAccel) * dt;
  const dx = wx - p.velocity.x;
  const dz = wz - p.velocity.z;
  const dlen = Math.hypot(dx, dz);
  const k = dlen > accel ? accel / dlen : 1;
  p.velocity.x += dx * k;
  p.velocity.z += dz * k;

  let jumped = false;
  if (p.onGround && !p.crouching && b & BTN.JUMP) {
    p.velocity.y = cfg.jumpSpeed;
    jumped = true;
  }
  p.velocity.y -= CONFIG.physics.gravity * dt;

  const wasOnGround = p.onGround;
  const fallSpeed = -p.velocity.y;
  p.onGround = moveBody(p, dt, colliders).onGround;
  return { quiet: p.crouching || walking, wasOnGround, fallSpeed, jumped };
}

export function switchWeapon(p, index) {
  if (index === p.weaponIndex || !p.weapons[index]) return false;
  p.lastWeaponIndex = p.weaponIndex;
  p.weapons[p.weaponIndex].cancelReload();
  p.weaponIndex = index;
  const w = p.weapons[index];
  w.cooldown = Math.max(w.cooldown, CONFIG.player.switchTime);
  return true;
}

// Runs one command.
//   cmd   - { buttons, yaw, pitch, slot }
//   ctx   - { world, raycast(origin, dir, far, ignore), events } (the Game on
//           the client, the match on the server)
//   hooks - optional client-side reactions: moved(result), switched(),
//           fired(result, weapon), dryFire(pressed)
export function runCmd(p, cmd, dt, ctx, hooks = {}) {
  p.weapons[p.weaponIndex].update(dt);
  if (!p.alive) return;
  p.yaw = cmd.yaw;
  p.pitch = cmd.pitch;
  p.ads = cmd.buttons & BTN.ADS ? 1 : 0;

  const moved = stepMove(p, cmd.buttons, cmd.yaw, dt, ctx.world.colliders);
  hooks.moved?.(moved);

  if (cmd.slot !== p.weaponIndex && switchWeapon(p, cmd.slot)) hooks.switched?.();
  if (p.frozen) return;
  const w = p.weapons[p.weaponIndex];
  if (cmd.buttons & BTN.RELOAD) w.startReload();

  const pressed = !!(cmd.buttons & BTN.FIRE_PRESS);
  const trigger = w.def.automatic ? pressed || !!(cmd.buttons & BTN.FIRE) : pressed;
  if (!trigger) return;
  if (w.ammo === 0 && !w.reloading) {
    hooks.dryFire?.(pressed);
    w.startReload();
    return;
  }
  const origin = eyeOf(p);
  const dir = aimDirection(p.yaw, p.pitch, _dir).clone();
  let result;
  if (w.def.melee) {
    result = w.fire(ctx, p, origin, dir, { backstab: (e) => isBackstab(p.position, dir, e) });
  } else {
    // View follows recoil: the shot goes where the view points and the
    // client turns the view by the pattern step. Otherwise the shot itself
    // is offset along the pattern.
    result = w.fire(ctx, p, origin, dir, { scale: patternScale(p), applyPattern: !(cmd.buttons & BTN.RECOIL_VIEW) });
  }
  if (result) hooks.fired?.(result, w);
}
