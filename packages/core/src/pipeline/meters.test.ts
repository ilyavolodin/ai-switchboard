import { describe, expect, it } from 'vitest';

import type { MeterSpec } from '@ai-switchboard/sdk';

import { FakeClock } from '../clock.js';

import {
  ceilingCrossed,
  estimatedLimit,
  estimateReading,
  isFresh,
  normaliseUtilization,
  periodBounds,
  readingFromReport,
} from './meters.js';

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
    expect(
      readingFromReport(
        { id: 'five_hour', utilization: 99, observedAt: at(86_400).toISOString() },
        declared,
        now,
      )?.observedAt,
    ).toEqual(now);
  });
});

describe('estimates and freshness', () => {
  const now = new Date('2026-01-07T15:00:00Z');

  it('freshness against the staleness window', () => {
    expect(isFresh(new Date(now.getTime() - 30 * 60_000), now, 30)).toBe(true);
    expect(isFresh(new Date(now.getTime() - 31 * 60_000), now, 30)).toBe(false);
  });

  it.each([
    ['hour', '2026-01-07T15:00:00.000Z', '2026-01-07T16:00:00.000Z'],
    ['day', '2026-01-07T00:00:00.000Z', '2026-01-08T00:00:00.000Z'],
    ['week', '2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.000Z'],
  ] as const)('%s period bounds', (period, start, end) => {
    const b = periodBounds(period, new Date('2026-01-07T15:20:00Z'));
    expect([b.start.toISOString(), b.end.toISOString()]).toEqual([start, end]);
  });

  it('estimates a reading from run counts against the typed-in limit', () => {
    const r = estimateReading('daily_runs', 20, 15, 'day', now);
    expect(r).toMatchObject({ utilization: 75, used: 15, limit: 20, estimated: true });
    expect(r.resetsAt?.toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(estimateReading('x', 10, 30, 'day', now).utilization).toBe(100);
  });

  it('picks the typed-in limit over the spec default', () => {
    const spec: MeterSpec = {
      id: 'daily_runs',
      title: 'Daily runs',
      kind: 'allowance',
      unit: 'runs',
      estimate: { period: 'day', defaultLimit: 15 },
    };
    expect(estimatedLimit(spec, { daily_runs: 25 })).toBe(25);
    expect(estimatedLimit(spec, undefined)).toBe(15);
    expect(estimatedLimit({ ...spec, estimate: { period: 'day' } }, {})).toBeUndefined();
  });

  it('clamps utilization and detects ceiling crossings', () => {
    expect(normaliseUtilization(120)).toBe(100);
    expect(normaliseUtilization(-1)).toBe(0);
    expect(normaliseUtilization('50')).toBeNull();
    expect(ceilingCrossed(80, 86, 85)).toBe(true);
    expect(ceilingCrossed(86, 90, 85)).toBe(false);
    expect(ceilingCrossed(undefined, 90, 85)).toBe(true);
  });
});
