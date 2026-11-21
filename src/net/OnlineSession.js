import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { wsUrl } from './api.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { WEAPONS } from '../weapons/definitions.js';
import { BTN, stepMove } from '../shared/pawn.js';
import { MODES } from '../shared/modes.js';
import { TICK_RATE, SNAPSHOT_EVERY, INTERP_MIN_TICKS, INTERP_MAX_TICKS } from '../shared/net.js';
import { MSG, FLAG, encodeCmds, encodePing, decodeSnapshot, decodePong } from '../shared/protocol.js';

// An online match, client side. Three jobs:
//
// 1. Prediction (your player). Each tick Player builds a command and runs it
//    locally at once (no input lag), and it's sent here. We keep commands
//    the server hasn't acknowledged. Each snapshot says the last command the
//    server ran and where that left you; if it differs from what we
//    predicted, we reset to the server's state, replay the newer commands,
//    and blend the visual difference out (Player.applyCorrection).
//
// 2. Interpolation (everyone else). Snapshots are buffered and other players
//    are drawn at `renderTick`, a little behind the newest snapshot so
//    there's always a pair to blend between. The delay adapts to measured
//    jitter: steady connections get ~2 ticks (31 ms), jittery ones more.
//
// 3. Lag compensation input. Commands carry `viewTick` (= renderTick), the
//    moment you were looking at; the server rewinds hitboxes to it.
//
// Also turns server events (shots, hits, kills, phases) into the same game
// events practice mode uses, so effects, HUD and damage numbers just work.

const SNAP_BUFFER = 128; // snapshots kept (2 s)

export class OnlineSession {
  constructor(game, player, { matchId, ticket, region, lobbyCode, onEnd, onClose }) {
    this.online = true;
    this.game = game;
    this.player = player;
    this.region = region;
    this.lobbyCode = lobbyCode;
    this.onEnd = onEnd;
    this.onClose = onClose;
    this.mode = null;
    this.myId = 0;
    this.infos = new Map(); // id -> { id, name, team, kills, deaths, ping, connected }
    this.remotes = new Map(); // id -> RemotePlayer
    this.snaps = []; // { tick, states: Map(id -> state) }
    this.pending = []; // unacknowledged commands { cmd, frozen, after }
    this.score = { blue: 0, red: 0 };
    this.phase = 'connecting';
    this.phaseInfo = {};
    this.phaseEndsAt = 0;
    this.result = null;
    this.colo = '';

    // Clock: serverTick ~= nowTicks() + offset.
    this.offset = null;
    this.jitter = 1;
    this.interpTicks = 3;
    this.renderTick = 0;
    this.viewTick = 0;
    this.rtt = 0;
    this.pingTimer = 0;
    this.lastSnapTick = 0;

    // Reset the local player until the server spawns us.
    player.net = this;
    player.spawnId = -1;
    player.alive = false;
    player.viewmodel.setVisible(false);
    player.frozen = true;

    this.ws = new WebSocket(wsUrl(`/match/${matchId}/ws?t=${encodeURIComponent(ticket)}`));
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => (typeof e.data === 'string' ? this.onEvent(JSON.parse(e.data)) : this.onBinary(e.data));
    this.ws.onclose = (e) => this.closed(e);
    this.ws.onopen = () => this.sendPing();
  }

  nowTicks() {
    return (performance.now() / 1000) * TICK_RATE;
  }

  // ---------- outgoing ----------

  // Called by Player for every command it runs.
  onLocalCmd(cmd) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const p = this.player;
    this.pending.push({ cmd, frozen: p.frozen, after: this.capture() });
    if (this.pending.length > 256) this.pending.shift();
    this.ws.send(encodeCmds([cmd]));
  }

  sendPing() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodePing(performance.now(), this.rtt));
  }

  capture() {
    const p = this.player;
    return { x: p.position.x, y: p.position.y, z: p.position.z, vx: p.velocity.x, vy: p.velocity.y, vz: p.velocity.z, g: p.onGround, c: p.crouching };
  }

  // ---------- frame ----------

  // Runs before the frame's logic: advance the render clock.
  preUpdate(dt) {
    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = 1;
      this.sendPing();
    }
    if (this.offset == null) return;
    this.interpTicks = Math.min(INTERP_MAX_TICKS, Math.max(INTERP_MIN_TICKS, SNAPSHOT_EVERY + 0.5 + this.jitter * 2));
    const target = this.nowTicks() + this.offset - this.interpTicks;
    if (!this.renderTick || Math.abs(target - this.renderTick) > 16) this.renderTick = target;
    else this.renderTick += dt * TICK_RATE + (target - this.renderTick) * Math.min(1, dt * 3);
    // Never ahead of the newest snapshot (we'd have nothing to show).
    this.renderTick = Math.min(this.renderTick, this.lastSnapTick);
    this.viewTick = this.renderTick;
  }

  update() {}

  // State of player `id` at the render time (interpolated), or null.
  sample(id, t = this.renderTick) {
    const snaps = this.snaps;
    if (!snaps.length) return null;
    let b = snaps.length - 1;
    while (b > 0 && snaps[b - 1].tick >= t) b--;
    const sb = snaps[b];
    const sa = snaps[b - 1];
    const B = sb.states.get(id);
    if (!sa || t >= sb.tick) return B ?? null;
    const A = sa.states.get(id);
    if (!A || !B) return B ?? A ?? null;
    const f = Math.min(1, Math.max(0, (t - sa.tick) / (sb.tick - sa.tick)));
    // A respawn or teleport between snapshots: don't slide across the map.
    const jump = Math.hypot(B.position.x - A.position.x, B.position.z - A.position.z) > 3;
    if (jump || (A.flags & FLAG.ALIVE) !== (B.flags & FLAG.ALIVE)) return f < 0.5 ? A : B;
    return {
      position: {
        x: A.position.x + (B.position.x - A.position.x) * f,
        y: A.position.y + (B.position.y - A.position.y) * f,
        z: A.position.z + (B.position.z - A.position.z) * f,
      },
      yaw: A.yaw + Math.atan2(Math.sin(B.yaw - A.yaw), Math.cos(B.yaw - A.yaw)) * f,
      pitch: A.pitch + (B.pitch - A.pitch) * f,
      flags: f < 0.5 ? A.flags : B.flags,
      slot: B.slot,
      health: B.health,
    };
  }

  // ---------- incoming ----------

  onBinary(buf) {
    const v = new DataView(buf);
    const type = v.getUint8(0);
    if (type === MSG.SNAP) this.onSnapshot(decodeSnapshot(v));
    else if (type === MSG.PONG) {
      const { clientTime } = decodePong(v);
      this.rtt = performance.now() - clientTime;
    }
  }

  onSnapshot(s) {
    // Clock: a smoothed estimate of server tick vs our clock, plus jitter.
    const sample = s.tick - this.nowTicks();
    if (this.offset == null || Math.abs(sample - this.offset) > 32) {
      this.offset = sample;
    } else {
      const diff = sample - this.offset;
      this.offset += diff * 0.05;
      this.jitter += (Math.abs(diff) - this.jitter) * 0.05;
    }
    if (s.tick <= this.lastSnapTick) return; // stale
    this.lastSnapTick = s.tick;

    const states = new Map();
    for (const o of s.others) {
      states.set(o.id, o);
      if (!this.remotes.has(o.id) && this.infos.has(o.id)) this.addRemote(this.infos.get(o.id));
    }
    this.snaps.push({ tick: s.tick, states });
    if (this.snaps.length > SNAP_BUFFER) this.snaps.shift();

    this.reconcile(s.ackSeq, s.self);
  }

  reconcile(ack, self) {
    const p = this.player;
    const alive = !!(self.flags & FLAG.ALIVE);
    p.health = self.health;
    p.frozen = !!(self.flags & FLAG.FROZEN);

    // New life: spawn where the server put us.
    if (self.spawnId !== p.spawnId) {
      if (!alive) return; // the snapshot right before the spawn lands
      p.spawnId = self.spawnId;
      const pos = new THREE.Vector3(self.position.x, self.position.y, self.position.z);
      p.spawn(pos, Math.atan2(pos.x, pos.z)); // same facing rule as the server
      p.frozen = !!(self.flags & FLAG.FROZEN);
      this.pending = [];
      return;
    }
    if (!alive) {
      if (p.alive) this.killLocal();
      this.pending = [];
      return;
    }

    // Drop acknowledged commands; check the prediction for the acked one.
    let acked = null;
    while (this.pending.length && this.pending[0].cmd.seq <= ack) acked = this.pending.shift();
    // Nothing newly acknowledged: with nothing in flight, compare against
    // where we are now; otherwise wait for the next ack.
    if (!acked && this.pending.length) return;
    const a = acked?.after ?? this.capture();
    const sp = self.position;
    const sv = self.velocity;
    const onGround = !!(self.flags & FLAG.GROUND);
    const crouching = !!(self.flags & FLAG.CROUCH);
    const close =
      a &&
      Math.abs(a.x - sp.x) < 1e-3 && Math.abs(a.y - sp.y) < 1e-3 && Math.abs(a.z - sp.z) < 1e-3 &&
      Math.abs(a.vx - sv.x) < 1e-2 && Math.abs(a.vy - sv.y) < 1e-2 && Math.abs(a.vz - sv.z) < 1e-2 &&
      a.g === onGround && a.c === crouching;
    if (!close) {
      // Mispredicted: take the server's state and replay what it hasn't seen yet.
      const before = p.position.clone();
      p.position.set(sp.x, sp.y, sp.z);
      p.velocity.set(sv.x, sv.y, sv.z);
      p.onGround = onGround;
      p.crouching = crouching;
      p.height = crouching ? CONFIG.player.crouchHeight : CONFIG.player.height;
      const frozen = p.frozen;
      const dt = 1 / TICK_RATE;
      for (const e of this.pending) {
        p.frozen = e.frozen;
        stepMove(p, e.cmd.buttons, e.cmd.yaw, dt, this.game.world.colliders);
        e.after = this.capture();
      }
      p.frozen = frozen;
      p.applyCorrection(before.sub(p.position));
      this.corrections = (this.corrections ?? 0) + 1;
    }

    // Weapon: trust the server once nothing unacknowledged touches it.
    const busy = this.pending.some((e) => e.cmd.buttons & (BTN.FIRE | BTN.FIRE_PRESS | BTN.RELOAD) || e.cmd.slot !== self.slot);
    if (!busy) {
      if (p.weaponIndex !== self.slot && p.weapons[self.slot]) {
        p.weaponIndex = self.slot;
        p.viewmodel.setWeapon(p.weapon.def);
      }
      const w = p.weapon;
      if (!w.reloading && self.reload === 0) {
        w.ammo = self.ammo;
        w.reserve = self.reserve;
      }
    }
  }

  killLocal() {
    const p = this.player;
    p.alive = false;
    p.health = 0;
    p.deathTime = 0;
    p.onDeath();
  }

  entity(id) {
    return id === this.myId ? this.player : this.remotes.get(id) ?? null;
  }

  addRemote(info) {
    const r = new RemotePlayer(this.game, this, info);
    this.remotes.set(info.id, r);
    this.game.addEntity(r);
  }

  setInfos(list) {
    for (const info of list) {
      this.infos.set(info.id, info);
      if (info.id === this.myId) continue;
      const r = this.remotes.get(info.id);
      if (r) r.setInfo(info);
      else this.addRemote(info);
    }
  }

  onEvent(m) {
    const ev = this.game.events;
    switch (m.t) {
      case 'welcome':
        this.myId = m.you;
        this.mode = MODES[m.mode];
        this.colo = m.colo;
        this.player.team = m.team;
        this.player.name = m.players.find((p) => p.id === m.you)?.name ?? 'You';
        this.setInfos(m.players);
        this.setPhase(m);
        break;
      case 'players':
        this.setInfos(m.players);
        this.score = m.score;
        break;
      case 'phase':
        this.setPhase(m);
        break;
      case 'shot': {
        const owner = this.remotes.get(m.id);
        if (!owner) return;
        const origin = new THREE.Vector3(...m.o);
        const pellets = m.p.map(([x, y, z, kind, nx, ny, nz]) => {
          const point = new THREE.Vector3(x, y, z);
          const direction = point.clone().sub(origin).normalize();
          if (!kind) return { direction, hit: null };
          return { direction, hit: { point, normal: new THREE.Vector3(nx, ny, nz), entity: kind === 2 ? { remote: true } : null } };
        });
        ev.emit('shot', { owner, weapon: WEAPONS[m.w], origin, pellets, melee: m.melee, backstab: m.backstab });
        break;
      }
      case 'hit': {
        const target = this.remotes.get(m.target);
        if (target) ev.emit('damage', { target, source: this.player, amount: m.amount, part: m.part });
        break;
      }
      case 'hurt':
        ev.emit('damage', { target: this.player, source: this.entity(m.from), amount: m.amount, part: m.part });
        break;
      case 'kill': {
        const victim = this.entity(m.victim);
        const killer = this.entity(m.killer);
        if (victim === this.player && this.player.alive) this.killLocal();
        if (victim) ev.emit('death', { victim, killer, weapon: WEAPONS[m.w], headshot: m.head });
        break;
      }
      case 'end':
        this.result = m;
        ev.emit('announce', this.endAnnouncement(m));
        this.onEnd?.(m);
        break;
    }
  }

  setPhase(m) {
    const prev = this.phase;
    this.phase = m.phase;
    this.phaseInfo = m;
    this.score = m.score ?? this.score;
    this.phaseEndsAt = performance.now() + (m.endsIn ?? 0) * 1000;
    const ev = this.game.events;
    const team = this.player.team;
    if (m.phase === 'freeze' && prev !== 'freeze') {
      ev.emit('roundStart', { round: m.round ?? 1 });
      ev.emit('announce', { html: m.round ? `Round ${m.round}` : this.mode?.name ?? 'Get ready', seconds: 1.8 });
    } else if (m.phase === 'live' && prev === 'freeze') {
      ev.emit('announce', { html: 'Go', seconds: 0.8 });
    } else if (m.phase === 'roundEnd') {
      const won = m.roundWinner === team;
      const html = m.roundWinner ? (won ? 'Round won' : 'Round lost') : 'Round draw';
      ev.emit('announce', { html: `${html}<small>${m.reason ?? ''}</small>`, seconds: 2.8, cls: m.roundWinner ? (won ? 'win' : 'lose') : '' });
    } else if (m.phase === 'waiting') {
      ev.emit('announce', { html: 'Waiting for players<small>Warm up: damage is off</small>', seconds: 3 });
    }
  }

  endAnnouncement(m) {
    const won = m.winner === this.player.team;
    const title = m.winner ? (won ? 'Victory' : 'Defeat') : 'Draw';
    return { html: `${title}<small>${m.reason} · ${m.score.blue} - ${m.score.red}</small>`, seconds: 7.5, cls: m.winner ? (won ? 'win' : 'lose') : '' };
  }

  closed(e) {
    if (this.disposed) return;
    const reason = this.result ? 'Match over' : e.reason || (e.code === 1006 ? 'Connection lost' : 'Disconnected');
    this.onClose?.(reason, this.result);
  }

  // ---------- HUD ----------

  get timeLeft() {
    return Math.max(0, (this.phaseEndsAt - performance.now()) / 1000);
  }

  get showTimer() {
    return this.phase !== 'waiting' && this.phase !== 'connecting';
  }

  get statusText() {
    if (this.phase === 'connecting') return 'Connecting...';
    if (this.phase === 'waiting') return 'Waiting for players';
    const m = this.mode;
    if (!m) return '';
    if (m.id === 'duel') return `Round ${this.phaseInfo.round ?? 1} · first to ${m.roundsToWin}`;
    return `First to ${m.scoreLimit}`;
  }

  get pingText() {
    return `${Math.round(this.rtt)} ms${this.colo ? ` · ${this.colo}` : ''}`;
  }

  scoreboard() {
    return [...this.infos.values()]
      .map((i) => ({ ...i, me: i.id === this.myId }))
      .sort((a, b) => (a.team === b.team ? b.kills - a.kills : a.team === 'blue' ? -1 : 1));
  }

  dispose() {
    this.disposed = true;
    this.ws.onclose = null;
    if (this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000, 'left');
    for (const r of this.remotes.values()) this.game.removeEntity(r);
    this.remotes.clear();
    const p = this.player;
    p.net = null;
    p.frozen = false;
    p.spawnId = 0;
  }
}
