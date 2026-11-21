import { Game } from './core/Game.js';
import { CONFIG } from './config.js';
import { Player } from './entities/Player.js';
import { RoundManager } from './systems/RoundManager.js';
import { Effects } from './systems/Effects.js';
import { HUD } from './ui/HUD.js';
import { DamageNumbers } from './ui/DamageNumbers.js';
import { Menu } from './ui/Menu.js';
import { Auth } from './net/Auth.js';
import { OnlineSession } from './net/OnlineSession.js';
import boxyard from './world/maps/boxyard.js';
import { SOUND_SETS } from './audio/sounds.js';

// Wiring: the game, the map, the local player, the always-on systems, and
// the menu that starts a session:
//   practice  RoundManager: you vs. bots, offline
//   online    OnlineSession: a match on the game server
// New features usually mean a new entity or system added here.

const game = new Game(document.getElementById('app'));
game.loadMap(boxyard);

// Decode sound samples in the background; until they're ready (or if a file
// is missing) the procedural fallback sounds play instead.
for (const [name, urls] of Object.entries(SOUND_SETS)) game.audio.loadSet(name, urls);

const player = game.addEntity(new Player(game));
game.player = player;
player.alive = false;
player.viewmodel.setVisible(false);

game.addSystem(new Effects(game));
const hud = game.addSystem(new HUD(game, player));
game.addSystem(new DamageNumbers(game));
const auth = new Auth();

function setSession(session) {
  if (game.session) {
    game.session.dispose();
    game.removeSystem(game.session);
  }
  game.session = session;
  if (session) game.addSystem(session);
  hud.setSession(session);
}

function startPractice() {
  player.team = CONFIG.teams.player;
  player.name = 'You';
  const rounds = new RoundManager(game, player);
  setSession(rounds);
  rounds.startRound();
  menu.hide();
  hud.showOverlay();
}

function startOnline(match, lobby) {
  setSession(
    new OnlineSession(game, player, {
      ...match,
      lobbyCode: lobby.code,
      // Match over or connection lost: back to the lobby after the results.
      onClose: (reason, result) => setTimeout(() => backToMenu(result ? '' : reason), result ? 1500 : 0),
    }),
  );
  menu.hide();
  hud.showOverlay();
}

function backToMenu(message = '') {
  setSession(null);
  if (document.pointerLockElement) document.exitPointerLock();
  game.input.setFreeMode(false);
  game.paused = true;
  player.alive = false;
  player.viewmodel.setVisible(false);
  menu.show(menu.lobby ? 'lobby' : 'main', message);
}

hud.onLeave = () => backToMenu();
const menu = game.addSystem(new Menu(game, auth, { practice: startPractice, online: startOnline }));
menu.show(menu.view ?? 'main');

game.start();

// Handy for poking at things in the browser console.
window.game = game;
