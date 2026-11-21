import { authenticate, cleanName, signTicket, verifyTicket, HttpError } from './auth.js';
import { REGIONS } from '../../src/shared/regions.js';
import { MODES, DEFAULT_MODE } from '../../src/shared/modes.js';

export { Lobby } from './Lobby.js';
export { Match } from './Match.js';
export { Probe } from './Probe.js';

// HTTP entry point. Routes:
//   GET  /health                     liveness
//   GET  /probe/:region              latency probe (answered from that region)
//   POST /api/lobbies                create a lobby -> { code, ticket }     (signed in)
//   POST /api/lobbies/:code/join     join a lobby   -> { code, ticket }     (signed in)
//   GET  /lobby/:code/ws?t=ticket    lobby WebSocket
//   GET  /match/:id/ws?t=ticket      match WebSocket
//
// Friend codes are 6 characters from an alphabet without look-alikes
// (no 0/O, 1/I/L): about a billion codes, so guessing one is impractical.
// Lobby creation / joining is rate limited per account AND per IP address
// (guest accounts are free to make, so a per-account limit alone wouldn't
// stop someone guessing codes), and every route has a per-IP limit.

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS, ...headers } });

const has = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);

// limiter: a Workers rate-limit binding (absent in tests / old configs).
async function rateLimit(limiter, key) {
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'Too many requests, slow down');
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') ?? 'unknown';

const MAX_BODY = 2000;

async function readJson(request) {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) throw new HttpError(413, 'Request too large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Bad JSON');
  }
}

const lobbyStub = (env, code) => env.LOBBY.get(env.LOBBY.idFromName(code));

// Forwards a WebSocket upgrade to a Durable Object with the verified
// identity in headers (Durable Objects are only reachable through here, so
// they can trust them).
function forwardSocket(request, stub, path, identity) {
  const headers = new Headers(request.headers);
  headers.set('X-Uid', identity.uid);
  headers.set('X-Name', encodeURIComponent(identity.name));
  headers.set('X-Continent', request.cf?.continent ?? '');
  return stub.fetch(new Request(`https://do${path}`, { method: 'GET', headers }));
}

async function route(request, env, url, cors) {
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, game: 'gloxic' }, 200, cors);

  // Everything past here costs a Durable Object call: per-IP limit.
  await rateLimit(env.IP_LIMITER, clientIp(request));

  // Latency probe: the Probe object for a region lives in that region.
  if (parts[0] === 'probe' && parts.length === 2 && request.method === 'GET') {
    const region = parts[1];
    if (!has(REGIONS, region)) throw new HttpError(404, 'Unknown region');
    const stub = env.PROBE.get(env.PROBE.idFromName(region), { locationHint: region });
    const res = await stub.fetch('https://do/ping');
    return json(await res.json(), 200, { ...cors, 'Cache-Control': 'no-store' });
  }

  if (parts[0] === 'api' && parts[1] === 'lobbies' && request.method === 'POST') {
    const user = await authenticate(request, env);
    await rateLimit(env.RATE_LIMITER, user.uid);
    await rateLimit(env.LOBBY_IP_LIMITER, clientIp(request));
    const body = await readJson(request);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Bad request');
    const name = cleanName(body.name ?? user.name);

    // Create: pick an unused code.
    if (parts.length === 2) {
      const mode = has(MODES, body.mode) ? body.mode : DEFAULT_MODE;
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = makeCode();
        const res = await lobbyStub(env, code).fetch('https://do/create', {
          method: 'POST',
          body: JSON.stringify({ code, mode, host: user.uid }),
        });
        if (res.ok) {
          const ticket = await signTicket(env, { uid: user.uid, name, scope: `lobby:${code}` });
          return json({ code, ticket }, 200, cors);
        }
      }
      throw new HttpError(503, 'Could not create a lobby, try again');
    }

    // Join.
    if (parts.length === 4 && parts[3] === 'join') {
      const code = String(parts[2]).toUpperCase();
      if (!CODE_RE.test(code)) throw new HttpError(404, 'No lobby with that code');
      const res = await lobbyStub(env, code).fetch(`https://do/info?uid=${encodeURIComponent(user.uid)}`);
      if (res.status === 404) throw new HttpError(404, 'No lobby with that code');
      if (res.status === 409) throw new HttpError(409, 'That lobby is full');
      const ticket = await signTicket(env, { uid: user.uid, name, scope: `lobby:${code}` });
      return json({ code, ticket }, 200, cors);
    }
  }

  // WebSockets: browsers send Origin on upgrades, so reject other sites.
  if ((parts[0] === 'lobby' || parts[0] === 'match') && parts.length === 3 && parts[2] === 'ws') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
    if (!allowedOrigin(request, env)) throw new HttpError(403, 'Origin not allowed');
    const ticket = url.searchParams.get('t');
    if (parts[0] === 'lobby') {
      const code = String(parts[1]).toUpperCase();
      const who = await verifyTicket(env, ticket, `lobby:${code}`);
      return forwardSocket(request, lobbyStub(env, code), '/ws', who);
    }
    const id = parts[1];
    if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(404, 'No such match');
    const who = await verifyTicket(env, ticket, `match:${id}`);
    let doId;
    try {
      doId = env.MATCH.idFromString(id);
    } catch {
      throw new HttpError(404, 'No such match');
    }
    return forwardSocket(request, env.MATCH.get(doId), '/ws', who);
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(allowedOrigin(request, env));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      return await route(request, env, url, cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: status === 500 && !(err instanceof HttpError) ? 'Server error' : err.message }, status, cors);
    }
  },
};
