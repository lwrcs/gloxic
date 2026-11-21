import { API_URL } from './config.js';
import { REGIONS } from '../shared/regions.js';

// HTTP calls to the game server, plus region ping measurement.

export const wsUrl = (path) => `${API_URL.replace(/^http/, 'ws')}${path}`;

async function post(auth, path, body) {
  const token = await auth.token();
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the game server");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server error (${res.status})`);
  return data;
}

export const createLobby = (auth, mode) => post(auth, '/api/lobbies', { mode, name: auth.name });
export const joinLobby = (auth, code) => post(auth, `/api/lobbies/${encodeURIComponent(code)}/join`, { name: auth.name });

// Round-trip time to each region (ms): one warm-up request (connection
// setup, waking the probe), then the best of three. Cached for 10 minutes.
const PING_CACHE = 'gloxic.pings';

export async function measurePings({ force = false } = {}) {
  if (!force) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(PING_CACHE) ?? 'null');
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.pings;
    } catch {
      /* ignore */
    }
  }
  const one = async (region) => {
    const url = `${API_URL}/probe/${region}`;
    try {
      await fetch(url, { cache: 'no-store' });
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const res = await fetch(url, { cache: 'no-store' });
        await res.arrayBuffer();
        best = Math.min(best, performance.now() - t0);
      }
      return [region, Math.round(best)];
    } catch {
      return [region, null];
    }
  };
  const results = await Promise.all(Object.keys(REGIONS).map(one));
  const pings = Object.fromEntries(results.filter(([, ms]) => ms != null));
  try {
    sessionStorage.setItem(PING_CACHE, JSON.stringify({ at: Date.now(), pings }));
  } catch {
    /* ignore */
  }
  return pings;
}
