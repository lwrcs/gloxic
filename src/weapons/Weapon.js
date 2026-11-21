import * as THREE from 'three';
import { CONFIG } from '../config.js';

// One instance of a gun: ammo, cooldown, reload and spray pattern. Used by
// both the player and bots. Firing is hitscan through game.raycast(), and
// every trigger pull emits one 'shot' event that effects / audio listen to.
//
// There's no random spread. Each gun has a fixed spray pattern (see
// `pattern` in definitions.js): shots climb and zig-zag in the same way
// every time, so it can be learned and pulled against. `spray` is how far
// into the pattern the next shot is; it winds back down when you stop.
//
// Melee weapons (def.melee) trace a short fan of rays instead, hit one
// target once, and can backstab (see isBackstab below).
//
// Every attack also emits a 'noise' event that bots can hear.

const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);

export class Weapon {
  constructor(def) {
    this.def = def;
    // Optional hook set by the owner: notify('reloadStart' | 'reloadEnd' |
    // 'reloadCancel'). Owners forward these to game.events for effects.
    this.notify = null;
    this.reset();
  }

  reset() {
    if (this.reloadTimer > 0) this.notify?.('reloadCancel');
    this.ammo = this.def.magSize;
    this.reserve = this.def.reserve;
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.spray = 0; // shots into the pattern (fractional while recovering)
    this.lockedClimb = 1; // climb scale for the current spray
    this.sinceShot = Infinity;
  }

  // Seconds between attacks. `fireTicks` pins it to a whole number of logic
  // ticks (exact at any frame rate); otherwise it comes from `fireRate` (rpm).
  get interval() {
    const d = this.def;
    return d.fireTicks ? d.fireTicks / CONFIG.physics.tickRate : 60 / d.fireRate;
  }

  get reloading() {
    return this.reloadTimer > 0;
  }

  get reloadProgress() {
    return this.reloading ? 1 - this.reloadTimer / this.def.reloadTime : 0;
  }

  update(dt) {
    // Not clamped at 0: fire() carries the overshoot into the next interval so
    // the real fire rate doesn't round down to whole frames.
    this.cooldown -= dt;
    this.sinceShot += dt;
    // Only recover once the trigger has clearly been let go.
    if (this.sinceShot > this.interval + 0.05) {
      this.spray = Math.max(0, this.spray - this.def.pattern.recovery * dt);
    }
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    }
  }

  canFire() {
    return this.cooldown <= 1e-6 && !this.reloading && this.ammo > 0; // epsilon: exact tick timing
  }

  startReload() {
    if (this.reloading || this.ammo === this.def.magSize || this.reserve === 0) return false;
    this.reloadTimer = this.def.reloadTime;
    this.notify?.('reloadStart');
    return true;
  }

  cancelReload() {
    if (!this.reloading) return;
    this.reloadTimer = 0;
    this.notify?.('reloadCancel');
  }

  finishReload() {
    const take = Math.min(this.def.magSize - this.ammo, this.reserve);
    this.ammo += take;
    this.reserve -= take;
    this.reloadTimer = 0;
    this.notify?.('reloadEnd');
  }

  // Raw pattern offset (radians; x = right, y = up) for shot number t.
  // Climbs `rise` per shot up to `riseCap` shots, while x zig-zags as a
  // triangle wave that starts in the middle and swings left first:
  // center, left, center, right, center... With period 8 the rifle's 30
  // rounds run 0,-1,-2,-1,0,1,2,1, 0,-1,... (in units of swing/2).
  patternAt(t) {
    const p = this.def.pattern;
    const y = p.rise * Math.min(t, p.riseCap);
    if (!p.swing) return { x: 0, y };
    const phase = (t / p.period) % 1;
    const tri = phase < 0.25 ? phase * 4 : phase < 0.75 ? 2 - phase * 4 : phase * 4 - 4;
    return { x: -p.swing * tri, y };
  }

  // Pattern offset at spray position t. `climb` (stance / movement / ADS)
  // scales only the upward climb; the zig-zag always keeps its full width.
  offsetAt(t, climb = 1) {
    const o = this.patternAt(t);
    return { x: o.x, y: o.y * climb };
  }

  // The climb scale is locked when a spray starts, so moving or aiming
  // mid-spray can't reshape the pattern: every spray is the same.
  climbFor(scale) {
    return this.spray > 0 ? this.lockedClimb : scale;
  }

  // Where the next shot will land relative to the (unrecoiled) aim.
  nextOffset(scale = 1) {
    return this.offsetAt(this.spray, this.climbFor(scale));
  }

  // Fires one trigger pull (several pellets for shotguns).
  //   scale        - climb multiplier from stance / movement / ADS
  //   applyPattern - offset this shot along the pattern (fixed-view mode,
  //                  bots). False when the caller turns the view instead.
  //   jitter       - optional random error in radians (bots only; 0 = off)
  // Returns { pellets: [{ direction, hit }], kick: {x, y} } or null if it
  // can't fire. `kick` is the pattern step from this shot to the next one.
  fire(game, owner, origin, direction, opts = {}) {
    const { scale = 1, applyPattern = true, jitter = 0 } = opts;
    if (!this.canFire()) return null;
    const def = this.def;
    if (def.melee) return this.swing(game, owner, origin, direction, opts);
    this.ammo--;
    const interval = this.interval;
    // Keep up to a frame of overshoot (held trigger); after idling, start fresh.
    this.cooldown = interval + Math.max(this.cooldown, -Math.min(interval, 0.05));

    const climb = this.climbFor(scale);
    this.lockedClimb = climb;
    const o = this.offsetAt(this.spray, climb);
    let aim = applyPattern ? offsetDirection(direction, o.x, o.y) : direction.clone();
    if (jitter > 0) aim = randomCone(aim, jitter);
    this.spray += 1;
    this.sinceShot = 0;
    const next = this.offsetAt(this.spray, climb);
    const kick = { x: next.x - o.x, y: next.y - o.y };

    // Total up damage per target so a shotgun blast is one hit, not eight.
    const pellets = [];
    const damage = new Map(); // entity -> { amount, head }
    const count = def.pellets ?? 1;
    for (let i = 0; i < count; i++) {
      const dir = count > 1 ? pelletDirection(aim, i, count, def.pelletSpread) : aim;
      const hit = game.raycast(origin, dir, def.range, owner);
      pellets.push({ direction: dir, hit });
      if (hit?.entity && hit.entity.team !== owner.team) {
        const d = damage.get(hit.entity) ?? { amount: 0, head: false };
        d.amount += def.damage[hit.part] ?? def.damage.body;
        d.head ||= hit.part === 'head';
        damage.set(hit.entity, d);
      }
    }
    for (const [entity, d] of damage) {
      entity.takeDamage(d.amount, { source: owner, part: d.head ? 'head' : 'body', weapon: def });
    }

    game.events.emit('shot', { owner, weapon: def, origin: origin.clone(), pellets });
    game.events.emit('noise', { position: origin.clone(), radius: def.noiseRadius ?? 50, source: owner, kind: 'shot' });
    const impact = pellets.find((p) => p.hit && !p.hit.entity)?.hit;
    if (impact) game.events.emit('noise', { position: impact.point.clone(), radius: 7, source: owner, kind: 'impact' });
    return { pellets, kick };
  }

  // Melee: the first enemy (or wall) inside a small fan of short rays.
  // Returns { hit, direction } where hit may be null.
  meleeTrace(game, owner, origin, direction) {
    const r = this.def.meleeSpread ?? 0.12;
    let wall = null;
    for (const [x, y] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const dir = offsetDirection(direction, x, y);
      const hit = game.raycast(origin, dir, this.def.range, owner);
      if (hit?.entity && hit.entity.team !== owner.team) return { hit, direction: dir };
      if (hit && !wall) wall = { hit, direction: dir };
    }
    return wall ?? { hit: null, direction: direction.clone() };
  }

  // One melee attack. `backstab(entity)` decides if a hit is a backstab
  // (instant kill). Returns { pellets, kick, hit, backstab }.
  swing(game, owner, origin, direction, { backstab: isStab = null } = {}) {
    const def = this.def;
    this.cooldown = this.interval + Math.max(this.cooldown, -Math.min(this.interval, 0.05));
    this.sinceShot = 0;
    const { hit, direction: dir } = this.meleeTrace(game, owner, origin, direction);
    let backstab = false;
    if (hit?.entity) {
      backstab = !!isStab?.(hit.entity);
      const amount = backstab ? Math.max(hit.entity.health, def.damage.body) : (def.damage[hit.part] ?? def.damage.body);
      hit.entity.takeDamage(amount, { source: owner, part: backstab ? 'backstab' : hit.part, weapon: def });
    }
    const pellets = [{ direction: dir, hit }];
    game.events.emit('shot', { owner, weapon: def, origin: origin.clone(), pellets, melee: true, backstab });
    game.events.emit('noise', { position: origin.clone(), radius: hit ? 5 : 2.5, source: owner, kind: 'melee' });
    return { pellets, kick: { x: 0, y: 0 }, hit, backstab };
  }
}

// TF2-style backstab test: the attacker is behind the victim (the victim is
// facing away) and is facing the same general way. `attackerForward` and the
// victim's facing are horizontal; victim.forward() gives its facing.
export function isBackstab(attackerPos, attackerForward, victim) {
  if (!victim.forward) return false;
  const vf = victim.forward();
  const toVictim = new THREE.Vector3(victim.position.x - attackerPos.x, 0, victim.position.z - attackerPos.z).normalize();
  const af = new THREE.Vector3(attackerForward.x, 0, attackerForward.z).normalize();
  return vf.dot(toVictim) > 0.3 && af.dot(vf) > 0;
}

// Screen-space basis around a direction: right and up as seen by the shooter.
function basis(dir) {
  const helper = Math.abs(dir.y) < 0.99 ? _up : _right;
  const right = new THREE.Vector3().crossVectors(dir, helper).normalize();
  const up = new THREE.Vector3().crossVectors(right, dir).normalize();
  return { right, up };
}

// Rotates dir by small angles x (right) and y (up).
function offsetDirection(dir, x, y) {
  if (!x && !y) return dir.clone();
  const { right, up } = basis(dir);
  return dir.clone().addScaledVector(right, Math.tan(x)).addScaledVector(up, Math.tan(y)).normalize();
}

// Fixed shotgun layout: one pellet dead center, the rest evenly on a ring.
function pelletDirection(aim, i, count, spread) {
  if (i === 0) return aim.clone();
  const a = ((i - 1) / (count - 1)) * Math.PI * 2;
  return offsetDirection(aim, Math.cos(a) * spread, Math.sin(a) * spread);
}

// Random direction inside a cone (used only for bot aim error).
function randomCone(dir, spread) {
  const { right, up } = basis(dir);
  const r = spread * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  return dir
    .clone()
    .addScaledVector(right, Math.cos(a) * r)
    .addScaledVector(up, Math.sin(a) * r)
    .normalize();
}
