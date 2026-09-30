import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../clock.js';
import { HOUR_MS, msAgo } from '../../util/time.js';
import {
  countBy,
  dailyWindow,
  median,
  shapeFunnel,
  shapeProcessStats,
  shapeSourceStats,
  shapeUsageHistory,
  sumBy,
  timeBuckets,
  windowMs,
} from './stats.shape.js';

const clock = new FakeClock('2026-01-05T09:40:00Z');
const at = (iso: string) => new Date(iso);

describe('timeBuckets', () => {
  it('lists every hour from the one holding `from` to the one holding `to`', () => {
    const now = clock.now();
    const hours = timeBuckets(msAgo(now, windowMs('24h')), now, 'hour');
    expect(hours).toHaveLength(25);
    expect(hours[0]).toBe('2026-01-04T09:00:00Z');
    expect(hours.at(-1)).toBe('2026-01-05T09:00:00Z');
  });

  it('lists days at UTC midnight', () => {
    const now = clock.now();
    const days = timeBuckets(msAgo(now, windowMs('7d')), now, 'day');
    expect(days).toHaveLength(8);
    expect(days[0]).toBe('2025-12-29T00:00:00Z');
    expect(days.at(-1)).toBe('2026-01-05T00:00:00Z');
  });

  it('is one bucket when both ends share it', () => {
    const now = clock.now();
    expect(timeBuckets(new Date(now.getTime() - 10 * 60_000), now, 'hour')).toEqual([
      '2026-01-05T09:00:00Z',
    ]);
  });
});

describe('dailyWindow', () => {
  it.each([
    ['24h', '7d'],
    ['7d', '7d'],
    ['30d', '30d'],
  ] as const)('%s → %s', (window, expected) => {
    expect(dailyWindow(window)).toBe(expected);
  });
});

describe('median and countBy', () => {
  it('takes the middle value, or the mean of the two middle values', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('counts rows, or adds their counts', () => {
    const rows = [
      { k: 'a', n: 2 },
      { k: 'b', n: 1 },
      { k: 'a', n: 3 },
    ];
    expect(countBy(rows, (r) => r.k)).toEqual({ a: 2, b: 1 });
    expect(sumBy(rows, (r) => r.k)).toEqual({ a: 5, b: 1 });
  });
});

describe('shapeSourceStats', () => {
  it('fills every hour, empty ones included', () => {
    const hours = ['2026-01-05T08:00:00Z', '2026-01-05T09:00:00Z'];
    const out = shapeSourceStats(
      '24h',
      hours,
      [
        { hour: hours[1]!, type: 'a.b', stage: 'matched', n: 2 },
        { hour: hours[1]!, type: 'a.c', stage: 'matched', n: 1 },
      ],
      [{ hour: hours[0]!, n: 4 }],
    );
    expect(out.buckets).toEqual([
      { hour: hours[0], byType: {}, byStage: {} },
      { hour: hours[1], byType: { 'a.b': 2, 'a.c': 1 }, byStage: { matched: 3 } },
    ]);
    expect(out.verifyFailures).toEqual([
      { hour: hours[0], count: 4 },
      { hour: hours[1], count: 0 },
    ]);
  });
});

describe('shapeUsageHistory', () => {
  it('sums a dimension per day, or takes its max, and counts runs by status', () => {
    const day = '2026-01-05T00:00:00Z';
    const out = shapeUsageHistory(
      '7d',
      [day],
      [
        { id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true },
        { id: 'peak', title: 'Peak', unit: 'MB', aggregate: 'max', budgetable: false },
      ],
      [
        { day, status: 'ok', usage: { tokens: 10, peak: 3 } },
        { day, status: 'error', usage: { tokens: 5, peak: 7 } },
        { day, status: 'ok', usage: null },
      ],
    );
    expect(out.dimensions.map((d) => d.days[0]?.value)).toEqual([15, 7]);
    expect(out.runsByStatus).toEqual([{ day, counts: { ok: 2, error: 1 } }]);
  });
});

describe('shapeFunnel', () => {
  it('splits event and sweep work with the shared outcome groups', () => {
    const out = shapeFunnel(
      '24h',
      9,
      [
        { outcome: 'batched', n: 5 },
        { outcome: 'deduped', n: 2 },
      ],
      [
        { kind: 'event', outcome: 'invoked', n: 3 },
        { kind: 'manual', outcome: 'rejected', n: 1 },
        { kind: 'event', outcome: 'throttled', n: 1 },
        { kind: 'sweep', outcome: 'held', n: 2 },
      ],
      [
        { kind: 'event', status: 'ok', n: 2 },
        { kind: 'event', status: 'uncertain', n: 1 },
        { kind: 'sweep', status: 'failed', n: 1 },
        { kind: 'sweep', status: 'unknown', n: 1 },
      ],
    );
    expect(out.event).toEqual({
      received: 9,
      matched: 7,
      deduped: 2,
      batched: 5,
      batches: 5,
      held: 1,
      throttled: 1,
      invoked: 3,
      ok: 2,
      error: 0,
      failed: 0,
      unknown: 1,
      running: 0,
    });
    expect(out.sweep).toEqual({ fired: 2, held: 2, throttled: 0, invoked: 2, ok: 0, error: 2 });
  });
});

describe('shapeProcessStats', () => {
  it('counts held (rejected included) and throttled batches and the day’s median times', () => {
    const day = '2026-01-05T00:00:00Z';
    const t0 = at('2026-01-05T08:00:00Z');
    const out = shapeProcessStats(
      '7d',
      [day],
      [
        {
          day,
          status: 'ok',
          firstEventAt: t0,
          invokedAt: new Date(t0.getTime() + 60_000),
          finishedAt: new Date(t0.getTime() + HOUR_MS),
          usage: { tokens: 4 },
        },
        {
          day,
          status: 'error',
          firstEventAt: null,
          invokedAt: t0,
          finishedAt: null,
          usage: { tokens: 2 },
        },
      ],
      [
        { day, outcome: 'held', n: 1 },
        { day, outcome: 'rejected', n: 1 },
        { day, outcome: 'throttled', n: 3 },
      ],
      [{ id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true }],
    );
    expect(out.days).toEqual([
      {
        day,
        runs: { ok: 1, error: 1 },
        held: 2,
        throttled: 3,
        latencyP50Seconds: 60,
        durationP50Seconds: 3540,
      },
    ]);
    expect(out.usagePerRun).toEqual([
      { dimension: 'tokens', title: 'Tokens', unit: 'tokens', average: 3, total: 6 },
    ]);
  });
});
