import { describe, expect, it } from 'vitest';

import type { UsageDimension } from '@ai-switchboard/sdk';

import { budget, type BudgetInput } from './budget.js';

const now = new Date('2026-01-07T15:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

const dims: UsageDimension[] = [
  { id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true },
  {
    id: 'duration_seconds',
    title: 'Duration',
    unit: 'seconds',
    aggregate: 'sum',
    budgetable: false,
  },
];

function input(patch: Partial<BudgetInput> = {}): BudgetInput {
  return {
    kind: 'event',
    process: { runsPerHour: 5, runsPerDay: 20, meterCeilings: {} },
    executor: { softHoldUntil: null, stalenessMinutes: 30 },
    counters: {
      processRunsHour: 0,
      processRunsDay: 0,
      executorRunsHour: 0,
      executorRunsDay: 0,
      processUsageDay: {},
      executorUsageDay: {},
    },
    dimensions: dims,
    meters: {},
    ...patch,
  };
}

const counters = input().counters;

describe('budget checks', () => {
  it('passes under every cap', () => {
    const out = budget(input(), now);
    expect(out).toMatchObject({ ok: true, binding: null, meterStale: [] });
  });

  it.each<[string, Partial<BudgetInput>, string]>([
    ['hourly cap reached', { counters: { ...counters, processRunsHour: 5 } }, 'runs_per_hour'],
    ['daily cap reached', { counters: { ...counters, processRunsDay: 20 } }, 'runs_per_day'],
    [
      'executor hourly cap',
      {
        executor: { runsPerHour: 2, softHoldUntil: null, stalenessMinutes: 30 },
        counters: { ...counters, executorRunsHour: 2 },
      },
      'executor_runs_per_hour',
    ],
    [
      'executor daily cap',
      {
        executor: { runsPerDay: 2, softHoldUntil: null, stalenessMinutes: 30 },
        counters: { ...counters, executorRunsDay: 3 },
      },
      'executor_runs_per_day',
    ],
    [
      'usage cap on a budgetable dimension',
      {
        process: { meterCeilings: {}, usagePerDay: { tokens: 1000 } },
        counters: { ...counters, processUsageDay: { tokens: 1000 } },
      },
      'usage_per_day:tokens',
    ],
    [
      'executor usage cap',
      {
        executor: { usagePerDay: { tokens: 10 }, softHoldUntil: null, stalenessMinutes: 30 },
        counters: { ...counters, executorUsageDay: { tokens: 11 } },
      },
      'executor_usage_per_day:tokens',
    ],
    [
      'soft-hold from a recent retryAfterSeconds',
      { executor: { softHoldUntil: new Date(now.getTime() + 60_000), stalenessMinutes: 30 } },
      'soft_hold',
    ],
  ])('%s → throttled %s', (_name, patch, binding) => {
    const out = budget(input(patch), now);
    expect(out.ok).toBe(false);
    expect(out.binding).toBe(binding);
    expect(out.detail).toBeTruthy();
  });

  it('admits the run that reaches the cap (a cap of 5 allows 5 runs)', () => {
    expect(budget(input({ counters: { ...counters, processRunsHour: 4 } }), now).ok).toBe(true);
  });

  it('ignores caps on non-budgetable or undeclared dimensions', () => {
    const out = budget(
      input({
        process: { meterCeilings: {}, usagePerDay: { duration_seconds: 1, bogus: 1 } },
        counters: { ...counters, processUsageDay: { duration_seconds: 100, bogus: 100 } },
      }),
      now,
    );
    expect(out.ok).toBe(true);
    expect(out.checks.filter((c) => c.check.startsWith('usage_per_day')).every((c) => c.pass)).toBe(
      true,
    );
  });

  it('an expired soft-hold does not throttle', () => {
    const out = budget(
      input({ executor: { softHoldUntil: minutesAgo(1), stalenessMinutes: 30 } }),
      now,
    );
    expect(out.ok).toBe(true);
  });

  it('names the first binding limit in TDD order when several fail', () => {
    const out = budget(
      input({
        counters: { ...counters, processRunsDay: 99 },
        executor: { softHoldUntil: new Date(now.getTime() + 1000), stalenessMinutes: 30 },
      }),
      now,
    );
    expect(out.binding).toBe('runs_per_day');
  });
});

describe('meter ceilings with fresh and stale readings', () => {
  const ceilings = { five_hour: { events: 85, sweeps: 95 } };
  const reading = (utilization: number, observedMinutesAgo = 5) => ({
    utilization,
    observedAt: minutesAgo(observedMinutesAgo),
    estimated: false,
    resetsAt: null,
  });

  it.each<[string, BudgetInput['kind'], number, number, boolean]>([
    ['event batch under the events ceiling', 'event', 80, 5, true],
    ['event batch at the events ceiling', 'event', 85, 5, false],
    ['sweep between the ceilings is admitted', 'sweep', 90, 5, true],
    ['sweep above the sweeps ceiling', 'sweep', 96, 5, false],
    ['manual runs use the sweeps ceiling', 'manual', 90, 5, true],
    ['a stale reading does not throttle', 'event', 99, 31, true],
  ])('%s', (_name, kind, utilization, age, ok) => {
    const out = budget(
      input({
        kind,
        process: { meterCeilings: ceilings },
        meters: { five_hour: reading(utilization, age) },
      }),
      now,
    );
    expect(out.ok).toBe(ok);
    if (!ok) expect(out.binding).toBe('meter:five_hour');
  });

  it('flags meter_stale when the reading is older than the staleness, and counters still apply', () => {
    const out = budget(
      input({
        process: { runsPerHour: 1, meterCeilings: ceilings },
        meters: { five_hour: reading(99, 45) },
        counters: { ...counters, processRunsHour: 1 },
      }),
      now,
    );
    expect(out.meterStale).toEqual(['five_hour']);
    expect(out.binding).toBe('runs_per_hour');
  });

  it('flags meter_stale when there is no reading at all', () => {
    const out = budget(input({ process: { meterCeilings: ceilings } }), now);
    expect(out).toMatchObject({ ok: true, meterStale: ['five_hour'] });
  });

  it('uses the executor staleness override', () => {
    const out = budget(
      input({
        process: { meterCeilings: ceilings },
        executor: { softHoldUntil: null, stalenessMinutes: 60 },
        meters: { five_hour: reading(99, 45) },
      }),
      now,
    );
    expect(out.binding).toBe('meter:five_hour');
  });

  it('records the reading used in the check data', () => {
    const out = budget(
      input({ process: { meterCeilings: ceilings }, meters: { five_hour: reading(40) } }),
      now,
    );
    expect(out.checks.find((c) => c.check === 'meter:five_hour')).toMatchObject({
      used: 40,
      limit: 85,
      pass: true,
    });
  });
});
