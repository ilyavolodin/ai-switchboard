import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'ui', include: ['src/**/*.test.tsx', 'src/**/*.test.ts'], environment: 'jsdom' },
});
