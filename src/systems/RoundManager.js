import { CONFIG } from '../config.js';
import { Bot } from '../entities/Bot.js';

// Round flow: spawn everyone -> fight until one side is dead or time runs out
// -> show result -> restart. Emits 'roundStart' and 'roundEnd'.
// Game modes (bomb, deathmatch, ...) would be alternative versions of this.

const BOT_NAMES = ['Rook', 'Viper', 'Moss', 'Dune', 'Flint', 'Ash', 'Brick', 'Echo', 'Gale', 'Onyx'];

export class RoundManager {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.bots = [];
    this.score = { [CONFIG.teams.player]: 0, [CONFIG.teams.bots]: 0 };
    this.round = 0;
    this.state = 'idle'; // 'live' | 'ended'
    this.timeLeft = 0;
    this.restartTimer = 0;
    this.online = false;
    this.offs = [
      game.events.on('death', (e) => this.onDeath(e)),
      // Toggling enemies on or off starts a fresh round so it applies at once.
      game.events.on('settingChanged', ({ name }) => {
        if (name === 'noEnemies' || name === 'botCount') this.startRound();
      }),
    ];
  }

  // Leaving practice: remove the bots and stop listening.
  dispose() {
    for (const off of this.offs) off();
    for (const b of this.bots) this.game.removeEntity(b);
    this.bots = [];
  }

  // HUD line under the score.
  get statusText() {
    return this.enemiesEnabled ? `Enemies alive: ${this.aliveBots}` : 'Enemies disabled';
  }

  get showTimer() {
    return this.enemiesEnabled;
  }

  get enemiesEnabled() {
    return !this.game.settings.get('noEnemies');
  }

  get aliveBots() {
    return this.bots.filter((b) => b.alive).length;
  }

  startRound() {
    const { game, player } = this;
    const world = game.world;
    this.round++;
    this.state = 'live';
    this.timeLeft = CONFIG.round.duration;

    const pSpawns = shuffle([...world.getSpawns(player.team)]);
    player.spawn(pSpawns[0], yawToward(pSpawns[0], world.getSpawns(CONFIG.teams.bots)[0]));

    for (const b of this.bots) game.removeEntity(b);
    this.bots = [];
    const bSpawns = shuffle([...world.getSpawns(CONFIG.teams.bots)]);
    const names = shuffle([...BOT_NAMES]);
    const botCount = this.enemiesEnabled ? (game.settings.get('botCount') ?? CONFIG.bots.count) : 0;
    for (let i = 0; i < botCount; i++) {
      const bot = new Bot(game, names[i % names.length]);
      // Spawn points first; extra bots start on random open cells well away
      // from the player.
      const spot =
        i < bSpawns.length
          ? bSpawns[i].clone()
          : (world.randomOpenPoint((p) => p.distanceTo(pSpawns[0]) > 18) ?? bSpawns[i % bSpawns.length].clone());
      bot.spawn(spot, yawToward(spot, pSpawns[0]));
      game.addEntity(bot);
      this.bots.push(bot);
    }

    game.events.emit('roundStart', { round: this.round });
  }

  update(dt) {
    if (this.state === 'live') {
      if (!this.enemiesEnabled) return; // free practice: no clock
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.endRound(CONFIG.teams.bots, 'Time ran out');
    } else if (this.state === 'ended') {
      this.restartTimer -= dt;
      if (this.restartTimer <= 0) this.startRound();
    }
  }

  onDeath({ victim }) {
    if (this.state !== 'live') return;
    if (victim === this.player) this.endRound(CONFIG.teams.bots, 'You were eliminated');
    else if (this.aliveBots === 0) this.endRound(CONFIG.teams.player, 'All enemies eliminated');
  }

  endRound(winner, reason) {
    this.state = 'ended';
    this.score[winner]++;
    this.restartTimer = CONFIG.round.restartDelay;
    this.game.events.emit('roundEnd', { winner, reason, score: { ...this.score }, playerWon: winner === this.player.team });
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function yawToward(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}
