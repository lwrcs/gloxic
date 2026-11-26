import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { MODES } from '../shared/modes.js';
import { BombState, BOMB } from '../shared/bomb.js';
import { Bot } from '../entities/Bot.js';
import { BombView, bombObjective } from './BombView.js';

// Offline Bomb mode on Sandhollow: you and bot teammates against bots, with
// the same rules as online (shared/bomb.js, modes.bomb): one life a round,
// plant or defuse, sides swap at half, first to 7.
//
// Bot orders (re-issued twice a second; fighting always comes first):
//   attackers  the carrier heads for this round's target site and plants;
//              the others go there too; a dropped bomb gets picked up by
//              the nearest attacker; after the plant they guard the site
//   defenders  split between the sites and hold; after a plant everyone
//              goes to the bomb and the nearest one defuses

const BOT_NAMES = ['Rook', 'Viper', 'Moss', 'Dune', 'Flint', 'Ash', 'Brick', 'Echo', 'Gale', 'Onyx'];
const MAX_SIDE = 5;

export class BombPractice {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.mode = MODES.bomb;
    this.online = false;
    this.bots = [];
    this.score = { blue: 0, red: 0 };
    this.round = 0;
    this.attack = player.team; // you attack first
    this.phase = 'freeze';
    this.phaseLeft = 0;
    this.final = null;
    this.ordersTimer = 0;
    this.bombView = new BombView(game);
    this.bomb = new BombState(game.world, {
      emit: (type, e) => type === 'state' && this.onBombState(e),
      damage: (p, amount) => p.takeDamage(amount, { source: null, part: 'body' }),
    });
    player.useBlocks = true;
    this.offs = [
      game.events.on('death', () => this.checkElimination()),
      game.events.on('settingChanged', ({ name }) => {
        if (name === 'botCount' || name === 'noEnemies') this.startRound(false);
      }),
    ];
  }

  dispose() {
    for (const off of this.offs) off();
    for (const b of this.bots) this.game.removeEntity(b);
    this.bots = [];
    this.bombView.dispose();
    this.player.useBlocks = false;
    this.player.frozen = false;
  }

  get defend() {
    return this.attack === 'blue' ? 'red' : 'blue';
  }

  get role() {
    return this.player.team === this.attack ? 'attack' : 'defend';
  }

  everyone() {
    return [this.player, ...this.bots];
  }

  // ---------- rounds ----------

  start() {
    this.startRound(true);
  }

  startRound(next = true) {
    const { game, player } = this;
    const world = game.world;
    if (next) {
      this.round++;
      if (this.round === this.mode.roundsPerHalf + 1) this.attack = this.defend;
    }
    this.phase = 'freeze';
    this.phaseLeft = this.mode.freezeTime;
    this.targetSite = Math.random() < 0.5 ? 'A' : 'B';

    for (const b of this.bots) game.removeEntity(b);
    this.bots = [];
    const enemies = game.settings.get('noEnemies') ? 0 : Math.min(MAX_SIDE, game.settings.get('botCount') ?? CONFIG.bots.count);
    const allies = Math.max(0, Math.min(MAX_SIDE - 1, enemies - 1));
    const names = shuffle([...BOT_NAMES]);
    const enemyTeam = player.team === 'blue' ? 'red' : 'blue';
    const roster = [...Array(allies).fill(player.team), ...Array(enemies).fill(enemyTeam)];
    roster.forEach((team, i) => this.bots.push(game.addEntity(new Bot(game, names[i % names.length], team))));

    // Spawns: each side's spawn cells, extras on open cells nearby.
    const used = [];
    const spot = (team) => {
      const side = team === this.attack ? 'attack' : 'defend';
      const pts = shuffle([...world.getSpawns(side)]);
      const free = pts.find((p) => used.every((u) => u.distanceTo(p) > 1.5));
      const p = (free ?? pts[0].clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3))).clone();
      if (world.isSolid(world.worldToCell(p.x, p.z).cx, world.worldToCell(p.x, p.z).cz)) p.copy(pts[0]);
      used.push(p);
      return p;
    };
    const p0 = spot(player.team);
    player.spawn(p0, faceCenter(p0));
    player.frozen = true;
    for (const b of this.bots) {
      const p = spot(b.team);
      b.spawn(p, faceCenter(p));
      b.frozen = true;
    }

    this.bomb.reset(this.everyone().filter((e) => e.team === this.attack));
    this.bombView.sync(this.bomb.publicState(idOf));
    const sub = `${this.round === this.mode.roundsPerHalf + 1 && next ? 'Sides switched · ' : ''}You're ${this.role === 'attack' ? 'attacking' : 'defending'}`;
    game.events.emit('roundStart', { round: this.round });
    game.events.emit('announce', { html: `Round ${this.round}<small>${sub}</small>`, seconds: 2.5 });
    if (this.bomb.carrier === player) setTimeout(() => game.events.emit('announce', { html: 'You have the bomb<small>Hold E in site A or B to plant</small>', seconds: 2.5 }), 2600);
  }

  update(dt) {
    this.phaseLeft -= dt;
    if (this.phase === 'freeze') {
      if (this.phaseLeft <= 0) {
        this.phase = 'live';
        this.phaseLeft = this.mode.roundTime;
        this.player.frozen = false;
        for (const b of this.bots) b.frozen = false;
        this.game.events.emit('announce', { html: 'Go', seconds: 0.8 });
      }
    } else if (this.phase === 'live') {
      this.bomb.update(dt, this.everyone(), this.attack);
      this.ordersTimer -= dt;
      if (this.ordersTimer <= 0) {
        this.ordersTimer = 0.5;
        this.giveOrders();
      }
      if (this.phase === 'live') {
        if (this.bomb.state === 'exploded') this.roundOver(this.attack, 'The bomb exploded');
        else if (this.bomb.state === 'defused') this.roundOver(this.defend, 'The bomb was defused');
        else if (!this.bomb.planted && this.phaseLeft <= 0) this.roundOver(this.defend, 'Time ran out');
      }
    } else if (this.phase === 'roundEnd' && this.phaseLeft <= 0) {
      if (this.final) this.resetMatch();
      else this.startRound(true);
    }
    this.bombView.update(dt);
  }

  onBombState({ reason, by }) {
    if (!this.bomb) return; // the constructor's first reset
    this.bombView.sync(this.bomb.publicState(idOf));
    const ev = this.game.events;
    if (reason === 'planted') {
      this.phaseLeft = BOMB.fuse; // the clock becomes the fuse
      ev.emit('announce', { html: `Bomb planted<small>Site ${this.bomb.site}${this.role === 'attack' ? ' · defend it' : ' · defuse it'}</small>`, seconds: 2.5 });
      this.giveOrders();
    } else if (reason === 'pickup' && by === this.player) {
      ev.emit('announce', { html: 'You have the bomb', seconds: 1.5 });
    } else if (reason === 'dropped' && this.role === 'attack') {
      ev.emit('announce', { html: 'Bomb dropped', seconds: 1.5 });
    }
  }

  checkElimination() {
    if (this.phase !== 'live' || this.bomb.done) return;
    const alive = (team) => this.everyone().some((e) => e.team === team && e.alive);
    if (!alive(this.defend)) this.roundOver(this.attack, 'Defenders eliminated');
    else if (!alive(this.attack) && !this.bomb.planted) this.roundOver(this.defend, 'Attackers eliminated');
  }

  roundOver(team, reason) {
    if (this.bomb.action) this.bomb.setAction(null, null);
    this.score[team]++;
    const { roundsToWin, roundsPerHalf } = this.mode;
    this.final = null;
    if (this.score[team] >= roundsToWin) this.final = team;
    else if (this.round >= roundsPerHalf * 2) this.final = this.score.blue === this.score.red ? 'draw' : this.score.blue > this.score.red ? 'blue' : 'red';
    this.phase = 'roundEnd';
    this.phaseLeft = this.final ? 7 : this.mode.roundEndTime;
    for (const b of this.bots) b.orders = null;
    const won = team === this.player.team;
    let html = `${won ? 'Round won' : 'Round lost'}<small>${reason}${this.round === roundsPerHalf && !this.final ? ' · Halftime: sides switch' : ''}</small>`;
    if (this.final) {
      const title = this.final === 'draw' ? 'Draw' : this.final === this.player.team ? 'Victory' : 'Defeat';
      html = `${title}<small>${reason} · ${this.score.blue} - ${this.score.red} · new match next</small>`;
    }
    this.game.events.emit('announce', { html, seconds: this.final ? 6.5 : 3.5, cls: won ? 'win' : 'lose' });
  }

  resetMatch() {
    this.score = { blue: 0, red: 0 };
    this.round = 0;
    this.attack = this.player.team;
    this.final = null;
    this.startRound(true);
  }

  // ---------- bot orders ----------

  giveOrders() {
    const world = this.game.world;
    const bomb = this.bomb;
    const bombPos = bomb.position ? new THREE.Vector3(bomb.position.x, bomb.position.y, bomb.position.z) : null;
    const attackers = this.bots.filter((b) => b.alive && b.team === this.attack);
    const defenders = this.bots.filter((b) => b.alive && b.team !== this.attack);

    // Attackers.
    let fetcher = null;
    if (bomb.state === 'dropped') {
      fetcher = attackers.reduce((best, b) => (!best || b.position.distanceTo(bombPos) < best.position.distanceTo(bombPos) ? b : best), null);
    }
    for (const b of attackers) {
      if (bomb.state === 'carried' && bomb.carrier === b) {
        // Plant spot: a fixed point in the target site.
        b.plantSpot ??= world.randomSitePoint(this.targetSite);
        if (world.siteAt(b.plantSpot) !== this.targetSite) b.plantSpot = world.randomSitePoint(this.targetSite);
        b.orders = { goal: b.plantSpot, use: true, urgent: world.siteAt(b.position) === this.targetSite };
      } else if (b === fetcher) {
        b.orders = { goal: bombPos, exact: true, urgent: true };
      } else if (bomb.planted) {
        b.guardSpot = b.guardSite === bomb.site && b.guardSpot ? b.guardSpot : world.randomSitePoint(bomb.site);
        b.guardSite = bomb.site;
        b.orders = { goal: b.guardSpot, look: yawFrom(b.guardSpot, world.getSpawns('defend')[0]) };
      } else {
        b.escortSpot ??= world.randomSitePoint(this.targetSite);
        b.orders = { goal: b.escortSpot, walk: false };
      }
    }

    // Defenders.
    if (bomb.planted) {
      const defuser = defenders.reduce((best, b) => (!best || b.position.distanceTo(bombPos) < best.position.distanceTo(bombPos) ? b : best), null);
      for (const b of defenders) {
        if (b === defuser) b.orders = { goal: bombPos, exact: true, use: true, urgent: b.position.distanceTo(bombPos) < 12 };
        else b.orders = { goal: world.randomSitePoint(bomb.site), look: yawFrom(bombPos, world.getSpawns('attack')[0]) };
      }
    } else {
      defenders.forEach((b, i) => {
        const site = i % 2 ? 'B' : 'A';
        if (!b.holdSpot || b.holdSite !== site) {
          b.holdSpot = world.randomSitePoint(site);
          b.holdSite = site;
        }
        b.orders = { goal: b.holdSpot, look: yawFrom(b.holdSpot, world.getSpawns('attack')[0]) };
      });
    }
  }

  // ---------- HUD ----------

  get timeLeft() {
    return Math.max(0, this.phaseLeft);
  }

  get showTimer() {
    return this.phase !== 'roundEnd';
  }

  get statusText() {
    const alive = this.bots.filter((b) => b.alive && b.team !== this.player.team).length;
    return `Round ${this.round} of ${this.mode.roundsPerHalf * 2} · ${this.role === 'attack' ? 'Attacking' : 'Defending'} · Enemies alive: ${alive}`;
  }

  get objective() {
    if (this.phase === 'roundEnd') return null;
    const p = this.player;
    const a = this.bomb.action;
    return bombObjective({
      role: this.role,
      bomb: this.bomb.publicState(idOf),
      isCarrier: this.bomb.state === 'carried' && this.bomb.carrier === p,
      alive: p.alive,
      site: p.alive ? this.game.world.siteAt(p.position) : null,
      action: a && a.player === p ? { kind: a.kind, progress: this.bomb.progress } : null,
      live: this.phase === 'live',
    });
  }
}

const idOf = (e) => e?.id ?? 0;

function faceCenter(p) {
  return Math.atan2(p.x, p.z); // same rule as online spawns
}

function yawFrom(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
