// Where the online services are. Set with Vite env variables:
//   VITE_API_URL                 the game server (Cloudflare Worker) URL
//   VITE_FIREBASE_API_KEY        Firebase web config (Project settings >
//   VITE_FIREBASE_AUTH_DOMAIN    General > Your apps). These are public
//   VITE_FIREBASE_PROJECT_ID     identifiers, not secrets.
//   VITE_FIREBASE_APP_ID
// Production values live in .env.production. In `npm run dev` without them,
// the game talks to a local server (npm run server:dev) with dev sign-in.

const env = import.meta.env;

export const API_URL = (env.VITE_API_URL || (env.DEV ? `http://${location.hostname}:8787` : '')).replace(/\/$/, '');

export const FIREBASE_CONFIG = env.VITE_FIREBASE_API_KEY
  ? {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    }
  : null;

export const ONLINE_AVAILABLE = !!API_URL;
