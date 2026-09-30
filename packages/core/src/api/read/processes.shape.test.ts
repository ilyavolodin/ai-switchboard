import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../clock.js';
import { hourCountsByProcess, NO_HOUR_COUNTS, sparklineFrom } from './processes.shape.js';

describe('hourCountsByProcess', () => {
  it('folds each process’s counted rows, and gives every id an entry', () => {
    const counts = hourCountsByProcess(
      ['a', 'b'],
      [
        { processId: 'a', outcome: 'batched', n: 3 },
        { processId: 'a', outcome: 'deduped', n: 1 },
      ],
      [
        { processId: 'a', outcome: 'invoked', n: 1 },
        { processId: 'a', outcome: 'merged', n: 1 },
        { processId: 'a', outcome: 'throttled', n: 1 },
        { processId: 'a', outcome: 'rejected', n: 1 },
      ],
      [
        { processId: 'a', status: 'ok', n: 1 },
        { processId: 'a', status: 'unknown', n: 1 },
        { processId: 'a', status: 'uncertain', n: 1 },
      ],
    );
    expect(counts.get('a')).toEqual({
      matched: 4,
      batched: 3,
      passed: 2,
      stopped: 1,
      invoked: 3,
      ok: 1,
      bad: 1,
    });
    expect(counts.get('b')).toEqual(NO_HOUR_COUNTS);
  });
});

describe('sparklineFrom', () => {
  it('gives the last seven UTC days, oldest first, zero when a day had no runs', () => {
    const now = new FakeClock('2026-01-05T09:40:00Z').now();
    expect(
      sparklineFrom(
        [
          { day: '2026-01-05T00:00:00Z', n: 4 },
          { day: '2025-12-30T00:00:00Z', n: 2 },
          { day: '2025-12-29T00:00:00Z', n: 9 },
        ],
        now,
      ),
    ).toEqual([2, 0, 0, 0, 0, 0, 4]);
  });
});
