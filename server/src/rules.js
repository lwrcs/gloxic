import * as THREE from 'three';

// Mode rules: how a match flows (rounds, respawns, scoring, winning).
// Each mode is a class with the same hooks, so adding a mode means adding a
// class here and an entry in src/shared/modes.js:
//   start()                  match begins (after everyone connected / warmup)
//   update()                 every tick
//   onDeath(victim, killer)  someone died
//   onLeave(player)          someone disconnected
// Rules talk to the sim through: sim.setPhase, sim.spawn, sim.end, sim.score.

const TEAMS = ['blue', 'red'];

class Rules {
  constructor(sim, mode) {
    this.sim = sim;
    this.mode = mode;
  }

  ticks(seconds) {
    return Math.round(seconds * this.sim.tickRate);
  }

  teamPlayers(team) {
    return this.sim.playerList().filter((p) => p.team === team);
  }

  // A team with nobody connected for 30 s forfeits.
  checkForfeit() {
    const sim = this.sim;
    for (const team of TEAMS) {
      const members = this.teamPlayers(team);
      if (!members.length) continue;
      const gone = members.every((p) => !p.connected && sim.tick - p.disconnectedAt > this.ticks(30));
      if (gone) {
        sim.end(TEAMS.find((t) => t !== team), 'The other team left');
        return true;
      }
    }
    return false;
  }

  update() {}
  onDeath() {}
  onLeave() {}
}

// 1v1: rounds, one life each, first to `roundsToWin`.
export class DuelRules extends Rules {
  start() {
    this.round = 0;
    this.nextRound();
  }

  nextRound() {
    const sim = this.sim;
    this.round++;
    for (const p of sim.playerList()) sim.spawn(p, sim.teamSpawn(p.team), { frozen: true });
    sim.setPhase('freeze', this.mode.freezeTime, { round: this.round });
  }

  update() {
    const sim = this.sim;
    if (this.checkForfeit()) return;
    if (sim.phaseOver()) {
      if (sim.phase === 'freeze') {
        for (const p of sim.playerList()) p.frozen = false;
        sim.setPhase('live', this.mode.roundTime, { round: this.round });
      } else if (sim.phase === 'live') {
        // Time's up: more health left wins the round; equal is a draw.
        const hp = (team) => this.teamPlayers(team).reduce((s, p) => s + (p.alive ? p.health : 0), 0);
        const blue = hp('blue');
        const red = hp('red');
        this.roundOver(blue === red ? null : blue > red ? 'blue' : 'red', 'Time ran out');
      } else if (sim.phase === 'roundEnd') {
        if (this.winner) sim.end(this.winner, `First to ${this.mode.roundsToWin}`);
        else this.nextRound();
      }
    }
  }

  onDeath(victim) {
    if (this.sim.phase !== 'live') return;
    const alive = this.teamPlayers(victim.team).some((p) => p.alive);
    if (!alive) this.roundOver(TEAMS.find((t) => t !== victim.team), 'Eliminated');
  }

  roundOver(team, reason) {
    const sim = this.sim;
    if (team) sim.score[team]++;
    this.winner = team && sim.score[team] >= this.mode.roundsToWin ? team : null;
    sim.setPhase('roundEnd', this.mode.roundEndTime, { round: this.round, roundWinner: team, reason });
  }
}

// Team deathmatch: respawns, first team to `scoreLimit` kills or most kills
// when time runs out.
export class TdmRules extends Rules {
  start() {
    const sim = this.sim;
    for (const p of sim.playerList()) sim.spawn(p, sim.teamSpawn(p.team), { frozen: true });
    sim.setPhase('freeze', this.mode.freezeTime);
  }

  update() {
    const sim = this.sim;
    if (this.checkForfeit()) return;
    if (sim.phase === 'freeze' && sim.phaseOver()) {
      for (const p of sim.playerList()) p.frozen = false;
      sim.setPhase('live', this.mode.timeLimit);
      return;
    }
    if (sim.phase !== 'live') return;
    if (sim.phaseOver()) {
      const { blue, red } = sim.score;
      sim.end(blue === red ? null : blue > red ? 'blue' : 'red', 'Time ran out');
      return;
    }
    for (const p of sim.playerList()) {
      if (!p.alive && p.respawnAt && sim.tick >= p.respawnAt) {
        sim.spawn(p, sim.safeSpawn(p), { protection: this.mode.spawnProtection });
      }
    }
  }

  onDeath(victim, killer) {
    const sim = this.sim;
    if (sim.phase !== 'live') return;
    if (killer && killer !== victim && killer.team !== victim.team) sim.score[killer.team]++;
    victim.respawnAt = sim.tick + this.ticks(this.mode.respawnTime);
    if (killer && sim.score[killer.team] >= this.mode.scoreLimit) sim.end(killer.team, `First to ${this.mode.scoreLimit}`);
  }
}

export function createRules(sim, mode) {
  return mode.id === 'duel' ? new DuelRules(sim, mode) : new TdmRules(sim, mode);
}

// Spawn scoring for respawns: far from living enemies, and out of their sight.
export function spawnScore(point, enemies, world) {
  let score = 0;
  let nearest = Infinity;
  const eye = new THREE.Vector3(point.x, 1.6, point.z);
  for (const e of enemies) {
    const d = e.position.distanceTo(point);
    nearest = Math.min(nearest, d);
    if (d < 40 && world.hasLineOfSight(eye, e.eyePosition)) score -= 100;
  }
  return score + Math.min(nearest, 40);
}
