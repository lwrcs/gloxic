import * as THREE from 'three';
import { MapGeometry } from '../../src/shared/MapGeometry.js';
import { hitboxesAt } from '../../src/shared/hitboxes.js';
import { castRay } from '../../src/shared/raycast.js';
import { runCmd } from '../../src/shared/pawn.js';
import { MODES } from '../../src/shared/modes.js';
import { TICK_RATE, SNAPSHOT_EVERY, MAX_REWIND, CMD_BURST } from '../../src/shared/net.js';
import { MSG, decodeCmds, decodePing, encodePong, encodeSnapshot } from '../../src/shared/protocol.js';
import boxyard from '../../src/world/maps/boxyard.js';
import { ServerPlayer } from './ServerPlayer.js';
import { createRules, spawnScore } from './rules.js';

// The authoritative match simulation. Independent of Cloudflare APIs (the
// Match Durable Object feeds it sockets, messages and time), so it can be
// tested in plain Node.
//
// Per player, commands are run as they arrive (like Source): the player
// moves in "their own time", so there's no server-side input delay. Every
// tick the server then records everyone's position for lag compensation,
// runs the mode rules and sends each client a snapshot.

const MAPS = { boxyard };
const MAX_REWIND_TICKS = Math.round(MAX_REWIND * TICK_RATE);
const PITCH_LIMIT = Math.PI / 2 - 0.01;
// Messages per second a client may send (it sends ~64 command messages plus
// a ping or two); beyond the burst the connection is closed. Commands are
// separately limited to real time by the command budget.
const MSG_RATE = 200;
const MSG_BURST = 400;
const has = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);
const r2 = (n) => Math.round(n * 100) / 100;

export class Sim {
  constructor(config, { onEnd } = {}) {
    this.config = config;
    this.mode = has(MODES, config.mode) ? MODES[config.mode] : MODES.duel;
    this.world = new MapGeometry(has(MAPS, config.map) ? MAPS[config.map] : boxyard);
    this.tickRate = TICK_RATE;
    this.tickMs = 1000 / TICK_RATE;
    this.tick = 0;
    this.players = new Map(); // uid -> ServerPlayer
    config.roster.forEach((r, i) => this.players.set(r.uid, new ServerPlayer(this, { id: i + 1, ...r })));
    this.score = { blue: 0, red: 0 };
    this.phase = 'waiting';
    this.phaseEnd = 0;
    this.phaseInfo = {};
    this.rules = createRules(this, this.mode);
    this.rewindTick = 0;
    this.ended = false;
    this.finished = false;
    this.result = null;
    this.onEnd = onEnd;
    this.colo = '?';
    this.lastConnectedTick = 0;
    this.allConnectedAt = 0;
    // What weapons see as "the game": raycasts are lag-compensated.
    this.ctx = {
      world: this.world,
      raycast: (o, d, far, ignore) => this.lagRaycast(o, d, far, ignore),
      events: { emit: (type, e) => type === 'shot' && this.onShot(e) },
    };
  }

  playerList() {
    return [...this.players.values()];
  }

  // ---------- connections ----------

  connect(uid, ws) {
    const p = this.players.get(uid);
    if (!p) return null;
    if (p.ws && p.ws !== ws) {
      try {
        p.ws.close(4000, 'Joined from another tab');
      } catch {
        /* already closed */
      }
    }
    p.ws = ws;
    p.connected = true;
    p.budget = CMD_BURST;
    p.budgetTime = null;
    p.lastSeq = 0; // a new connection numbers its commands from 1 again
    p.msgTokens = MSG_BURST;
    p.msgTime = Date.now();
    if (this.phase === 'waiting' && !p.alive) this.spawn(p, this.teamSpawn(p.team));
    this.send(p, {
      ...this.phaseMessage(),
      t: 'welcome',
      you: p.id,
      team: p.team,
      mode: this.mode.id,
      map: this.config.map,
      region: this.config.region,
      colo: this.colo,
      tick: this.tick,
      tickRate: this.tickRate,
      players: this.playerList().map((q) => q.info()),
    });
    this.broadcastPlayers();
    return p;
  }

  disconnect(uid, ws) {
    const p = this.players.get(uid);
    if (!p || p.ws !== ws) return;
    p.ws = null;
    p.connected = false;
    p.disconnectedAt = this.tick;
    this.broadcastPlayers();
    this.rules.onLeave(p);
  }

  send(p, obj) {
    if (!p.ws) return;
    try {
      p.ws.send(typeof obj === 'string' || obj instanceof ArrayBuffer ? obj : JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }

  broadcast(obj, except = null) {
    const msg = JSON.stringify(obj);
    for (const p of this.players.values()) if (p !== except) this.send(p, msg);
  }

  broadcastPlayers() {
    this.broadcast({ t: 'players', players: this.playerList().map((p) => p.info()), score: this.score });
  }

  // ---------- messages ----------

  onMessage(uid, ws, data) {
    const p = this.players.get(uid);
    if (!p || p.ws !== ws) return;
    const now = Date.now();
    p.msgTokens = Math.min(MSG_BURST, p.msgTokens + ((now - p.msgTime) / 1000) * MSG_RATE);
    p.msgTime = now;
    if (p.msgTokens < 1) return ws.close(1008, 'Too many messages');
    p.msgTokens -= 1;
    if (typeof data === 'string') return; // no text messages from clients yet (chat would go here)
    if (data.byteLength > 1024 || data.byteLength < 1) return ws.close(1009, 'Message too large');
    const v = new DataView(data);
    switch (v.getUint8(0)) {
      case MSG.CMDS: {
        const cmds = decodeCmds(v);
        if (!cmds) return ws.close(1008, 'Bad command');
        this.runCmds(p, cmds);
        break;
      }
      case MSG.PING: {
        const ping = decodePing(v);
        if (!ping) return;
        p.ping = ping.rtt;
        const sinceTick = Math.min(1, (Date.now() - (this.lastTime ?? Date.now())) / this.tickMs);
        this.send(p, encodePong(ping.clientTime, this.tick + Math.max(0, sinceTick)));
        break;
      }
    }
  }

  runCmds(p, cmds) {
    // Commands earned by real time passing (not by ticks, so a stalled timer
    // can't starve honest players).
    const now = Date.now();
    p.budget = Math.min(CMD_BURST, p.budget + (now - (p.budgetTime ?? now)) / this.tickMs);
    p.budgetTime = now;
    for (const c of cmds) {
      if (c.seq <= p.lastSeq) continue; // duplicate
      p.lastSeq = c.seq;
      // Faster than real time (speed hack, or a burst beyond the bank): drop.
      if (p.budget < 1) {
        p.dropped++;
        continue;
      }
      p.budget -= 1;
      // Sent before the client saw its respawn: belongs to the old life.
      if (c.spawnId !== p.spawnId) continue;
      if (!(c.slot < p.weapons.length)) c.slot = p.weaponIndex;
      c.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, c.pitch));
      // Lag compensation: trace against where others were on the shooter's screen.
      this.rewindTick = Math.max(this.tick - MAX_REWIND_TICKS, Math.min(this.tick, c.viewTick));
      runCmd(p, c, 1 / this.tickRate, this.ctx, p.hooks);
    }
  }

  // ---------- simulation ----------

  // Runs however many ticks are due by `now` (ms).
  advance(now) {
    this.lastTime ??= now;
    let n = 0;
    while (now - this.lastTime >= this.tickMs && n < 8) {
      this.lastTime += this.tickMs;
      this.step();
      n++;
    }
    if (now - this.lastTime > 250) this.lastTime = now; // stalled: don't fast-forward
  }

  step() {
    this.tick++;
    const players = this.playerList();
    const connected = players.filter((p) => p.connected).length;
    if (connected) this.lastConnectedTick = this.tick;

    if (this.phase === 'waiting') {
      // Start once everyone is in (or 20 s after the first, if someone never shows).
      const all = connected === players.length;
      if (all && !this.allConnectedAt) this.allConnectedAt = this.tick;
      const firstIn = players.some((p) => p.connected || p.disconnectedAt);
      if ((all && this.tick - this.allConnectedAt > TICK_RATE) || (firstIn && this.tick > 20 * TICK_RATE)) this.rules.start();
    } else if (this.phase === 'ended') {
      if (this.phaseOver()) this.finish();
    } else {
      this.rules.update();
    }
    // Abandoned: nobody connected for a minute.
    if (!this.finished && this.tick - this.lastConnectedTick > 60 * TICK_RATE) {
      if (!this.ended) this.end(null, 'Everyone left');
      this.finish();
    }

    for (const p of players) p.record(this.tick);
    if (this.tick % SNAPSHOT_EVERY === 0) this.sendSnapshots(players);
    if (this.tick % TICK_RATE === 0) this.broadcastPlayers();
  }

  sendSnapshots(players) {
    const states = players.map((p) => ({
      p,
      id: p.id,
      position: p.position,
      yaw: p.yaw,
      pitch: p.pitch,
      flags: p.flags(),
      slot: p.weaponIndex,
      health: p.health,
    }));
    for (const me of players) {
      if (!me.ws) continue;
      const w = me.weapon;
      const self = {
        flags: me.flags(),
        spawnId: me.spawnId,
        position: me.position,
        velocity: me.velocity,
        health: me.health,
        slot: me.weaponIndex,
        ammo: w.ammo,
        reserve: w.reserve,
        reload: Math.max(0, w.reloadTimer),
      };
      // Enemy health isn't sent (only whether they're alive).
      const others = states.filter((s) => s.p !== me).map((s) => (s.p.team === me.team ? s : { ...s, health: 0 }));
      this.send(me, encodeSnapshot(this.tick, me.lastSeq, self, others));
    }
  }

  // Hitscan with everyone else rewound to `this.rewindTick`.
  lagRaycast(origin, dir, far, ignore) {
    const bodies = [];
    for (const q of this.players.values()) {
      if (q === ignore || !q.alive) continue;
      const s = q.stateAt(this.rewindTick) ?? { ...q.position, yaw: q.yaw, height: q.height, alive: true };
      if (!s.alive) continue;
      bodies.push({ entity: q, shapes: hitboxesAt(s, s.yaw, s.height) });
    }
    return castRay(origin, dir, far, this.world.colliders, bodies);
  }

  // Tell everyone else about a shot so they see the tracer and hear it.
  onShot({ owner, weapon, origin, pellets, melee, backstab }) {
    this.broadcast(
      {
        t: 'shot',
        id: owner.id,
        w: weapon.id,
        o: [r2(origin.x), r2(origin.y), r2(origin.z)],
        p: pellets.map(({ direction, hit }) => {
          if (!hit) {
            const end = origin.clone().addScaledVector(direction, weapon.range);
            return [r2(end.x), r2(end.y), r2(end.z), 0];
          }
          const n = hit.normal;
          return [r2(hit.point.x), r2(hit.point.y), r2(hit.point.z), hit.entity ? 2 : 1, r2(n.x), r2(n.y), r2(n.z)];
        }),
        melee: !!melee,
        backstab: !!backstab,
      },
      owner,
    );
  }

  damage(victim, amount, { source = null, part = 'body', weapon = null } = {}) {
    if (this.phase !== 'live' && this.phase !== 'freeze') return;
    if (!victim.alive || victim.isProtected || amount <= 0) return;
    if (source && source !== victim && source.team === victim.team) return; // no friendly fire
    victim.health = Math.max(0, victim.health - amount);
    const shown = Math.round(amount * 10) / 10;
    if (source) this.send(source, { t: 'hit', target: victim.id, amount: shown, part });
    this.send(victim, { t: 'hurt', from: source?.id ?? 0, amount: shown, part });
    if (victim.health > 0) return;
    victim.alive = false;
    victim.deaths++;
    if (source && source !== victim) source.kills++;
    this.broadcast({ t: 'kill', killer: source?.id ?? 0, victim: victim.id, w: weapon?.id ?? null, head: part === 'head', backstab: part === 'backstab' });
    this.rules.onDeath(victim, source);
    this.broadcastPlayers();
  }

  // ---------- phases, spawning, ending (used by rules) ----------

  setPhase(phase, seconds, info = {}) {
    this.phase = phase;
    this.phaseEnd = this.tick + Math.round(seconds * TICK_RATE);
    this.phaseInfo = info;
    this.broadcast(this.phaseMessage());
  }

  phaseMessage() {
    return { t: 'phase', phase: this.phase, endsIn: Math.max(0, (this.phaseEnd - this.tick) / TICK_RATE), score: this.score, ...this.phaseInfo };
  }

  phaseOver() {
    return this.tick >= this.phaseEnd;
  }

  spawn(p, point, opts) {
    // Face the middle of the map.
    const yaw = Math.atan2(point.x, point.z);
    p.spawn(point, yaw, opts);
  }

  // A free spawn point of the team's (not on top of someone).
  teamSpawn(team) {
    const points = [...this.world.getSpawns(team)].sort(() => Math.random() - 0.5);
    const free = points.find((pt) => this.playerList().every((q) => !q.alive || q.position.distanceTo(pt) > 1.5));
    return (free ?? points[0]).clone();
  }

  // Respawn point away from (and hidden from) living enemies.
  safeSpawn(p) {
    const enemies = this.playerList().filter((q) => q.alive && q.team !== p.team);
    const candidates = [...this.world.getSpawns(p.team)];
    for (let i = 0; i < 16; i++) {
      const pt = this.world.randomOpenPoint();
      if (pt) candidates.push(pt);
    }
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const s = spawnScore(c, enemies, this.world) + Math.random();
      if (s > bestScore) [best, bestScore] = [c, s];
    }
    return new THREE.Vector3().copy(best);
  }

  end(winner, reason) {
    if (this.ended) return;
    this.ended = true;
    this.result = { winner, reason, score: { ...this.score }, mode: this.mode.id, players: this.playerList().map((p) => p.info()) };
    for (const p of this.players.values()) p.frozen = true;
    this.setPhase('ended', 8, { winner, reason });
    this.broadcast({ t: 'end', ...this.result });
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.onEnd?.(this.result ?? { winner: null, reason: 'Ended', score: this.score, mode: this.mode.id, players: [] });
  }
}
