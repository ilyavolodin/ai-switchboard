import { describe, expect, it } from 'vitest';

import { FakeClock } from '../clock.js';

import { readingFromReport } from './meters.js';

describe('readingFromReport', () => {
  const now = new FakeClock('2026-01-10T12:00:00Z').now();
  const declared = new Set(['five_hour']);
  const at = (offsetSeconds: number) => new Date(now.getTime() + offsetSeconds * 1000);

  it('stores a declared reading with its times', () => {
    expect(
      readingFromReport(
        {
          id: 'five_hour',
          utilization: 42.5,
          used: 17,
          limit: 40,
          observedAt: at(-60).toISOString(),
          resetsAt: at(3600).toISOString(),
        },
        declared,
        now,
      ),
    ).toEqual({
      meterId: 'five_hour',
      utilization: 42.5,
      used: 17,
      limit: 40,
      observedAt: at(-60),
      resetsAt: at(3600),
      estimated: false,
    });
  });

  it.each([
    ['not an object', null],
    ['an undeclared meter', { id: 'weekly', utilization: 10 }],
    ['a non-numeric utilization', { id: 'five_hour', utilization: '10' }],
    ['a non-finite utilization', { id: 'five_hour', utilization: Number.NaN }],
  ])('rejects %s', (_name, item) => {
    expect(readingFromReport(item, declared, now)).toBeNull();
  });

  it('clamps utilization and defaults unusable times', () => {
    expect(
      readingFromReport(
        { id: 'five_hour', utilization: 140, observedAt: 'yesterday', resetsAt: 7 },
        declared,
        now,
      ),
    ).toMatchObject({ utilization: 100, observedAt: now, resetsAt: null });
  });

  it('a reading stamped in the future is observed now', () => {
    // Otherwise it stays the "latest" reading, and fresh, until that time comes.
    expect(
      readingFromReport(
        { id: 'five_hour', utilization: 99, observedAt: at(86_400).toISOString() },
        declared,
        now,
      )?.observedAt,
    ).toEqual(now);
  });
});
