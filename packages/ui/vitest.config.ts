import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  // Like vite.config.ts: workspace packages resolve to their sources, no build needed.
  resolve: { conditions: ['@ai-switchboard/source', ...defaultClientConditions] },
  test: {
    name: 'ui',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
