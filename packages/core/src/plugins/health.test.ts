import { describe, expect, it, vi } from 'vitest';

import type { Health } from '@ai-switchboard/sdk';

import { FakeClock } from '../clock.js';

import { createRecordingTelemetry } from '../telemetry/telemetry.js';

import { attribute, HEALTH_TIMEOUT_MS } from './attribution.js';
import { checkAllHealth, probeHealth } from './health.js';
import { LiveSet } from './instances/live-set.js';
import type { InstanceStore } from './instances/store.js';
import type { LiveNotifier } from './runtime.js';

describe('checkAllHealth', () => {
  const clock = new FakeClock('2026-01-05T09:00:00Z');

  it('probes a few instances at a time and stores every result', async () => {
    let inFlight = 0;
    let most = 0;
    const set = new LiveSet();
    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      const live: LiveNotifier = {
        id,
        name: id,
        typeId: 't',
        pluginName: '@test/notifier',
        type: {} as LiveNotifier['type'],
        notifier: {
          send: () => Promise.resolve(),
          health: async () => {
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return { status: 'healthy', checkedAt: 'x' };
          },
        },
      };
      set.commit(
        id,
        set.ticket(),
        { kind: 'notifier', live },
        { kind: 'notifier', version: 1, name: id },
      );
    }
    const saved: string[] = [];
    const store = {
      health: () => Promise.resolve(null),
      saveHealth: (_kind: string, id: string) => {
        saved.push(id);
        return Promise.resolve();
      },
    } as unknown as InstanceStore;
    await checkAllHealth({
      live: set,
      store,
      clock,
      telemetry: createRecordingTelemetry(),
      concurrency: 2,
    });
    expect(most).toBe(2);
    expect(saved.sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  });
});

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
