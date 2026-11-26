// Bomb mode's objective logic, shared by the server (online rules) and the
// client (offline practice with bots), so both play by the same rules.
//
//   carried   one attacker holds the bomb. Hold Use (E) inside a bomb site,
//             standing on the ground, for PLANT_TIME to plant it.
//   dropped   the carrier died (or left): it lies where they fell; any
//             living attacker walking over it picks it up.
//   planted   the fuse runs FUSE seconds. A defender holding Use next to it
//             for DEFUSE_TIME defuses it. Only one defuser at a time.
//   defused   defenders win the round.
//   exploded  attackers win the round; players near the blast take damage.
//
// "Players" here are anything with { team, alive, position, onGround,
// using } (ServerPlayer, Player, Bot). The owner passes in hooks:
//   emit(type, data)  'state' (a public state change) or
//                     'action' ({ player, kind: 'plant' | 'defuse' | null, duration })
//   damage(player, amount)

export const BOMB = {
  plantTime: 3.2,
  defuseTime: 6,
  fuse: 40,
  pickupRadius: 1.3, // metres, horizontal
  defuseRadius: 1.8,
  blastRadius: 24, // damage falls off to 0 here
  blastDamage: 600, // at the bomb (squared falloff: lethal within ~9 m)
};

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class BombState {
  constructor(world, hooks) {
    this.world = world;
    this.hooks = hooks;
    this.reset([]);
  }

  // New round: give the bomb to a random attacker.
  reset(attackers) {
    const list = attackers.filter((p) => p.alive);
    this.carrier = list.length ? list[Math.floor(Math.random() * list.length)] : null;
    this.state = this.carrier ? 'carried' : 'none';
    this.position = null; // { x, y, z } when dropped / planted
    this.site = null;
    this.fuseLeft = 0;
    this.action = null; // { player, kind, t }
    this.changed('round');
  }

  get planted() {
    return this.state === 'planted';
  }

  get done() {
    return this.state === 'defused' || this.state === 'exploded';
  }

  // What clients need to know. `idOf(player)` turns a player into a wire id.
  publicState(idOf = (p) => p?.id ?? 0) {
    const p = this.position;
    return {
      state: this.state,
      carrier: this.carrier ? idOf(this.carrier) : 0,
      pos: p ? [round2(p.x), round2(p.y), round2(p.z)] : null,
      site: this.site,
      fuse: round2(this.fuseLeft),
    };
  }

  changed(reason, extra = {}) {
    this.hooks.emit?.('state', { reason, ...extra });
  }

  setAction(player, kind) {
    const prev = this.action;
    if (prev && prev.player === player && prev.kind === kind) return;
    if (prev) this.hooks.emit?.('action', { player: prev.player, kind: null });
    this.action = kind ? { player, kind, t: 0 } : null;
    if (kind) this.hooks.emit?.('action', { player, kind, duration: kind === 'plant' ? BOMB.plantTime : BOMB.defuseTime });
  }

  // Force a drop (carrier disconnected).
  drop(player) {
    if (this.state !== 'carried' || this.carrier !== player) return;
    if (this.action?.player === player) this.setAction(null, null);
    this.state = 'dropped';
    this.position = { x: player.position.x, y: player.position.y, z: player.position.z };
    this.carrier = null;
    this.changed('dropped');
  }

  // One step. `players` = everyone; `attack` = the attacking team's id.
  update(dt, players, attack) {
    if (this.done || this.state === 'none') return;

    if (this.state === 'carried') {
      const c = this.carrier;
      if (!c || !c.alive) {
        this.drop(c);
        return;
      }
      const site = this.world.siteAt(c.position);
      if (c.using && c.onGround && site) {
        this.setAction(c, 'plant');
        this.action.t += dt;
        if (this.action.t >= BOMB.plantTime) {
          this.setAction(null, null);
          this.state = 'planted';
          this.carrier = null;
          this.position = { x: c.position.x, y: c.position.y, z: c.position.z };
          this.site = site;
          this.fuseLeft = BOMB.fuse;
          this.changed('planted', { by: c });
        }
      } else if (this.action) this.setAction(null, null);
      return;
    }

    if (this.state === 'dropped') {
      const p = this.position;
      const taker = players.find((q) => q.alive && q.team === attack && flat(q.position, p) < BOMB.pickupRadius && Math.abs(q.position.y - p.y) < 1.2);
      if (taker) {
        this.state = 'carried';
        this.carrier = taker;
        this.position = null;
        this.changed('pickup', { by: taker });
      }
      return;
    }

    // Planted: defuse, or the fuse runs out.
    const near = (q) => q.alive && q.team !== attack && q.using && q.onGround && flat(q.position, this.position) < BOMB.defuseRadius && Math.abs(q.position.y - this.position.y) < 1.5;
    let a = this.action;
    if (a && !near(a.player)) {
      this.setAction(null, null);
      a = null;
    }
    if (!a) {
      const d = players.find(near);
      if (d) {
        this.setAction(d, 'defuse');
        a = this.action;
      }
    }
    if (a) {
      a.t += dt;
      if (a.t >= BOMB.defuseTime) {
        this.setAction(null, null);
        this.state = 'defused';
        this.changed('defused', { by: a.player });
        return;
      }
    }
    this.fuseLeft -= dt;
    if (this.fuseLeft <= 0) {
      this.fuseLeft = 0;
      if (this.action) this.setAction(null, null);
      this.state = 'exploded';
      for (const q of players) {
        if (!q.alive) continue;
        const d = Math.hypot(q.position.x - this.position.x, q.position.y - this.position.y, q.position.z - this.position.z);
        if (d >= BOMB.blastRadius) continue;
        const k = 1 - d / BOMB.blastRadius;
        this.hooks.damage?.(q, BOMB.blastDamage * k * k);
      }
      this.changed('exploded');
    }
  }

  // Progress 0..1 of the current plant / defuse.
  get progress() {
    const a = this.action;
    if (!a) return 0;
    return Math.min(1, a.t / (a.kind === 'plant' ? BOMB.plantTime : BOMB.defuseTime));
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
