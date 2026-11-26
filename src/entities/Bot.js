import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Entity } from './Entity.js';
import { Weapon } from '../weapons/Weapon.js';
import { WEAPONS } from '../weapons/definitions.js';
import { moveBody } from '../physics/collision.js';
import { BODY_PARTS } from '../shared/hitboxes.js';

// An AI opponent that only knows what it can see and hear.
//
//   patrol       walks between random spots, pausing to look around
//   investigate  heard something (or glimpsed you): turns toward it, then
//                goes to check it out
//   combat       has spotted you: turns to face you, settles its aim, fires
//                bursts; if you break line of sight it runs to where it
//                last saw / heard you
//   search       lost you: looks around for a while, then back to patrol
//
// Sight: a cone (CONFIG.bots.fov) with slower peripheral vision beyond it
// and nothing behind. Walls block it. Spotting isn't instant: awareness
// builds faster head-on, up close and when you're moving and standing.
// Hearing: listens to 'noise' events (shots, running footsteps, landings,
// impacts, knife swings). Walking and crouching make no noise, so you can
// sneak up behind them (and backstab).

// Body boxes match the shared hitbox table exactly (shared/hitboxes.js).
const partGeo = Object.fromEntries(BODY_PARTS.map((b) => [b.part, new THREE.BoxGeometry(b.w, b.h, b.d)]));
const gunGeo = new THREE.BoxGeometry(0.07, 0.09, 0.6);
// One grey for the lighting pass; the white outline is what makes bots read.
export const botMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });
const DEG = Math.PI / 180;

const rand = (a, b) => a + Math.random() * (b - a);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

export class Bot extends Entity {
  constructor(game, name, team = CONFIG.teams.bots) {
    const cfg = CONFIG.bots;
    super(game, { name, team, maxHealth: cfg.maxHealth, radius: cfg.radius, height: cfg.height });
    this.weapon = new Weapon(WEAPONS[cfg.weapon]);
    this.weapon.notify = (type) => game.events.emit(type, { owner: this, weapon: this.weapon.def });
    this.yaw = 0;
    this.buildModel();
    this.resetAI();
    this.offNoise = game.events.on('noise', (n) => this.hear(n));
  }

  // Teammates of the local player get a dim outline (enemies are bright).
  get outline() {
    return this.team === this.game.player?.team ? 0.4 : CONFIG.outlines.enemy;
  }

  buildModel() {
    this.root = new THREE.Group();
    const part = (g, y, z = 0) => {
      const mesh = new THREE.Mesh(g, botMaterial);
      mesh.position.set(0, y, z);
      mesh.castShadow = true;
      mesh.userData.outline = this.outline;
      this.root.add(mesh);
      return mesh;
    };
    for (const b of BODY_PARTS) part(partGeo[b.part], b.y);
    this.gun = part(gunGeo, 1.25, -0.35);
    this.gun.position.x = 0.2;
    this.game.scene.add(this.root);
  }

  resetAI() {
    this.state = 'patrol';
    this.awareness = 0; // 0..1; reaching 1 = spotted
    this.target = null; // enemy we're fighting
    this.canSee = false;
    this.aimPoint = null; // visible point on the target
    this.lastKnown = null; // where we last saw / heard the target
    this.goal = null; // where we're walking
    this.path = null;
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.thinkTimer = Math.random() * 0.1;
    this.waitTimer = rand(0.5, 2.5); // patrol pause / turn-before-moving
    this.lookYaw = null; // yaw to look toward while standing
    this.searchTimer = 0;
    this.lostTimer = 0;
    this.aimTimer = 0;
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.burstLeft = 3;
    this.burstPause = 0;
    this.deathTime = 0;
    this.orders = null; // bomb mode: { goal, use, exact, urgent } from the practice manager
    this.using = false; // holding "use" (plant / defuse)
    this.frozen = false; // freeze time
  }

  spawn(position, yaw = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.health = this.maxHealth;
    this.alive = true;
    this.weapon.reset();
    this.resetAI();
    this.root.rotation.set(0, yaw, 0);
    this.root.position.copy(position);
    this.resetPath();
    this.prevYaw = yaw;
  }

  getMuzzlePosition() {
    return new THREE.Vector3(0, 0, -0.3).applyMatrix4(this.gun.matrixWorld);
  }

  // Ticks: snap the model (and its hitboxes) to the logical position before
  // the tick's logic runs, so shots resolve against where the bot really is
  // (which is also where it's drawn at the moment the tick lands).
  beginTick() {
    super.beginTick();
    this.prevYaw = this.yaw;
    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;
  }

  // Every frame: draw sliding/turning between last tick and this one.
  frame(_dt, alpha) {
    this.renderPosition(alpha, this.root.position);
    const d = angleDiff(this.yaw, this.prevYaw ?? this.yaw);
    this.root.rotation.y = this.yaw - d * (1 - alpha);
  }

  takeDamage(amount, info = {}) {
    super.takeDamage(amount, info);
    // Getting shot gives you away: fight back (after turning to face).
    const src = info.source;
    if (this.alive && src && src.team !== this.team) this.engage(src, src.position);
  }

  // ---------- perception ----------

  // How visible `e` is right now: { point, factor } or null.
  visibility(e) {
    const cfg = CONFIG.bots;
    const eye = this.eyePosition;
    const chest = e.chestPosition;
    const dist = eye.distanceTo(chest);
    if (dist > cfg.sightRange) return null;
    const off = Math.abs(angleDiff(yawTo(eye, chest), this.yaw));
    if (off > cfg.peripheral * DEG) return null; // behind: can't see
    const world = this.game.world;
    let point = null;
    if (world.hasLineOfSight(eye, chest)) point = chest;
    else if (world.hasLineOfSight(eye, e.eyePosition)) point = e.eyePosition;
    if (!point) return null; // walls block sight
    const angleFactor = off <= cfg.fov * DEG ? 1 : cfg.peripheralFactor;
    const distFactor = THREE.MathUtils.clamp(1 - (dist - 6) / cfg.sightRange, 0.25, 1);
    const moving = Math.hypot(e.velocity.x, e.velocity.z) > 0.5;
    const stance = (e.crouching ? cfg.crouchFactor : 1) * (moving ? 1 : cfg.stillFactor);
    return { point, factor: angleFactor * distFactor * stance };
  }

  perceive(dt) {
    let best = null;
    for (const e of this.game.entities) {
      if (!e.alive || e.team === this.team || e.team === 'neutral') continue;
      const v = this.visibility(e);
      if (v && (!best || v.factor > best.factor)) best = { ...v, entity: e };
    }
    this.canSee = !!best;
    this.aimPoint = best?.point ?? null;
    if (!best) {
      if (this.state !== 'combat') this.awareness = Math.max(0, this.awareness - dt * 0.15);
      return;
    }
    if (this.state === 'combat') {
      this.target = best.entity;
      this.lastKnown = best.entity.position.clone();
      return;
    }
    this.awareness += (dt * best.factor) / CONFIG.bots.noticeTime;
    if (this.awareness >= 1) this.engage(best.entity, best.entity.position);
    else if (this.awareness > 0.3) this.investigate(best.entity.position, true); // "what was that?"
  }

  // 'noise' events: go check out what we heard.
  hear({ position, radius, source, kind }) {
    if (!this.alive || source === this) return;
    const ally = source && source.team === this.team;
    if (ally && kind !== 'shot') return; // teammates' steps aren't interesting
    const eye = this.eyePosition;
    const dist = eye.distanceTo(position);
    let range = radius * CONFIG.bots.hearing;
    if (dist > range) return;
    if (!this.game.world.hasLineOfSight(eye, position)) range *= 0.5; // muffled by walls
    if (dist > range) return;
    if (this.state === 'combat') {
      if (!this.canSee && source === this.target) this.lastKnown = position.clone();
      return;
    }
    // Sound gives a rough location: the further away, the rougher.
    const guess = position.clone();
    guess.x += rand(-1, 1) * dist * 0.08;
    guess.z += rand(-1, 1) * dist * 0.08;
    if (!ally && kind === 'shot') this.awareness = Math.max(this.awareness, 0.6); // on edge
    this.investigate(guess, true);
  }

  engage(target, position) {
    if (this.state !== 'combat') {
      this.aimTimer = 0;
      this.burstLeft = 2 + Math.floor(Math.random() * 3);
      this.burstPause = 0;
    }
    this.state = 'combat';
    this.awareness = 1;
    this.target = target;
    this.lastKnown = position.clone();
    this.lostTimer = 0;
    this.path = null;
  }

  investigate(point, turnFirst) {
    if (this.state === 'combat') return;
    if (this.orders?.urgent) return; // planting / defusing / grabbing the bomb comes first
    const fresh = this.state !== 'investigate';
    this.state = 'investigate';
    this.setGoal(point);
    if (fresh && turnFirst) {
      // Stop and turn toward it before walking over.
      this.lookYaw = yawTo(this.position, point);
      this.waitTimer = rand(0.4, 0.8);
    }
  }

  setGoal(point) {
    this.goal = point.clone();
    this.path = null;
    this.repathTimer = 0;
  }

  // ---------- update ----------

  update(dt) {
    this.weapon.update(dt);
    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }

    if (this.frozen) {
      this.using = false;
      this.root.position.copy(this.position);
      return;
    }
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.1;
      this.perceive(0.1);
    }

    const desired = new THREE.Vector3();
    let speed = 0;
    if (this.state !== 'patrol' && this.state !== 'search') this.using = false;
    switch (this.state) {
      case 'combat':
        speed = this.updateCombat(desired, dt);
        break;
      case 'investigate':
        speed = this.updateInvestigate(desired, dt);
        break;
      case 'search':
        if (this.orders) speed = this.updateOrders(desired, dt);
        else this.updateSearch(dt);
        break;
      default:
        speed = this.orders ? this.updateOrders(desired, dt) : this.updatePatrol(desired, dt);
    }
    if (!this.weapon.reloading && !this.canSee && this.weapon.ammo < this.weapon.def.magSize * 0.4) this.weapon.startReload();

    // Physics.
    const cfg = CONFIG.bots;
    const accel = cfg.accel * dt;
    const dx = desired.x - this.velocity.x;
    const dz = desired.z - this.velocity.z;
    const dlen = Math.hypot(dx, dz);
    const k = dlen > accel ? accel / dlen : 1;
    this.velocity.x += dx * k;
    this.velocity.z += dz * k;
    this.velocity.y -= CONFIG.physics.gravity * dt;
    const wasOnGround = this.onGround;
    const fallSpeed = -this.velocity.y;
    const res = moveBody(this, dt, this.game.world.colliders);
    this.onGround = res.onGround;
    if (res.hitWall) {
      this.strafeDir *= -1;
      this.repathTimer = Math.min(this.repathTimer, 0.1);
    }
    // Patrol pace is soft-footed; running is loud.
    this.footsteps(dt, { volume: speed > cfg.walkSpeed + 0.5 ? 1 : 0.45, wasOnGround, fallSpeed, stride: 2.0 });

    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;
  }

  updateCombat(out, dt) {
    const cfg = CONFIG.bots;
    if (this.canSee && this.aimPoint) {
      this.lostTimer = 0;
      // Turn to face, then hold aim for a moment before shooting.
      const eye = this.eyePosition;
      const off = this.turnToward(yawTo(eye, this.aimPoint), dt);
      if (off < cfg.aimTolerance) this.aimTimer += dt;
      else this.aimTimer = Math.max(0, this.aimTimer - dt * 2);
      if (this.aimTimer >= cfg.aimTime) {
        this.tryShoot(new THREE.Vector3().subVectors(this.aimPoint, eye).normalize(), dt);
        if (this.burstPause > 0) this.strafe(out, dt); // sidestep between bursts
      }
      return Math.hypot(out.x, out.z);
    }
    // Lost sight: run to where we last knew they were.
    this.aimTimer = Math.max(0, this.aimTimer - dt);
    this.lostTimer += dt;
    if (!this.goal || this.goal.distanceToSquared(this.lastKnown) > 1) this.setGoal(this.lastKnown);
    const arrived = this.followPath(out, cfg.speed, dt);
    if (arrived || this.lostTimer > 8) this.startSearch();
    return cfg.speed;
  }

  updateInvestigate(out, dt) {
    if (this.waitTimer > 0) {
      this.waitTimer -= dt;
      if (this.lookYaw != null) this.turnToward(this.lookYaw, dt);
      return 0;
    }
    const speed = this.awareness > 0.5 ? CONFIG.bots.speed : CONFIG.bots.walkSpeed;
    if (this.followPath(out, speed, dt)) this.startSearch(2.5);
    return speed;
  }

  startSearch(time = CONFIG.bots.searchTime) {
    this.state = 'search';
    this.searchTimer = time;
    this.awareness = Math.max(this.awareness, 0.5);
    this.lookYaw = this.yaw + rand(-1.5, 1.5);
    this.waitTimer = rand(0.6, 1.2);
    this.path = null;
    this.goal = null;
  }

  // Stand and look around, then go back to patrolling.
  updateSearch(dt) {
    this.searchTimer -= dt;
    this.waitTimer -= dt;
    if (this.waitTimer <= 0) {
      this.lookYaw = this.yaw + rand(-2, 2);
      this.waitTimer = rand(0.6, 1.4);
    }
    this.turnToward(this.lookYaw, dt * 0.6);
    if (this.searchTimer <= 0) {
      this.state = 'patrol';
      this.target = null;
      this.goal = null;
      this.waitTimer = rand(0.5, 1.5);
    }
  }

  // Wander between random spots, pausing to glance around.
  updatePatrol(out, dt) {
    if (this.waitTimer > 0) {
      this.waitTimer -= dt;
      if (this.lookYaw != null) this.turnToward(this.lookYaw, dt * 0.5);
      if (this.waitTimer <= 0) this.goal = null;
      return 0;
    }
    if (!this.goal) {
      const here = this.position;
      const p = this.game.world.randomOpenPoint((q) => q.distanceTo(here) > 8);
      if (!p) return 0;
      this.setGoal(p);
    }
    if (this.followPath(out, CONFIG.bots.walkSpeed, dt)) {
      this.waitTimer = rand(1.5, 4);
      this.lookYaw = this.yaw + rand(-2, 2);
    }
    return CONFIG.bots.walkSpeed;
  }

  // Bomb mode: go where the orders say; once there, hold the spot (looking
  // around) or hold "use" on it (plant / defuse).
  updateOrders(out, dt) {
    const o = this.orders;
    if (this.state === 'search') this.state = 'patrol';
    const dx = o.goal.x - this.position.x;
    const dz = o.goal.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 1.6) {
      this.using = false;
      if (!this.goal || this.goal.distanceToSquared(o.goal) > 0.25) this.setGoal(o.goal);
      const speed = o.walk ? CONFIG.bots.walkSpeed : CONFIG.bots.speed;
      if (this.followPath(out, speed, dt)) this.setGoal(o.goal);
      return speed;
    }
    this.goal = null;
    this.path = null;
    if (o.exact && d > 0.4) {
      // Last step straight onto the spot (the bomb isn't on a cell center).
      const s = CONFIG.bots.walkSpeed;
      out.set((dx / d) * s, 0, (dz / d) * s);
      this.turnToward(Math.atan2(-dx, -dz), dt);
      this.using = false;
      return s;
    }
    this.using = !!o.use;
    if (!o.use) {
      this.waitTimer -= dt;
      if (this.waitTimer <= 0 || this.lookYaw == null) {
        this.lookYaw = o.look ?? this.yaw + rand(-2, 2);
        if (o.look != null) this.lookYaw += rand(-0.8, 0.8);
        this.waitTimer = rand(1, 2.5);
      }
      this.turnToward(this.lookYaw, dt * 0.6);
    }
    return 0;
  }

  // Rotates toward targetYaw; returns how far off we still are (radians).
  turnToward(targetYaw, dt) {
    const diff = angleDiff(targetYaw, this.yaw);
    const step = CONFIG.bots.turnSpeed * dt;
    this.yaw += Math.abs(diff) < step ? diff : Math.sign(diff) * step;
    return Math.abs(angleDiff(targetYaw, this.yaw));
  }

  strafe(out, dt) {
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      this.strafeTimer = rand(0.4, 1.1);
    }
    const s = CONFIG.bots.speed * 0.7 * this.strafeDir;
    out.set(Math.cos(this.yaw) * s, 0, -Math.sin(this.yaw) * s);
  }

  tryShoot(dir, dt) {
    if (this.weapon.ammo === 0) {
      this.weapon.startReload();
      return;
    }
    if (this.burstPause > 0) {
      this.burstPause -= dt;
      return;
    }
    if (!this.game.tickStart) return; // at most one shot per game tick
    const scale = CONFIG.spreadScale.enabled ? CONFIG.spreadScale.still : 1;
    const shot = this.weapon.fire(this.game, this, this.eyePosition, dir, { scale, jitter: CONFIG.bots.aimError });
    if (shot && --this.burstLeft <= 0) {
      this.burstLeft = 2 + Math.floor(Math.random() * 4);
      this.burstPause = rand(0.25, 0.6);
    }
  }

  // Walks the grid path to this.goal, facing where it's going. Returns true
  // on arrival.
  followPath(out, speed, dt) {
    if (!this.goal) return true;
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 || !this.path) {
      this.repathTimer = CONFIG.bots.repathInterval * rand(0.8, 1.2);
      this.path = this.game.world.findPath(this.position, this.goal);
      this.pathIndex = 0;
      if (!this.path) {
        this.goal = null;
        return true; // unreachable
      }
    }
    if (this.pathIndex >= this.path.length) {
      this.goal = null;
      return true;
    }
    const wp = this.path[this.pathIndex];
    const dx = wp.x - this.position.x;
    const dz = wp.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) {
      this.pathIndex++;
      return false;
    }
    out.set((dx / dist) * speed, 0, (dz / dist) * speed);
    this.turnToward(Math.atan2(-dx, -dz), dt);
    return false;
  }

  updateDeath(dt) {
    this.deathTime += dt;
    const t = Math.min(1, this.deathTime / 0.4);
    this.root.rotation.x = (-Math.PI / 2) * t * t;
  }

  dispose() {
    this.offNoise?.();
    this.game.scene.remove(this.root);
  }
}
