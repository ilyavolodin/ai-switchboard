import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const backend = 'http://localhost:8080';

// Set `VITE_MOCK_API=1` to run against the in-browser fixtures instead of a core on :8080.
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
  },
});
