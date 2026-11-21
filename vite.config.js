import { defineConfig, loadEnv } from 'vite';

// GitHub Pages serves the site from /<repo>/, so production builds for
// Pages set BASE_PATH=/gloxic/ (see .github/workflows/pages.yml).
//
// Production builds also get a Content-Security-Policy (GitHub Pages can't
// send headers, so it's a <meta> tag): scripts only from this site (plus
// Google's sign-in scripts), network only to this site, the game server and
// Firebase Auth. If a bug ever let someone inject HTML, it couldn't load or
// run code from elsewhere or send data anywhere else.
function contentSecurityPolicy(env) {
  const api = (env.VITE_API_URL || '').replace(/\/$/, '');
  const ws = api.replace(/^http/, 'ws');
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN ? `https://${env.VITE_FIREBASE_AUTH_DOMAIN}` : '';
  const policy = {
    'default-src': ["'self'"],
    'script-src': ["'self'", 'https://apis.google.com', 'https://www.gstatic.com', 'https://www.google.com'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      api,
      ws,
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://www.googleapis.com',
      authDomain,
    ],
    'frame-src': [authDomain, 'https://accounts.google.com', 'https://www.google.com'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
  const content = Object.entries(policy)
    .map(([k, v]) => [k, ...v.filter(Boolean)].join(' '))
    .join('; ');
  return {
    name: 'gloxic-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: process.env.BASE_PATH || '/',
    plugins: [contentSecurityPolicy({ ...env, ...process.env })],
  };
});
