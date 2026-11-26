import { MODES, DEFAULT_MODE, TEAMS } from '../shared/modes.js';
import { pickRegion, placeName } from '../shared/regions.js';
import { probeColos } from '../net/api.js';
import { ONLINE_AVAILABLE } from '../net/config.js';
import { authErrorMessage } from '../net/Auth.js';
import { LobbyClient } from '../net/LobbyClient.js';

// Main menu and lobby screens.
//
//   main   name, account (guest / Google / email), mode picker, create a
//          match, join with a friend code, or practice against bots
//   lobby  the friend code and invite link, members by team with their
//          pings, the mode (host picks), the server region that will be
//          used, and Start (host)
//
// An invite link (?join=CODE) skips straight to the lobby, signed in as a
// guest if needed, so a friend is one click from playing.

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Menu {
  constructor(game, auth, actions) {
    this.game = game;
    this.auth = auth;
    this.actions = actions; // { practice(), online(match, lobby) }
    this.alwaysUpdate = true;
    this.lobby = null;
    this.mode = DEFAULT_MODE;
    this.view = null;
    this.t = 0;

    this.el = document.createElement('div');
    this.el.className = 'menu';
    this.el.innerHTML = `
      <div class="menu-panel main">
        <h1 class="logo">GLOXIC</h1>
        <section class="account">
          <label class="field">Name <input class="name" maxlength="16" spellcheck="false" /></label>
          <div class="account-line"><span class="who"></span>
            <button class="link google">Sign in with Google</button>
            <button class="link email-toggle">Email</button>
            <button class="link signout">Sign out</button>
          </div>
          <form class="email-form hidden">
            <input class="email" type="email" placeholder="Email" autocomplete="email" />
            <input class="password" type="password" placeholder="Password" autocomplete="current-password" />
            <button type="submit" class="small">Sign in</button>
            <button type="button" class="small create-account">Create account</button>
          </form>
        </section>
        <section class="online">
          <h2>Play with friends</h2>
          <div class="mode-pick"></div>
          <button class="primary create">Create match</button>
          <div class="join-row">
            <input class="code" placeholder="Friend code" maxlength="6" spellcheck="false" autocomplete="off" />
            <button class="join">Join</button>
          </div>
        </section>
        <section>
          <h2>Solo</h2>
          <button class="practice">Practice vs bots</button>
          <button class="practice-bomb">Bomb practice (Sandhollow)</button>
        </section>
        <div class="menu-error"></div>
      </div>
      <div class="menu-panel lobby hidden">
        <h2>Lobby</h2>
        <div class="code-row"><span class="code-big"></span>
          <button class="small copy-code">Copy code</button>
          <button class="small copy-link">Copy invite link</button>
        </div>
        <div class="lobby-mode"></div>
        <div class="teams"></div>
        <div class="region"></div>
        <div class="lobby-actions">
          <button class="primary start">Start match</button>
          <button class="primary rejoin hidden">Rejoin match</button>
          <span class="waiting"></span>
        </div>
        <div class="last-result"></div>
        <button class="link leave-lobby">Leave lobby</button>
        <div class="menu-error"></div>
      </div>`;
    document.body.appendChild(this.el);

    const $ = (s) => this.el.querySelector(s);
    this.ui = {
      main: $('.main'),
      lobby: $('.lobby'),
      name: $('.name'),
      who: $('.who'),
      google: $('.google'),
      emailToggle: $('.email-toggle'),
      signout: $('.signout'),
      emailForm: $('.email-form'),
      email: $('.email'),
      password: $('.password'),
      modePick: $('.mode-pick'),
      online: $('.online'),
      code: $('.code'),
      codeBig: $('.code-big'),
      lobbyMode: $('.lobby-mode'),
      teams: $('.teams'),
      region: $('.region'),
      start: $('.start'),
      rejoin: $('.rejoin'),
      waiting: $('.waiting'),
      lastResult: $('.last-result'),
    };

    // Name.
    if (!auth.name) auth.name = `Player${Math.floor(1000 + Math.random() * 9000)}`;
    this.ui.name.value = auth.name;
    this.ui.name.addEventListener('input', () => (auth.name = this.ui.name.value.trim()));

    // Account.
    auth.onChange(() => this.renderAccount());
    this.renderAccount();
    this.ui.google.addEventListener('click', () => this.busy(() => auth.signInGoogle()));
    this.ui.signout.addEventListener('click', () => this.busy(() => auth.signOut()));
    this.ui.emailToggle.addEventListener('click', () => this.ui.emailForm.classList.toggle('hidden'));
    this.ui.emailForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.busy(() => auth.signInEmail(this.ui.email.value.trim(), this.ui.password.value));
    });
    $('.create-account').addEventListener('click', () => this.busy(() => auth.signInEmail(this.ui.email.value.trim(), this.ui.password.value, true)));

    // Modes.
    this.ui.modePick.innerHTML = Object.values(MODES)
      .map((m) => `<button class="mode" data-mode="${m.id}"><b>${esc(m.name)}</b><small>${esc(m.description)}</small></button>`)
      .join('');
    this.ui.modePick.addEventListener('click', (e) => {
      const b = e.target.closest('.mode');
      if (b) this.pickMode(b.dataset.mode);
    });
    this.pickMode(this.mode);

    $('.create').addEventListener('click', () => this.busy(() => this.createLobby()));
    $('.join').addEventListener('click', () => this.busy(() => this.joinLobby(this.ui.code.value)));
    this.ui.code.addEventListener('input', () => (this.ui.code.value = this.ui.code.value.toUpperCase()));
    this.ui.code.addEventListener('keydown', (e) => e.key === 'Enter' && this.busy(() => this.joinLobby(this.ui.code.value)));
    $('.practice').addEventListener('click', () => actions.practice('bots'));
    $('.practice-bomb').addEventListener('click', () => actions.practice('bomb'));

    // Lobby.
    $('.copy-code').addEventListener('click', () => this.copy(this.lobby?.code));
    $('.copy-link').addEventListener('click', () => this.copy(this.inviteLink()));
    this.ui.start.addEventListener('click', () => this.lobby?.start());
    this.ui.rejoin.addEventListener('click', () => this.lobby?.send({ t: 'rejoin' }));
    this.ui.lobbyMode.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) this.lobby?.setMode(b.dataset.mode);
    });
    this.ui.teams.addEventListener('click', (e) => {
      const b = e.target.closest('[data-team]');
      if (b) this.lobby?.setTeam(b.dataset.team);
    });
    $('.leave-lobby').addEventListener('click', () => this.leaveLobby());

    if (!ONLINE_AVAILABLE) {
      this.ui.online.innerHTML = '<h2>Play with friends</h2><p class="muted">Online play isn\'t configured for this build.</p>';
    }

    // Invite link: ?join=CODE
    const code = new URLSearchParams(location.search).get('join');
    if (code && ONLINE_AVAILABLE) this.busy(() => this.joinLobby(code));
  }

  // ---------- helpers ----------

  async busy(fn) {
    if (this.working) return;
    this.working = true;
    this.el.classList.add('busy');
    this.error('');
    try {
      await fn();
    } catch (err) {
      this.error(authErrorMessage(err));
    } finally {
      this.working = false;
      this.el.classList.remove('busy');
    }
  }

  error(text) {
    for (const el of this.el.querySelectorAll('.menu-error')) el.textContent = text;
  }

  async copy(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.error('Copied');
      setTimeout(() => this.error(''), 1200);
    } catch {
      this.error(text);
    }
  }

  inviteLink() {
    if (!this.lobby?.code) return '';
    const url = new URL(location.href);
    url.search = `?join=${this.lobby.code}`;
    url.hash = '';
    return url.toString();
  }

  pickMode(id) {
    this.mode = id;
    for (const b of this.ui.modePick.querySelectorAll('.mode')) b.classList.toggle('selected', b.dataset.mode === id);
  }

  renderAccount() {
    const u = this.auth.user;
    const dev = this.auth.mode === 'dev';
    let who = 'Not signed in (you\'ll play as a guest)';
    if (u) who = dev ? 'Local dev account' : u.guest ? 'Playing as guest' : `Signed in${u.email ? ` as ${u.email}` : ''}`;
    this.ui.who.textContent = who;
    const full = u && !u.guest;
    this.ui.google.classList.toggle('hidden', dev || full);
    this.ui.emailToggle.classList.toggle('hidden', dev || full);
    this.ui.signout.classList.toggle('hidden', !u);
    if (full) this.ui.emailForm.classList.add('hidden');
  }

  checkName() {
    const name = this.ui.name.value.trim();
    if (name.length < 2) throw new Error('Pick a name (2-16 characters)');
    this.auth.name = name;
  }

  // ---------- lobby ----------

  makeLobby() {
    this.lobby?.leave();
    this.lobby = new LobbyClient(this.auth, {
      onState: (s) => this.renderLobby(s),
      onMatch: (m) => this.actions.online(m, this.lobby),
      onError: (msg) => this.error(msg),
      onClosed: (reason) => {
        this.lobby = null;
        this.show('main');
        this.error(reason);
      },
    });
    return this.lobby;
  }

  async createLobby() {
    this.checkName();
    await this.auth.ensureSignedIn();
    await this.makeLobby().create(this.mode);
    this.show('lobby');
  }

  async joinLobby(code) {
    this.checkName();
    code = String(code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Friend codes are 6 letters / numbers');
    await this.auth.ensureSignedIn();
    await this.makeLobby().join(code);
    this.show('lobby');
  }

  leaveLobby() {
    this.lobby?.leave();
    this.lobby = null;
    history.replaceState(null, '', location.pathname);
    this.show('main');
  }

  renderLobby(s) {
    const ui = this.ui;
    const me = this.auth.user?.uid;
    const isHost = s.host === me;
    const mode = MODES[s.mode];
    ui.codeBig.textContent = s.code;
    history.replaceState(null, '', `?join=${s.code}`);

    ui.lobbyMode.innerHTML = isHost && s.state === 'open'
      ? Object.values(MODES).map((m) => `<button class="mode small${m.id === s.mode ? ' selected' : ''}" data-mode="${m.id}">${esc(m.name)}</button>`).join('') +
        `<small>${esc(mode.description)}</small>`
      : `Mode: <b>${esc(mode.name)}</b> <small>${esc(mode.description)}</small>`;

    const region = s.region ?? pickRegion(s.members.map((m) => m.pings))?.region;
    const ping = (m) => (region && m.pings?.[region] != null ? `${m.pings[region]} ms` : m.pings ? '' : 'measuring...');
    const duel = s.mode === 'duel';
    ui.teams.innerHTML = TEAMS.map((team) => {
      const list = s.members.filter((m) => (duel ? true : m.team === team));
      const rows = (duel ? (team === 'blue' ? s.members : []) : list)
        .map((m) => `<li class="${m.uid === me ? 'me' : ''}">${esc(m.name)}${m.uid === s.host ? ' <i>host</i>' : ''}<span>${esc(ping(m))}</span></li>`)
        .join('');
      if (duel && team === 'red') return '';
      const joinBtn = !duel && s.state === 'open' ? `<button class="small" data-team="${team}">Join ${team}</button>` : '';
      return `<div class="team ${duel ? 'all' : team}"><h3>${duel ? 'Players' : team === 'blue' ? 'Blue' : 'Red'}</h3><ul>${rows}</ul>${joinBtn}</div>`;
    }).join('');

    const worst = region ? Math.max(...s.members.map((m) => m.pings?.[region] ?? 0)) : null;
    ui.region.textContent = region
      ? `${s.state === 'match' ? 'Server' : 'Best server'}: ${placeName(s.colo ?? probeColos[region], region)}${worst ? ` (highest ping ${worst} ms)` : ''}`
      : 'Measuring pings to servers...';

    const count = s.members.length;
    const enough = count >= mode.minPlayers && count <= mode.maxPlayers;
    const inMatch = s.state === 'match';
    ui.start.classList.toggle('hidden', !isHost || inMatch);
    ui.start.disabled = !enough;
    ui.rejoin.classList.toggle('hidden', !inMatch);
    ui.waiting.textContent = inMatch
      ? 'Match in progress'
      : !enough
        ? count < mode.minPlayers ? `Waiting for players: ${mode.name} needs ${mode.minPlayers}. Send your friend the code.` : `${mode.name} is for at most ${mode.maxPlayers} players`
        : isHost ? '' : 'Waiting for the host to start';

    const r = s.lastResult;
    ui.lastResult.textContent = r ? `Last match: ${r.winner ? `${r.winner} won` : 'draw'} ${r.score.blue} - ${r.score.red} (${r.reason})` : '';
  }

  // ---------- visibility ----------

  show(view, message = '') {
    this.view = view;
    this.el.classList.toggle('hidden', !view);
    document.body.classList.toggle('in-menu', !!view);
    this.ui.main.classList.toggle('hidden', view !== 'main');
    this.ui.lobby.classList.toggle('hidden', view !== 'lobby');
    if (view === 'lobby' && this.lobby?.state) this.renderLobby(this.lobby.state);
    this.error(message);
  }

  hide() {
    this.show(null);
  }

  // While the menu is up, slowly circle the camera over the map.
  update(dt) {
    if (!this.view) return;
    this.t += dt * 0.05;
    const cam = this.game.camera;
    cam.position.set(Math.sin(this.t) * 34, 22, Math.cos(this.t) * 26);
    cam.lookAt(0, 0, 0);
  }
}
