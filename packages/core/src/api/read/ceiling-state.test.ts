import { describe, expect, it } from 'vitest';

import { ceilingState } from './ceiling-state.js';

const now = new Date('2026-09-29T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const reading = (utilization: number, observedMinutesAgo = 1) => ({
  utilization,
  observedAt: minutesAgo(observedMinutesAgo),
  estimated: false,
  resetsAt: null,
});

describe('ceilingState', () => {
  it.each([
    ['no ceilings', [], reading(99), 'below'],
    ['under the event ceiling', [{ events: 80, sweeps: 95 }], reading(79), 'below'],
    ['at the event ceiling', [{ events: 80, sweeps: 95 }], reading(80), 'throttling'],
    ['above only the sweep ceiling', [{ events: 99, sweeps: 50 }], reading(60), 'below'],
    [
      'above the lowest of two processes',
      [
        { events: 90, sweeps: 95 },
        { events: 60, sweeps: 95 },
      ],
      reading(70),
      'throttling',
    ],
    ['never read', [{ events: 80, sweeps: 95 }], undefined, 'stale'],
    ['read too long ago', [{ events: 80, sweeps: 95 }], reading(10, 31), 'stale'],
    ['read at the staleness limit', [{ events: 80, sweeps: 95 }], reading(10, 30), 'below'],
  ] as const)('%s', (_name, ceilings, snapshot, expected) => {
    expect(ceilingState('window', ceilings, snapshot, 30, now)).toBe(expected);
  });
});
