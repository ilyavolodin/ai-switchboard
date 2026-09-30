import { describe, expect, it } from 'vitest';

import { BATCH_OUTCOMES, RUN_STATUSES } from '../../domain/status.js';
import { classifyBatches, classifyRuns } from './outcomes.js';

describe('classifyBatches', () => {
  it('counts each outcome into the groups the views share', () => {
    const counts = classifyBatches(BATCH_OUTCOMES.map((outcome) => ({ outcome, n: 1 })));
    expect(counts).toEqual({ total: 8, held: 3, throttled: 1, stopped: 3, passed: 2 });
  });

  it.each([
    ['held', { held: 2, stopped: 2, throttled: 0, passed: 0 }],
    ['rejected', { held: 2, stopped: 0, throttled: 0, passed: 0 }],
    ['awaiting_approval', { held: 2, stopped: 2, throttled: 0, passed: 0 }],
    ['throttled', { held: 0, stopped: 2, throttled: 2, passed: 0 }],
    ['merged', { held: 0, stopped: 0, throttled: 0, passed: 2 }],
    ['open', { held: 0, stopped: 0, throttled: 0, passed: 0 }],
  ] as const)('%s', (outcome, expected) => {
    expect(classifyBatches([{ outcome, n: 2 }])).toMatchObject({ total: 2, ...expected });
  });
});

describe('classifyRuns', () => {
  it('counts each status into the groups the views share', () => {
    const counts = classifyRuns(RUN_STATUSES.map((status) => ({ status, n: 1 })));
    expect(counts).toEqual({
      total: 8,
      ok: 1,
      error: 1,
      failed: 1,
      unknown: 2,
      running: 2,
      problem: 3,
    });
  });

  it('adds the counts of repeated rows', () => {
    expect(
      classifyRuns([
        { status: 'error', n: 2 },
        { status: 'error', n: 3 },
        { status: 'unknown', n: 1 },
      ]),
    ).toMatchObject({ total: 6, error: 5, problem: 6, unknown: 1 });
  });
});
