import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { Weapon } from '../../src/weapons/Weapon.js';
import { WEAPONS } from '../../src/weapons/definitions.js';
import { eyeOf } from '../../src/shared/pawn.js';
import { HISTORY_TICKS, CMD_BURST } from '../../src/shared/net.js';
import { FLAG } from '../../src/shared/protocol.js';

// A player as the server sees it: the same "pawn" fields the client's
// Player has (so shared/pawn.js runs identically), plus networking state
// and a short history of positions for lag compensation.

export class ServerPlayer {
  constructor(sim, { id, uid, name, team }) {
    this.sim = sim;
    this.id = id; // small number used on the wire
    this.uid = uid;
    this.name = name;
    this.team = team;
    this.ws = null;
    this.connected = false;
    this.disconnectedAt = 0;

    const cfg = CONFIG.player;
    this.radius = cfg.radius;
    this.height = cfg.height;
    this.maxHealth = cfg.maxHealth;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.crouching = false;
    this.yaw = 0;
    this.pitch = 0;
    this.ads = 0;
    this.frozen = false;
    this.alive = false;
    this.health = 0;
    this.weapons = cfg.loadout.map((wid) => new Weapon(WEAPONS[wid]));
    this.weaponIndex = 0;
    this.lastWeaponIndex = 0;

    this.spawnId = 0;
    this.lastSeq = 0; // last command processed (acknowledged in snapshots)
    this.budget = CMD_BURST; // commands it may still run (anti speed-hack)
    this.budgetTime = null;
    this.dropped = 0; // commands refused for arriving faster than real time
    this.quiet = false; // walking / crouching (no footsteps)
    this.protectedUntil = 0; // tick; spawn protection
    this.respawnAt = 0; // tick; TDM
    this.history = new Array(HISTORY_TICKS).fill(null);
    this.ping = 0;
    this.kills = 0;
    this.deaths = 0;

    this.hooks = {
      moved: (r) => (this.quiet = r.quiet),
      fired: () => (this.protectedUntil = 0), // shooting ends spawn protection
    };
  }

  get weapon() {
    return this.weapons[this.weaponIndex];
  }

  get eyePosition() {
    return eyeOf(this);
  }

  forward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  get isProtected() {
    return this.sim.tick < this.protectedUntil;
  }

  spawn(position, yaw, { frozen = false, protection = 0 } = {}) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.crouching = false;
    this.height = CONFIG.player.height;
    this.yaw = yaw;
    this.pitch = 0;
    this.alive = true;
    this.health = this.maxHealth;
    this.frozen = frozen;
    for (const w of this.weapons) w.reset();
    this.weaponIndex = 0;
    this.lastWeaponIndex = 0;
    this.spawnId = (this.spawnId + 1) & 255;
    this.protectedUntil = this.sim.tick + Math.round(protection * this.sim.tickRate);
    this.respawnAt = 0;
    this.history.fill(null); // no rewinding into the previous life
  }

  // Weapon.fire / swing call this. The match decides what happens.
  takeDamage(amount, info) {
    this.sim.damage(this, amount, info);
  }

  flags() {
    let f = 0;
    if (this.alive) f |= FLAG.ALIVE;
    if (this.onGround) f |= FLAG.GROUND;
    if (this.crouching) f |= FLAG.CROUCH;
    if (this.quiet) f |= FLAG.QUIET;
    if (this.isProtected) f |= FLAG.PROTECTED;
    if (this.frozen) f |= FLAG.FROZEN;
    return f;
  }

  // End of each server tick: remember where we were (for lag compensation).
  record(tick) {
    this.history[tick % HISTORY_TICKS] = {
      tick,
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      height: this.height,
      alive: this.alive,
    };
  }

  // Where we were at fractional tick `t` (as the shooter saw us), or null.
  stateAt(t) {
    const t0 = Math.floor(t);
    const a = this.history[t0 % HISTORY_TICKS];
    if (!a || a.tick !== t0) return null;
    const b = this.history[(t0 + 1) % HISTORY_TICKS];
    if (!b || b.tick !== t0 + 1) return a;
    const f = t - t0;
    if (!b.alive) return a;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      yaw: a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * f,
      height: f < 0.5 ? a.height : b.height,
      alive: a.alive,
    };
  }

  info() {
    return { id: this.id, name: this.name, team: this.team, kills: this.kills, deaths: this.deaths, ping: this.ping, connected: this.connected, dropped: this.dropped };
  }
}
