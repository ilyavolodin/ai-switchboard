import { defineConfig } from 'vitest/config';

const sourceCondition = '@ai-switchboard/source';

export default defineConfig({
  resolve: { conditions: [sourceCondition] },
  ssr: { resolve: { conditions: [sourceCondition] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'plugins/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/integration/**/*.test.ts'],
          globalSetup: ['packages/core/test/integration/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          environment: 'node',
        },
      },
      './packages/ui/vitest.config.ts',
    ],
  },
});
