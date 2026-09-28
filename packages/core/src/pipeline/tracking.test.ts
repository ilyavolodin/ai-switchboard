import { describe, expect, it } from 'vitest';

import type { MeterSpec, UsageDimension } from '@ai-switchboard/sdk';

import { breakerAfterRun, breakerAtGate, consecutiveFailures } from './breaker.js';
import {
  ceilingCrossed,
  estimatedLimit,
  estimateReading,
  isFresh,
  normaliseUtilization,
  periodBounds,
} from './meters.js';
import {
  deadlinePassed,
  nextPollAt,
  pollDelaySeconds,
  recoverInvoking,
  statusFromTracking,
  trackingDeadline,
} from './tracking.js';
import { mergeUsage, sanitizeUsage } from './usage.js';

const now = new Date('2026-01-07T15:00:00Z');

describe('tracking', () => {
  it('polls on backoff 30 s, 1 min, 2 min, 5 min, then every 5 min', () => {
    expect([0, 1, 2, 3, 4, 10].map(pollDelaySeconds)).toEqual([30, 60, 120, 300, 300, 300]);
  });

  it('never schedules a poll past the deadline', () => {
    const deadline = new Date(now.getTime() + 45_000);
    expect(nextPollAt(now, 0, deadline)).toEqual({
      at: new Date(now.getTime() + 30_000),
      atDeadline: false,
    });
    expect(nextPollAt(now, 1, deadline)).toEqual({ at: deadline, atDeadline: true });
  });

  it('deadline moves an open run to unknown', () => {
    const deadline = trackingDeadline(now, 120);
    expect(deadline.toISOString()).toBe('2026-01-07T17:00:00.000Z');
    expect(deadlinePassed(deadline, new Date('2026-01-07T16:59:59Z'))).toBe(false);
    expect(deadlinePassed(deadline, deadline)).toBe(true);
    expect(deadlinePassed(null, now)).toBe(false);
  });

  it.each([
    ['running', 'running'],
    ['ok', 'ok'],
    ['error', 'error'],
    ['unknown', 'unknown'],
  ] as const)('tracking state %s → run %s', (state, status) => {
    expect(statusFromTracking(state)).toBe(status);
  });

  it.each<
    [string, Parameters<typeof recoverInvoking>[0], boolean, ReturnType<typeof recoverInvoking>]
  >([
    [
      'attempt in flight 61 s, non-idempotent → uncertain',
      {
        status: 'invoking',
        invokeStartedAt: new Date(now.getTime() - 61_000),
        invokeDeadlineAt: null,
        createdAt: now,
        retryAt: null,
      },
      false,
      'uncertain',
    ],
    [
      'attempt in flight 61 s, idempotent → reinvoke',
      {
        status: 'invoking',
        invokeStartedAt: new Date(now.getTime() - 61_000),
        invokeDeadlineAt: null,
        createdAt: now,
        retryAt: null,
      },
      true,
      'reinvoke',
    ],
    [
      'attempt in flight 30 s → leave it',
      {
        status: 'invoking',
        invokeStartedAt: new Date(now.getTime() - 30_000),
        invokeDeadlineAt: null,
        createdAt: now,
        retryAt: null,
      },
      false,
      null,
    ],
    [
      'attempt in flight 10 min, still inside its invoke deadline → leave it',
      {
        status: 'invoking',
        invokeStartedAt: new Date(now.getTime() - 600_000),
        invokeDeadlineAt: new Date(now.getTime() + 1_000),
        createdAt: now,
        retryAt: null,
      },
      false,
      null,
    ],
    [
      'attempt in flight 20 s, past its (short) invoke deadline → uncertain',
      {
        status: 'invoking',
        invokeStartedAt: new Date(now.getTime() - 20_000),
        invokeDeadlineAt: new Date(now.getTime() - 1),
        createdAt: now,
        retryAt: null,
      },
      false,
      'uncertain',
    ],
    [
      'attempt past its invoke deadline, idempotent → reinvoke',
      {
        status: 'invoking',
        invokeStartedAt: new Date(now.getTime() - 400_000),
        invokeDeadlineAt: now,
        createdAt: now,
        retryAt: null,
      },
      true,
      'reinvoke',
    ],
    [
      'never started for 2 min → resume',
      {
        status: 'invoking',
        invokeStartedAt: null,
        invokeDeadlineAt: null,
        createdAt: new Date(now.getTime() - 120_000),
        retryAt: null,
      },
      false,
      'resume',
    ],
    [
      'a retry is waiting → leave it',
      {
        status: 'invoking',
        invokeStartedAt: null,
        invokeDeadlineAt: null,
        createdAt: new Date(now.getTime() - 120_000),
        retryAt: new Date(now.getTime() + 10_000),
      },
      false,
      null,
    ],
    [
      'not invoking → nothing',
      {
        status: 'running',
        invokeStartedAt: null,
        invokeDeadlineAt: null,
        createdAt: new Date(0),
        retryAt: null,
      },
      false,
      null,
    ],
  ])('%s', (_name, run, idempotent, action) => {
    expect(recoverInvoking(run, idempotent, now)).toBe(action);
  });
});

describe('breaker', () => {
  it.each<[string, Parameters<typeof consecutiveFailures>[0], number]>([
    ['none', [], 0],
    ['two errors', ['error', 'unknown'], 2],
    ['an ok ends the streak', ['error', 'ok', 'error', 'error'], 1],
    ['failed and held neither count nor end it', ['error', 'failed', 'held', 'unknown', 'ok'], 2],
  ])('%s', (_name, statuses, n) => {
    expect(consecutiveFailures(statuses)).toBe(n);
  });

  it('opens after threshold consecutive error/unknown runs', () => {
    const closed = { state: 'closed' as const, openedAt: null };
    expect(breakerAfterRun(closed, ['error', 'error'], 3, now).transition).toBeNull();
    const out = breakerAfterRun(closed, ['unknown', 'error', 'error'], 3, now);
    expect(out).toMatchObject({ transition: 'opened', next: { state: 'open', openedAt: now } });
  });

  it('an already open breaker is not re-opened', () => {
    const open = { state: 'open' as const, openedAt: new Date(0) };
    expect(breakerAfterRun(open, ['error', 'error', 'error'], 3, now).transition).toBeNull();
  });

  it('closes after the cooldown, not before', () => {
    const open = { state: 'open' as const, openedAt: new Date(now.getTime() - 59 * 60_000) };
    expect(breakerAtGate(open, 60, now).next.state).toBe('open');
    expect(breakerAtGate(open, 60, new Date(now.getTime() + 60_000))).toMatchObject({
      transition: 'closed_cooldown',
      next: { state: 'closed' },
    });
  });
});

describe('meters', () => {
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

describe('usage', () => {
  const dims: UsageDimension[] = [
    { id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true },
    { id: 'peak', title: 'Peak', unit: 'bytes', aggregate: 'max', budgetable: false },
  ];

  it('drops undeclared keys and non-numbers', () => {
    expect(sanitizeUsage({ tokens: 10, bogus: 1, peak: 'x' }, dims)).toEqual({
      usage: { tokens: 10 },
      dropped: ['bogus', 'peak'],
    });
    expect(sanitizeUsage(undefined, dims)).toEqual({ usage: null, dropped: [] });
    expect(sanitizeUsage([1], dims).dropped).toHaveLength(1);
  });

  it('merges later tracking reports', () => {
    expect(mergeUsage({ tokens: 10, peak: 5 }, { tokens: 12, peak: 3 }, dims)).toEqual({
      tokens: 12,
      peak: 5,
    });
    expect(mergeUsage(null, { tokens: 1 }, dims)).toEqual({ tokens: 1 });
  });
});
