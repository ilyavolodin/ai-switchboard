import { describe, expect, it } from 'vitest';

import { meterFraction } from './gauge.js';
import { isAboveCeiling, meterTimes, meterValueText } from './meter.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('meterTimes', () => {
  it('names the last read and a reset still ahead', () => {
    expect(meterTimes({ observedAt: at(-42 * 60_000), resetsAt: at(130 * 60_000) }, NOW)).toEqual({
      lastRead: 'last read 42 min ago',
      resets: 'resets in 2 h 10 m',
    });
  });

  it('drops a reset that has passed instead of counting down below zero', () => {
    expect(meterTimes({ observedAt: null, resetsAt: at(-5_000) }, NOW)).toEqual({
      lastRead: 'never read',
      resets: null,
    });
  });
});

describe('meter values', () => {
  it.each([
    [{ utilization: 62, used: null, limit: null }, 0.62],
    [{ utilization: 140, used: null, limit: null }, 1],
    [{ utilization: null, used: 14, limit: 0 }, null],
    [{ utilization: null, used: 7, limit: 28 }, 0.25],
    [{ utilization: Number.NaN, used: null, limit: null }, 0],
  ])('meterFraction(%o) = %s', (m, f) => {
    expect(meterFraction(m)).toBe(f);
  });

  it('reads "—" for a meter never read and is never above a ceiling then', () => {
    const m = { kind: 'window' as const, utilization: null, used: null, limit: null };
    expect(meterValueText(m)).toBe('—');
    expect(isAboveCeiling({ ...m, ceilings: [] })).toBe(false);
  });
});
