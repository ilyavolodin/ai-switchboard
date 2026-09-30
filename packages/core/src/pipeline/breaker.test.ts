import { describe, expect, it } from 'vitest';

import {
  breakerAtGate,
  breakerClosesAt,
  breakerHistoryLimit,
  breakerOpensAfterRun,
  consecutiveFailures,
  type BreakerState,
} from './breaker.js';

const now = new Date('2026-01-07T15:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('opening', () => {
  it.each<[string, Parameters<typeof consecutiveFailures>[0], number]>([
    ['none', [], 0],
    ['two errors', ['error', 'unknown'], 2],
    ['an ok ends the streak', ['error', 'ok', 'error', 'error'], 1],
    ['failed and held neither count nor end it', ['error', 'failed', 'held', 'unknown', 'ok'], 2],
  ])('consecutive failures: %s', (_name, statuses, n) => {
    expect(consecutiveFailures(statuses)).toBe(n);
  });

  it.each([
    ['below the threshold', ['error', 'error'], 3, false],
    ['at the threshold', ['unknown', 'error', 'error'], 3, true],
    ['above the threshold', ['error', 'error', 'error', 'error'], 3, true],
    ['a zero threshold never opens', ['error', 'error', 'error'], 0, false],
  ] as const)('%s', (_name, statuses, threshold, opens) => {
    expect(breakerOpensAfterRun(statuses, threshold)).toEqual({ opens, failures: statuses.length });
  });

  it.each([
    [1, 50],
    [20, 80],
  ])('reads enough history for threshold %d', (threshold, limit) => {
    expect(breakerHistoryLimit(threshold)).toBe(limit);
  });
});

describe('cooldown', () => {
  it.each<[string, BreakerState, number, 'open' | 'closed', string | null, string | null]>([
    ['closed stays closed', { state: 'closed', openedAt: null }, 60, 'closed', null, null],
    [
      'inside the cooldown stays open and says when it closes',
      { state: 'open', openedAt: minutesAgo(59) },
      60,
      'open',
      null,
      '2026-01-07T15:01:00.000Z',
    ],
    [
      'at the cooldown closes',
      { state: 'open', openedAt: minutesAgo(60) },
      60,
      'closed',
      'closed_cooldown',
      null,
    ],
    [
      'past the cooldown closes',
      { state: 'open', openedAt: minutesAgo(600) },
      60,
      'closed',
      'closed_cooldown',
      null,
    ],
    [
      'cooldown 0 stays open until reset by hand',
      { state: 'open', openedAt: minutesAgo(10_000) },
      0,
      'open',
      null,
      null,
    ],
    [
      'an open breaker with no opening time stays open',
      { state: 'open', openedAt: null },
      60,
      'open',
      null,
      null,
    ],
  ])('%s', (_name, current, cooldown, state, transition, closesAt) => {
    const out = breakerAtGate(current, cooldown, now);
    expect(out.next.state).toBe(state);
    expect(out.transition).toBe(transition);
    expect(out.closesAt?.toISOString() ?? null).toBe(closesAt);
  });

  it('breakerClosesAt is the opening time plus the cooldown', () => {
    expect(breakerClosesAt({ state: 'open', openedAt: now }, 30)?.toISOString()).toBe(
      '2026-01-07T15:30:00.000Z',
    );
    expect(breakerClosesAt({ state: 'closed', openedAt: null }, 30)).toBeNull();
  });
});
