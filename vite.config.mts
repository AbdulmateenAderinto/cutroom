import { type Plugin, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_PORT = 5183;

/**
 * index.html has a strict Content-Security-Policy. The dev server needs two exceptions
 * (React Fast Refresh's inline preamble and the hot-reload websocket); production builds keep the strict policy.
 */
function devCsp(): Plugin {
  return {
    name: 'cutroom-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("default-src 'self';", `default-src 'self'; connect-src 'self' ws://localhost:${DEV_PORT};`),
  };
}

// Vite only builds the renderer (the UI). The Electron main process is compiled by tsc.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), devCsp()],
  build: { outDir: '../../build/renderer', emptyOutDir: true },
  server: { port: DEV_PORT, strictPort: true },
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
