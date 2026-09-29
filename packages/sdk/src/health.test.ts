import { describe, expect, it } from 'vitest';

import { checkHealth } from './health.js';

const ctx = { now: () => new Date('2026-09-29T12:00:00Z') };
const checkedAt = '2026-09-29T12:00:00.000Z';

describe('checkHealth', () => {
  it('stamps checkedAt on the probe result', async () => {
    await expect(
      checkHealth(ctx, () => Promise.resolve({ status: 'healthy', message: 'fine' })),
    ).resolves.toEqual({ status: 'healthy', message: 'fine', checkedAt });
  });

  it('turns a throw into unhealthy with its message', async () => {
    await expect(checkHealth(ctx, () => Promise.reject(new Error('boom')))).resolves.toEqual({
      status: 'unhealthy',
      message: 'boom',
      checkedAt,
    });
  });
});
