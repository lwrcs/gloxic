import * as THREE from 'three';
import { hitboxesAt } from '../shared/hitboxes.js';

// Base class for anything that lives in the world, moves, and can be shot.
// Subclasses override update(dt), and optionally onDeath() / dispose().
//
// Game ticks: update(dt) is game logic. With ticks on it runs in a burst of
// small steps once per tick; frame(dt, alpha) runs every rendered frame. Each
// tick records the trail the entity took (one point per logic step) and the
// frames replay it over the next tick (alpha 0..1), so curves like a jump arc
// show up at any tick length. With ticks off both run every frame, alpha is 1.
//
// Hitboxes come from hitShapes(): the shared box table in shared/hitboxes.js
// placed at the entity's position, yaw and height (the server uses the same
// table). Each box's `part` ('head', 'body', 'legs') picks the damage.

let nextId = 1;

export class Entity {
  constructor(game, { name = 'Entity', team = 'neutral', maxHealth = 100, radius = 0.35, height = 1.8 } = {}) {
    this.id = nextId++;
    this.game = game;
    this.name = name;
    this.team = team;
    this.maxHealth = maxHealth;
    this.health = maxHealth;
    this.radius = radius;
    this.height = height;
    this.position = new THREE.Vector3();
    this.trail = [new THREE.Vector3()]; // positions through the last tick (replayed when drawing)
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.alive = true;
    this.yaw = 0;
  }

  get eyePosition() {
    return new THREE.Vector3(this.position.x, this.position.y + this.height - 0.15, this.position.z);
  }

  get chestPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + this.height * 0.65, this.position.z);
  }

  // Where tracers start. Overridden by things that hold a visible gun.
  getMuzzlePosition() {
    return this.eyePosition;
  }

  hitShapes() {
    return hitboxesAt(this.position, this.yaw, this.height);
  }

  // Facing direction (horizontal), used by backstab checks.
  forward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  takeDamage(amount, { source = null, part = 'body', weapon = null } = {}) {
    if (!this.alive) return;
    if (source && source !== this && source.team === this.team) return; // no friendly fire
    this.health = Math.max(0, this.health - amount);
    this.game.events.emit('damage', { target: this, source, amount, part, weapon });
    if (this.health <= 0) this.die({ source, part, weapon });
  }

  die({ source = null, part = 'body', weapon = null } = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.onDeath();
    this.game.events.emit('death', { victim: this, killer: source, weapon, headshot: part === 'head' });
  }

  // Called before each tick's logic runs: start a new trail from here.
  beginTick() {
    this.trail.length = 1;
    this.trail[0].copy(this.position);
  }

  // Called after each logic step: add where we are now to the trail.
  recordStep() {
    this.trail.push(this.position.clone());
  }

  // Teleports (spawning): draw at the new spot instead of sliding there.
  resetPath() {
    this.trail.length = 1;
    this.trail[0].copy(this.position);
  }

  // Where to draw this frame: `alpha` of the way along last tick's trail.
  renderPosition(alpha, out = new THREE.Vector3()) {
    const p = this.trail;
    if (p.length < 2) return out.copy(this.position);
    const f = Math.min(1, Math.max(0, alpha)) * (p.length - 1);
    const i = Math.min(p.length - 2, Math.floor(f));
    return out.lerpVectors(p[i], p[i + 1], f - i);
  }

  // Footsteps and landings, called after moving each logic step.
  //   quiet   - walking / crouching: no footstep sound or noise at all
  //   volume  - loudness of the steps that do sound (0..1)
  //   wasOnGround / fallSpeed - state before this step's move (for landings)
  // Emits 'footstep' (sound) and 'noise' (bots can hear it).
  footsteps(dt, { quiet = false, volume = 1, wasOnGround = true, fallSpeed = 0, stride = 2.3, noiseRadius = 14 } = {}) {
    const ev = this.game.events;
    if (!wasOnGround && this.onGround && fallSpeed > 4) {
      const position = this.position.clone();
      ev.emit('footstep', { entity: this, position, heavy: true, volume: quiet ? 0.35 : volume });
      ev.emit('noise', { position, radius: quiet ? 3 : 11, source: this, kind: 'land' });
      this.stepDist = 0;
      return;
    }
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.onGround || speed < 1) {
      this.stepDist = stride * 0.6; // first step comes soon after starting
      return;
    }
    this.stepDist = (this.stepDist ?? stride * 0.6) + speed * dt;
    if (this.stepDist < stride) return;
    this.stepDist -= stride;
    this.foot = -(this.foot || 1);
    if (quiet) return;
    const position = this.position.clone();
    ev.emit('footstep', { entity: this, position, foot: this.foot, volume });
    ev.emit('noise', { position, radius: noiseRadius * volume, source: this, kind: 'step' });
  }

  update(_dt) {}
  frame(_dt, _alpha) {}
  onDeath() {}
  dispose() {}
}
