import { describe, expect, it } from 'vitest';

import { FakeClock } from '../clock.js';
import { AttemptThrottle } from './throttle.js';

describe('attempt throttle', () => {
  it('locks a key for a minute after five failures and unlocks it after', () => {
    const clock = new FakeClock();
    const t = new AttemptThrottle(clock);
    for (let i = 0; i < 4; i++) t.fail('ip');
    expect(t.locked('ip')).toBe(false);
    t.fail('ip');
    expect(t.locked('ip')).toBe(true);
    expect(t.locked('other')).toBe(false);
    clock.advanceSeconds(61);
    expect(t.locked('ip')).toBe(false);
  });

  it('forgets failures on success and after the counting window', () => {
    const clock = new FakeClock();
    const t = new AttemptThrottle(clock);
    for (let i = 0; i < 4; i++) t.fail('ip');
    t.succeed('ip');
    t.fail('ip');
    expect(t.locked('ip')).toBe(false);
    for (let i = 0; i < 3; i++) t.fail('ip');
    clock.advanceMinutes(16);
    // Four failures spread over more than the window do not lock.
    t.fail('ip');
    expect(t.locked('ip')).toBe(false);
  });

  it('stays bounded when many keys fail once', () => {
    const clock = new FakeClock();
    const t = new AttemptThrottle(clock, { maxKeys: 100 });
    for (let i = 0; i < 1000; i++) {
      t.fail(`ip-${i}`);
      clock.advance(1);
    }
    expect(t.size).toBeLessThanOrEqual(100);
  });

  it('keeps a locked key when it has to evict', () => {
    const clock = new FakeClock();
    const t = new AttemptThrottle(clock, { maxKeys: 10 });
    for (let i = 0; i < 5; i++) t.fail('attacker');
    for (let i = 0; i < 50; i++) t.fail(`ip-${i}`);
    expect(t.locked('attacker')).toBe(true);
  });
});
