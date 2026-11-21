import { DurableObject } from 'cloudflare:workers';
import { signTicket } from './auth.js';
import { MODES, TEAMS } from '../../src/shared/modes.js';
import { pickRegion, CONTINENT_REGION, REGIONS } from '../../src/shared/regions.js';
import { MAX_PLAYERS } from '../../src/shared/net.js';

// One lobby (party) per friend code. Friends join with the code, the host
// picks the mode, everyone's browser reports its ping to each region, and
// when the host starts, the lobby creates a Match in the fairest region and
// hands each member a ticket to join it. The lobby stays open during the
// match (so a refreshed tab can rejoin) and afterwards for a rematch.
//
// Uses WebSocket hibernation: an idle lobby sleeps and costs nothing; each
// socket's member info survives in its attachment.
//
// Client -> lobby: { t: 'mode', mode } (host), { t: 'team', team },
//                  { t: 'pings', pings: { region: ms } }, { t: 'start' } (host)
// Lobby -> client: { t: 'lobby', ...state }, { t: 'match', matchId, ticket, region },
//                  { t: 'error', message }

const EMPTY_TTL = 10 * 60 * 1000; // an empty lobby is deleted after this
const MAX_MESSAGE = 2000;
// Per-socket message allowance: every message is broadcast to the whole
// lobby, so one client spamming would cost everyone. Refills per second.
const MSG_RATE = 5;
const MSG_BURST = 20;

const has = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.allowance = new WeakMap(); // ws -> { tokens, at } (resets on wake: fine)
    ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get('meta')) ?? null;
    });
  }

  async save() {
    await this.ctx.storage.put('meta', this.meta);
  }

  // Open sockets with their member info.
  members(except = null) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, ...ws.deserializeAttachment() }))
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/create': {
        if (this.meta) return new Response('taken', { status: 409 });
        const { code, mode, host } = await request.json();
        this.meta = { code, mode, host, state: 'open', matchId: null, region: null, roster: [], lastResult: null, createdAt: Date.now() };
        await this.save();
        await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL);
        return new Response('ok');
      }
      case '/info': {
        if (!this.meta) return new Response('none', { status: 404 });
        const uid = url.searchParams.get('uid');
        const members = this.members();
        if (members.length >= MAX_PLAYERS && !members.some((m) => m.uid === uid)) return new Response('full', { status: 409 });
        return new Response('ok');
      }
      case '/ws':
        return this.connect(request);
      case '/matchEnded': {
        const { matchId, result } = await request.json();
        if (this.meta?.matchId === matchId) {
          Object.assign(this.meta, { state: 'open', matchId: null, colo: null, roster: [], lastResult: result });
          await this.save();
          this.broadcast();
        }
        return new Response('ok');
      }
    }
    return new Response('not found', { status: 404 });
  }

  async connect(request) {
    if (!this.meta) return new Response('No such lobby', { status: 404 });
    const uid = request.headers.get('X-Uid');
    const name = decodeURIComponent(request.headers.get('X-Name') ?? 'Player');
    // The same account in a second tab replaces the first.
    for (const m of this.members()) if (m.uid === uid) m.ws.close(4000, 'Joined from another tab');
    const others = this.members().filter((m) => m.uid !== uid);
    if (others.length >= MAX_PLAYERS) return new Response('Lobby full', { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      uid,
      name,
      team: this.smallerTeam(others),
      pings: null,
      continent: request.headers.get('X-Continent') ?? '',
      joinedAt: Date.now(),
    });
    if (!others.some((m) => m.uid === this.meta.host)) this.meta.host = uid;
    await this.save();
    await this.ctx.storage.deleteAlarm();
    this.broadcast();
    // Refreshed mid-match: send them back in.
    if (this.meta.state === 'match' && this.meta.roster.includes(uid)) await this.sendTicket(server, uid, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  smallerTeam(members) {
    const blue = members.filter((m) => m.team === 'blue').length;
    const red = members.length - blue;
    return blue <= red ? 'blue' : 'red';
  }

  state(except = null) {
    const m = this.meta;
    return {
      t: 'lobby',
      code: m.code,
      mode: m.mode,
      host: m.host,
      state: m.state,
      region: m.region,
      colo: m.state === 'match' ? (m.colo ?? null) : null,
      lastResult: m.lastResult,
      members: this.members(except).map((x) => ({ uid: x.uid, name: x.name, team: x.team, pings: x.pings })),
    };
  }

  broadcast(except = null) {
    const msg = JSON.stringify(this.state(except));
    for (const m of this.members(except)) m.ws.send(msg);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return ws.close(1009, 'Message too large');
    if (!this.allow(ws)) return ws.close(1008, 'Too many messages');
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const me = ws.deserializeAttachment();
    const isHost = me.uid === this.meta?.host;
    const error = (message) => ws.send(JSON.stringify({ t: 'error', message }));
    if (!this.meta) return;

    switch (msg.t) {
      case 'mode':
        if (!isHost || this.meta.state !== 'open' || !has(MODES, msg.mode)) return;
        this.meta.mode = msg.mode;
        await this.save();
        this.broadcast();
        break;
      case 'team':
        if (!TEAMS.includes(msg.team) || this.meta.state !== 'open') return;
        ws.serializeAttachment({ ...me, team: msg.team });
        this.broadcast();
        break;
      case 'pings': {
        const pings = {};
        if (!msg.pings || typeof msg.pings !== 'object') return;
        for (const [region, ms] of Object.entries(msg.pings)) {
          if (has(REGIONS, region) && Number.isFinite(ms) && ms >= 0 && ms < 5000) pings[region] = Math.round(ms);
        }
        ws.serializeAttachment({ ...me, pings });
        this.broadcast();
        break;
      }
      case 'rejoin':
        if (this.meta.state === 'match' && this.meta.roster.includes(me.uid)) await this.sendTicket(ws, me.uid, me.name);
        break;
      case 'start':
        if (!isHost) return error('Only the host can start');
        if (this.meta.state !== 'open') return error('A match is already running');
        try {
          await this.startMatch();
        } catch (err) {
          error(err.message);
        }
        break;
    }
  }

  // Token bucket per socket.
  allow(ws) {
    const now = Date.now();
    const a = this.allowance.get(ws) ?? { tokens: MSG_BURST, at: now };
    a.tokens = Math.min(MSG_BURST, a.tokens + ((now - a.at) / 1000) * MSG_RATE);
    a.at = now;
    this.allowance.set(ws, a);
    if (a.tokens < 1) return false;
    a.tokens -= 1;
    return true;
  }

  async startMatch() {
    if (!has(MODES, this.meta.mode)) this.meta.mode = 'duel';
    const mode = MODES[this.meta.mode];
    const members = this.members();
    if (members.length < mode.minPlayers) throw new Error(`${mode.name} needs ${mode.minPlayers} players`);
    if (members.length > mode.maxPlayers) throw new Error(`${mode.name} is for at most ${mode.maxPlayers} players`);

    // Teams: 1v1 is always one each; TDM keeps choices but won't start lopsided to an empty side.
    if (mode.id === 'duel') members.forEach((m, i) => (m.team = TEAMS[i % 2]));
    else if (members.length > 1 && members.every((m) => m.team === members[0].team)) members.forEach((m, i) => (m.team = TEAMS[i % 2]));
    for (const m of members) {
      const { ws, ...att } = m;
      ws.serializeAttachment(att);
    }

    // Region: fairest measured pings; else the host's continent.
    const host = members.find((m) => m.uid === this.meta.host) ?? members[0];
    const picked = pickRegion(members.map((m) => m.pings));
    const region = picked?.region ?? (has(CONTINENT_REGION, host.continent) ? CONTINENT_REGION[host.continent] : 'enam');

    const id = this.env.MATCH.newUniqueId();
    const matchId = id.toString();
    const res = await this.env.MATCH.get(id, { locationHint: region }).fetch('https://do/init', {
      method: 'POST',
      body: JSON.stringify({
        matchId,
        lobby: this.meta.code,
        mode: mode.id,
        map: 'boxyard',
        region,
        roster: members.map((m) => ({ uid: m.uid, name: m.name, team: m.team })),
      }),
    });
    if (!res.ok) throw new Error('Could not start the match server');
    const { colo = null } = await res.json().catch(() => ({}));

    Object.assign(this.meta, { state: 'match', matchId, region, colo, roster: members.map((m) => m.uid) });
    await this.save();
    this.broadcast();
    for (const m of members) await this.sendTicket(m.ws, m.uid, m.name);
  }

  async sendTicket(ws, uid, name) {
    const ticket = await signTicket(this.env, { uid, name, scope: `match:${this.meta.matchId}` }, 120);
    ws.send(JSON.stringify({ t: 'match', matchId: this.meta.matchId, region: this.meta.region, ticket }));
  }

  async webSocketClose(ws) {
    await this.left(ws);
  }

  async webSocketError(ws) {
    await this.left(ws);
  }

  async left(ws) {
    if (!this.meta) return;
    const rest = this.members(ws);
    if (!rest.length) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL);
      return;
    }
    if (!rest.some((m) => m.uid === this.meta.host)) {
      this.meta.host = rest[0].uid;
      await this.save();
    }
    this.broadcast(ws);
  }

  // Nobody has been here for a while: forget the lobby (frees the code).
  async alarm() {
    if (this.members().length) return;
    await this.ctx.storage.deleteAll();
    this.meta = null;
  }
}
