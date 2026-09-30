import { describe, expect, it } from 'vitest';

import {
  deadlinePassed,
  isTrackingState,
  lostPollCutoff,
  nextPollAt,
  pollDelaySeconds,
  recoverInvoking,
  trackingDeadline,
} from './tracking.js';

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

describe('tracking states and lost polls', () => {
  it.each([
    ['running', true],
    ['ok', true],
    ['error', true],
    ['unknown', true],
    ['done', false],
    [undefined, false],
  ])('%s is a tracking state: %s', (state, want) => {
    expect(isTrackingState(state)).toBe(want);
  });

  it('a poll more than a minute overdue is lost', () => {
    const at = new Date('2026-01-05T09:00:00Z');
    expect(lostPollCutoff(at).toISOString()).toBe('2026-01-05T08:59:00.000Z');
  });
});
