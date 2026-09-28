import { describe, expect, it } from 'vitest';

import { FakeClock } from '../clock.js';
import { createReasonPolicy } from './reasons.js';

describe('createReasonPolicy', () => {
  it('reads the setting once per TTL and again after invalidate()', async () => {
    const clock = new FakeClock(new Date('2026-09-28T12:00:00Z'));
    let value = false;
    let loads = 0;
    const policy = createReasonPolicy(
      () => {
        loads += 1;
        return Promise.resolve(value);
      },
      clock,
      5_000,
    );
    expect(await policy.required()).toBe(false);
    value = true;
    expect(await policy.required()).toBe(false);
    expect(loads).toBe(1);
    clock.advance(5_000);
    expect(await policy.required()).toBe(true);
    expect(loads).toBe(2);
    value = false;
    policy.invalidate();
    expect(await policy.required()).toBe(false);
    expect(loads).toBe(3);
  });

  it('fails closed (reasons required) when the setting cannot be read, and retries next time', async () => {
    const clock = new FakeClock(new Date('2026-09-28T12:00:00Z'));
    let fail = true;
    const policy = createReasonPolicy(
      () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(false)),
      clock,
    );
    expect(await policy.required()).toBe(true);
    fail = false;
    expect(await policy.required()).toBe(false);
  });
});
