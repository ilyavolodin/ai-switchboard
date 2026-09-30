import { describe, expect, it, vi } from 'vitest';

import type { Health } from '@ai-switchboard/sdk';

import { FakeClock } from '../clock.js';

import { attribute, HEALTH_TIMEOUT_MS } from './attribution.js';
import { probeHealth } from './health.js';

describe('probeHealth', () => {
  const clock = new FakeClock('2026-01-05T09:00:00Z');

  it('passes a result through', async () => {
    const ok: Health = { status: 'healthy', checkedAt: 'x' };
    await expect(probeHealth(() => Promise.resolve(ok), clock)).resolves.toBe(ok);
  });

  it('turns a throw into unhealthy with the message', async () => {
    await expect(probeHealth(() => Promise.reject(new Error('401')), clock)).resolves.toEqual({
      status: 'unhealthy',
      message: '401',
      checkedAt: '2026-01-05T09:00:00.000Z',
    });
  });

  it('turns a hang into unhealthy after the health limit, counted against the plugin', async () => {
    vi.useFakeTimers();
    try {
      const counted: string[] = [];
      const object = attribute(
        { health: () => new Promise<Health>(() => undefined) },
        (_err, method) => counted.push(method),
      );
      const pending = probeHealth(() => object.health(), clock);
      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({
        status: 'unhealthy',
        message: `timed out after ${HEALTH_TIMEOUT_MS} ms`,
      });
      expect(counted).toEqual(['health']);
    } finally {
      vi.useRealTimers();
    }
  });
});
