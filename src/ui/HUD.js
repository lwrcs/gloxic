// DOM overlay: crosshair, health, ammo, score, timer, kill feed, hitmarker,
// damage flash, round messages, scoreboard (Tab) and the click-to-play /
// pause screen. It reads player and session state each frame (the session
// is practice's RoundManager or an OnlineSession) and reacts to events.

import * as THREE from 'three';

const KILLFEED_TIME = 5;

export class HUD {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.session = null;
    this.onLeave = null; // set by main.js: the pause screen's leave button
    this.alwaysUpdate = true;
    this.hitTime = 0;
    this.damageTime = 0;
    this.messageTime = 0;

    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="vignette"></div>
      <div class="hitmarker"></div>
      <div class="top">
        <span class="score blue">0</span>
        <span class="timer">0:00</span>
        <span class="score red">0</span>
        <div class="alive"></div>
      </div>
      <div class="ping"></div>
      <div class="scoreboard"></div>
      <div class="killfeed"></div>
      <div class="message"></div>
      <div class="notice"></div>
      <div class="error"></div>
      <div class="bottom-left"><span class="label">HP</span><span class="health">100</span></div>
      <div class="bottom-right">
        <div class="weapon-name"></div>
        <div><span class="ammo">30</span><span class="reserve"> / 90</span></div>
        <div class="reload-bar"><div></div></div>
      </div>
      <div class="overlay">
        <div class="panel">
          <h1>Gloxic</h1>
          <p class="click">${game.touchMode ? 'Tap to play' : 'Click to play'}</p>
          <div class="pause-actions"><button class="leave">Leave</button></div>
          <p class="touch-hint">Left side: move (push far to run, a little to sneak) · Right side: drag to look</p>
          <table class="keys">
            <tr><td>WASD / Arrows</td><td>Move</td></tr>
            <tr><td>Mouse</td><td>Look / Fire</td></tr>
            <tr><td>Right click</td><td>Aim down sights</td></tr>
            <tr><td>Space</td><td>Jump</td></tr>
            <tr><td>Ctrl</td><td>Crouch (silent)</td></tr>
            <tr><td>Shift</td><td>Walk (silent)</td></tr>
            <tr><td>R</td><td>Reload</td></tr>
            <tr><td>1 / 2 / 3 / 4 / Wheel</td><td>Rifle / Pistol / Shotgun / Knife</td></tr>
            <tr><td>Q</td><td>Knife (again: back to gun)</td></tr>
            <tr><td>Tab</td><td>Scoreboard (online)</td></tr>
            <tr><td>Esc</td><td>Pause</td></tr>
          </table>
          <div class="settings">
            <h2>Settings</h2>
            <label class="mouse-only">Mouse sensitivity <span class="sens-value"></span>
              <input class="sens" type="range" min="0.1" max="4" step="0.05" />
            </label>
            <label class="touch-only">Touch look speed <span class="tsens-value"></span>
              <input class="tsens" type="range" min="0.2" max="3" step="0.05" />
            </label>
            <label>Volume <span class="vol-value"></span>
              <input class="vol" type="range" min="0" max="1.5" step="0.05" />
            </label>
            <label class="practice-only">Enemies <span class="bots-value"></span>
              <input class="bots" type="range" min="1" max="10" step="1" />
            </label>
            <label class="practice-only">Game tick <span class="tick-value"></span>
              <input class="tick" type="range" min="0" max="1.2" step="0.05" />
            </label>
            <label class="toggle"><input type="checkbox" data-setting="recoilView" /> View follows recoil</label>
            <label class="toggle mouse-only"><input type="checkbox" data-setting="fullscreen" /> Fullscreen (stops Ctrl+W closing the tab)</label>
            <label class="toggle practice-only"><input type="checkbox" data-setting="invincible" /> Invincible</label>
            <label class="toggle practice-only"><input type="checkbox" data-setting="infiniteAmmo" /> Unlimited ammo</label>
            <label class="toggle practice-only"><input type="checkbox" data-setting="noEnemies" /> Disable enemies</label>
          </div>
        </div>
      </div>`;

    // The crosshair lives directly on <body>, outside the HUD layer, so its
    // exclusion blend mixes with the game image instead of an empty layer.
    this.circle = document.createElement('div');
    this.circle.className = 'xh-circle';
    this.dot = document.createElement('div');
    this.dot.className = 'xh-dot';
    document.body.append(this.circle, this.dot, this.el);

    const $ = (s) => this.el.querySelector(s);
    this.ui = {
      hitmarker: $('.hitmarker'),
      vignette: $('.vignette'),
      blue: $('.score.blue'),
      red: $('.score.red'),
      timer: $('.timer'),
      alive: $('.alive'),
      killfeed: $('.killfeed'),
      message: $('.message'),
      health: $('.health'),
      weaponName: $('.weapon-name'),
      ammo: $('.ammo'),
      reserve: $('.reserve'),
      reloadBar: $('.reload-bar'),
      reloadFill: $('.reload-bar div'),
      overlay: $('.overlay'),
      notice: $('.notice'),
      error: $('.error'),
      ping: $('.ping'),
      scoreboard: $('.scoreboard'),
      leave: $('.leave'),
    };
    this.ui.leave.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onLeave?.();
    });

    this.ui.overlay.addEventListener('click', () => game.requestPlay());

    // Settings: clicks here shouldn't start the game.
    const settings = $('.settings');
    settings.addEventListener('click', (e) => e.stopPropagation());
    const sens = $('.sens');
    const sensValue = $('.sens-value');
    const showSens = (v) => (sensValue.textContent = Number(v).toFixed(2));
    sens.value = game.settings.get('sensitivity');
    showSens(sens.value);
    sens.addEventListener('input', () => {
      game.settings.set('sensitivity', Number(sens.value));
      showSens(sens.value);
    });
    const tsens = $('.tsens');
    const tsensValue = $('.tsens-value');
    tsens.value = game.settings.get('touchSensitivity');
    tsensValue.textContent = Number(tsens.value).toFixed(2);
    tsens.addEventListener('input', () => {
      game.settings.set('touchSensitivity', Number(tsens.value));
      tsensValue.textContent = Number(tsens.value).toFixed(2);
    });
    const vol = $('.vol');
    const volValue = $('.vol-value');
    const showVol = (v) => (volValue.textContent = `${Math.round(Number(v) * 100)}%`);
    vol.value = game.settings.get('volume');
    showVol(vol.value);
    vol.addEventListener('input', () => {
      game.settings.set('volume', Number(vol.value));
      showVol(vol.value);
    });
    vol.addEventListener('change', () => game.audio.beep(1100, 0.05, 0.3)); // preview
    const bots = $('.bots');
    const botsValue = $('.bots-value');
    bots.value = game.settings.get('botCount');
    botsValue.textContent = bots.value;
    bots.addEventListener('input', () => (botsValue.textContent = bots.value));
    // Restart the round once, when the slider is let go.
    bots.addEventListener('change', () => game.settings.set('botCount', Number(bots.value)));
    const tick = $('.tick');
    const tickValue = $('.tick-value');
    const showTick = (v) => (tickValue.textContent = Number(v) > 0 ? `${Number(v).toFixed(2)} s` : '64 Hz (real time)');
    tick.value = game.settings.get('tickLength');
    showTick(tick.value);
    tick.addEventListener('input', () => {
      game.settings.set('tickLength', Number(tick.value));
      showTick(tick.value);
    });
    for (const box of this.el.querySelectorAll('.settings input[type="checkbox"]')) {
      const name = box.dataset.setting;
      box.checked = !!game.settings.get(name);
      box.addEventListener('change', () => game.settings.set(name, box.checked));
    }
    game.events.on('pause', () => this.ui.overlay.classList.remove('hidden'));
    game.events.on('resume', () => this.ui.overlay.classList.add('hidden'));
    game.events.on('lockFallback', () => {
      this.ui.notice.textContent = 'Mouse lock unavailable in this browser: keep the cursor inside the window. Open localhost:5173 in Chrome/Edge for full mouse-look.';
      this.ui.notice.classList.add('show');
      setTimeout(() => this.ui.notice.classList.remove('show'), 7000);
    });
    game.events.on('error', (err) => {
      this.ui.error.textContent = `Game error (paused): ${err?.message ?? err}. Details in the browser console.`;
      this.ui.error.classList.add('show');
    });
    game.events.on('resume', () => this.ui.error.classList.remove('show'));
    game.events.on('damage', (e) => this.onDamage(e));
    game.events.on('death', (e) => this.onDeath(e));
    game.events.on('roundStart', ({ round }) => this.showMessage(`Round ${round}`, 1.5));
    game.events.on('roundEnd', (e) => this.showMessage(`${e.playerWon ? 'Round won' : 'Round lost'}<small>${e.reason}</small>`, 3.5, e.playerWon ? 'win' : 'lose'));
    game.events.on('announce', (e) => this.showMessage(e.html, e.seconds ?? 2, e.cls ?? ''));
  }

  setSession(session) {
    this.session = session;
    const online = !!session?.online;
    document.body.classList.toggle('online', online);
    this.ui.leave.textContent = online ? 'Leave match' : 'Main menu';
    this.ui.killfeed.innerHTML = '';
    this.ui.message.classList.remove('show');
  }

  showOverlay(show = true) {
    this.ui.overlay.classList.toggle('hidden', !show);
  }

  renderScoreboard() {
    const rows = this.session?.scoreboard?.() ?? [];
    const table = document.createElement('table');
    const head = table.insertRow();
    for (const h of ['Player', 'K', 'D', 'Ping']) head.appendChild(document.createElement('th')).textContent = h;
    for (const r of rows) {
      const tr = table.insertRow();
      tr.className = `${r.team}${r.me ? ' me' : ''}${r.connected ? '' : ' gone'}`;
      for (const v of [r.name, r.kills, r.deaths, r.connected ? r.ping : '-']) tr.insertCell().textContent = v; // names are user input: text only
    }
    this.ui.scoreboard.replaceChildren(table);
  }

  onDamage({ target, source, part }) {
    if (source === this.player) {
      this.hitTime = 0.15;
      this.ui.hitmarker.classList.toggle('head', part === 'head');
      this.game.audio.beep(part === 'head' ? 1800 : 1100, 0.04, 0.15);
    }
    if (target === this.player) this.damageTime = 0.35;
  }

  onDeath({ victim, killer, headshot }) {
    const row = document.createElement('div');
    // Player names are user input: set as text, never as HTML.
    const name = (e, fallback) => {
      const span = document.createElement('span');
      span.className = e?.team ?? 'neutral';
      span.textContent = e?.name ?? fallback;
      return span;
    };
    const icon = document.createElement('span');
    icon.className = 'weapon';
    icon.textContent = headshot ? '◎' : '▸';
    row.append(name(killer, 'World'), icon, name(victim, '?'));
    if (killer === this.player || victim === this.player) row.classList.add('mine');
    this.ui.killfeed.prepend(row);
    setTimeout(() => row.remove(), KILLFEED_TIME * 1000);
  }

  showMessage(html, seconds, cls = '') {
    this.ui.message.innerHTML = html;
    this.ui.message.className = `message show ${cls}`;
    this.messageTime = seconds;
  }

  update(dt) {
    const { ui, player, session } = this;
    const w = player.weapon;

    // Spread circle: its radius is exactly how far from the dot the next shot
    // will land, projected with the current (zoom-aware) camera FOV.
    const angle = player.currentSpread();
    const fov = THREE.MathUtils.degToRad(this.game.camera.fov);
    const radius = (Math.tan(angle) / Math.tan(fov / 2)) * (window.innerHeight / 2);
    const show = player.alive && !this.game.paused && !!session;
    this.circle.style.width = this.circle.style.height = `${radius * 2}px`;
    this.circle.style.display = show && radius >= 1 ? 'block' : 'none';
    this.dot.style.display = show ? 'block' : 'none';

    this.hitTime -= dt;
    ui.hitmarker.style.opacity = this.hitTime > 0 ? 1 : 0;
    this.damageTime -= dt;
    ui.vignette.style.opacity = Math.max(0, this.damageTime / 0.35) * 0.8;

    this.messageTime -= dt;
    if (this.messageTime <= 0) ui.message.classList.remove('show');
    if (!session) return;

    ui.health.textContent = Math.ceil(player.health);
    ui.health.classList.toggle('low', player.health <= 25);
    ui.weaponName.textContent = w.def.name;
    ui.ammo.classList.toggle('low', w.ammo <= w.def.magSize * 0.2);
    const infinite = player.infiniteAmmo;
    const melee = !!w.def.melee;
    ui.ammo.textContent = melee ? '' : infinite ? '∞' : w.ammo;
    ui.reserve.textContent = melee || infinite ? '' : ` / ${w.reserve}`;
    ui.reloadBar.style.visibility = w.reloading ? 'visible' : 'hidden';
    ui.reloadFill.style.width = `${w.reloadProgress * 100}%`;

    ui.blue.textContent = session.score.blue;
    ui.red.textContent = session.score.red;
    const t = Math.max(0, Math.ceil(session.timeLeft));
    ui.timer.textContent = session.showTimer ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : '--:--';
    ui.alive.textContent = session.statusText;
    ui.ping.textContent = session.online ? session.pingText : '';

    // Hold Tab: scoreboard (online).
    const board = !!session.online && this.game.input.isDown('Tab') && !this.game.paused;
    ui.scoreboard.style.display = board ? 'block' : 'none';
    if (board) {
      this.boardTimer = (this.boardTimer ?? 0) - dt;
      if (this.boardTimer <= 0) {
        this.boardTimer = 0.25;
        this.renderScoreboard();
      }
    } else this.boardTimer = 0;
  }
}
