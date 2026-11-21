import { createRemoteJWKSet, jwtVerify } from 'jose';

// Identity.
//
// Accounts live in Firebase Authentication (Google, email / password, or
// guest). The browser sends its Firebase ID token on API calls; we verify the
// signature against Google's public keys, plus issuer, audience and expiry.
//
// WebSockets can't carry an Authorization header, so after an API call
// verifies the user we hand out a ticket: a short-lived HMAC-signed note
// saying "this uid may open this one lobby / match socket". The secret
// (TICKET_SECRET) never leaves the server.
//
// Local development (DEV_AUTH=true in server/.dev.vars, never in production)
// also accepts "dev.<id>" tokens so you can test without Firebase.

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Returns { uid, name, guest } or throws HttpError(401).
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Sign in first');

  // Dev tokens only on a local server, even if DEV_AUTH were set by mistake.
  const host = new URL(request.url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || /^(10|192\.168)\./.test(host);
  if (env.DEV_AUTH === 'true' && local && token.startsWith('dev.')) {
    const id = token.slice(4);
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) throw new HttpError(401, 'Bad dev token');
    return { uid: `dev-${id}`, name: null, guest: true };
  }

  const project = env.FIREBASE_PROJECT_ID;
  if (!project) throw new HttpError(500, 'Server sign-in is not configured');
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${project}`,
      audience: project,
      algorithms: ['RS256'],
      maxTokenAge: '1h', // Firebase ID tokens live an hour; requires iat
      clockTolerance: 30,
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new Error('no subject');
    // Firebase: the sign-in must have happened in the past.
    if (typeof payload.auth_time !== 'number' || payload.auth_time * 1000 > Date.now() + 30_000) throw new Error('bad auth_time');
    return { uid: payload.sub, name: payload.name ?? null, guest: payload.firebase?.sign_in_provider === 'anonymous' };
  } catch {
    throw new HttpError(401, 'Sign-in expired or invalid, sign in again');
  }
}

// Display names: letters, numbers, space and _ - . only, 2-16 characters.
export function cleanName(name, fallback = 'Player') {
  const s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return s.length >= 2 ? s : fallback;
}

// ---------- tickets ----------

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

let keyCache = null;
async function hmacKey(env) {
  if (!env.TICKET_SECRET || env.TICKET_SECRET.length < 16) throw new HttpError(500, 'TICKET_SECRET is not set');
  if (keyCache?.secret !== env.TICKET_SECRET) {
    const key = await crypto.subtle.importKey('raw', enc.encode(env.TICKET_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache = { secret: env.TICKET_SECRET, key };
  }
  return keyCache.key;
}

// data: { uid, name, scope } -> "payload.signature"
export async function signTicket(env, data, ttlSeconds = 60) {
  const body = b64url(enc.encode(JSON.stringify({ ...data, exp: Date.now() + ttlSeconds * 1000 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

// Returns the ticket's data, or throws HttpError(401).
export async function verifyTicket(env, ticket, scope) {
  const [body, sig] = String(ticket ?? '').split('.');
  if (!body || !sig) throw new HttpError(401, 'Missing ticket');
  if (body.length > 1000 || sig.length > 100) throw new HttpError(401, 'Bad ticket');
  const key = await hmacKey(env);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, unb64url(sig), enc.encode(body));
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'Bad ticket');
  const data = JSON.parse(new TextDecoder().decode(unb64url(body)));
  if (!(data.exp >= Date.now())) throw new HttpError(401, 'Ticket expired');
  if (data.scope !== scope) throw new HttpError(403, 'Ticket is for something else');
  return data;
}
