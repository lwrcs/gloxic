import { createLobby, joinLobby, measurePings, wsUrl } from './api.js';

// The lobby connection: party members, mode, and the "match is starting"
// message with a ticket to join it. Reconnects if the connection drops.
//
// Callbacks: onState(state), onMatch({ matchId, ticket, region }),
//            onError(message), onClosed(reason)

export class LobbyClient {
  constructor(auth, handlers) {
    this.auth = auth;
    this.handlers = handlers;
    this.code = null;
    this.state = null;
    this.ws = null;
    this.closedByUs = false;
    this.retries = 0;
  }

  async create(mode) {
    const { code, ticket } = await createLobby(this.auth, mode);
    this.open(code, ticket);
    return code;
  }

  async join(code) {
    const res = await joinLobby(this.auth, code.trim().toUpperCase());
    this.open(res.code, res.ticket);
    return res.code;
  }

  open(code, ticket) {
    this.code = code;
    this.closedByUs = false;
    const ws = new WebSocket(wsUrl(`/lobby/${code}/ws?t=${encodeURIComponent(ticket)}`));
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      // Measure region pings once per lobby visit and report them.
      measurePings().then((pings) => this.send({ t: 'pings', pings }));
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'lobby') {
        this.state = msg;
        this.handlers.onState?.(msg);
      } else if (msg.t === 'match') this.handlers.onMatch?.(msg);
      else if (msg.t === 'error') this.handlers.onError?.(msg.message);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.closedByUs) return;
      if (e.code === 4000) return this.handlers.onClosed?.(e.reason || 'Joined from another tab');
      // Dropped: get a fresh ticket and reconnect (a few tries).
      if (this.retries++ < 4) {
        setTimeout(() => this.join(this.code).catch((err) => this.handlers.onClosed?.(err.message)), 600 * this.retries);
      } else this.handlers.onClosed?.('Lost connection to the lobby');
    };
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  setMode(mode) {
    this.send({ t: 'mode', mode });
  }

  setTeam(team) {
    this.send({ t: 'team', team });
  }

  start() {
    this.send({ t: 'start' });
  }

  leave() {
    this.closedByUs = true;
    this.ws?.close(1000, 'left');
    this.ws = null;
    this.code = null;
    this.state = null;
  }
}
