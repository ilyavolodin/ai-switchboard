import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const backend = 'http://localhost:8080';

/**
 * The UI builds into the core's static assets (`packages/core/public`), which Fastify serves.
 * In dev, API, ingress and health routes proxy to a core running on :8080; set
 * `VITE_MOCK_API=1` to run against the in-browser fixtures instead.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@ai-switchboard/source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/hooks': backend,
      '/callbacks': backend,
      '/healthz': backend,
    },
  },
  build: {
    outDir: '../core/public',
    emptyOutDir: true,
    sourcemap: true,
    // React Flow and React are most of the bundle; the app is one screen-set behind a login.
    chunkSizeWarningLimit: 900,
  },
});
