import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/, so production builds for
// Pages set BASE_PATH=/gloxic/ (see .github/workflows/pages.yml).
export default defineConfig({
  base: process.env.BASE_PATH || '/',
});
