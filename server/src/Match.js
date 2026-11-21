import { DurableObject } from 'cloudflare:workers';
import { Sim } from './Sim.js';
import { datacenter } from './Probe.js';

// One match. Created by a Lobby with a location hint for the region that
// suits its players, so the simulation runs close to them. Holds the Sim in
// memory and drives it with a timer while the match runs; players connect
// with tickets the lobby issued.

export class Match extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sim = null;
    this.loop = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (await this.ctx.storage.get('config')) return new Response('exists', { status: 409 });
      const config = await request.json();
      await this.ctx.storage.put('config', config);
      this.createSim(config);
      return new Response('ok');
    }

    if (url.pathname === '/ws') {
      if (!this.sim) {
        // Restarted (rare): rebuild from the saved config.
        const config = await this.ctx.storage.get('config');
        if (!config) return new Response('No such match', { status: 404 });
        if (config.finished) return new Response('Match is over', { status: 410 });
        this.createSim(config);
      }
      if (this.sim.finished) return new Response('Match is over', { status: 410 });
      const uid = request.headers.get('X-Uid');
      if (!this.sim.players.has(uid)) return new Response('Not in this match', { status: 403 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ uid });
      this.sim.connect(uid, server);
      this.ensureLoop();
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  createSim(config) {
    this.sim = new Sim(config, { onEnd: (result) => this.finish(result) });
    datacenter().then((colo) => this.sim && (this.sim.colo = colo));
  }

  // Ticks run off the wall clock; checking every 4 ms keeps them on time.
  ensureLoop() {
    this.loop ??= setInterval(() => {
      try {
        this.sim?.advance(Date.now());
      } catch (err) {
        console.error('tick failed', err);
      }
    }, 4);
  }

  webSocketMessage(ws, message) {
    const { uid } = ws.deserializeAttachment() ?? {};
    this.sim?.onMessage(uid, ws, message);
  }

  webSocketClose(ws) {
    const { uid } = ws.deserializeAttachment() ?? {};
    this.sim?.disconnect(uid, ws);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  async finish(result) {
    clearInterval(this.loop);
    this.loop = null;
    const config = await this.ctx.storage.get('config');
    await this.ctx.storage.put('config', { ...config, finished: true });
    try {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName(config.lobby)).fetch('https://do/matchEnded', {
        method: 'POST',
        body: JSON.stringify({ matchId: config.matchId, result }),
      });
    } catch (err) {
      console.error('lobby notify failed', err);
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Match over');
      } catch {
        /* closed */
      }
    }
    // Clean up storage a little later.
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.sim = null;
  }
}
