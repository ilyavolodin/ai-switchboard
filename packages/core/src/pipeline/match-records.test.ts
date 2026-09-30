import { describe, expect, it } from 'vitest';

import { matchRecords } from './match-records.js';

const now = new Date('2026-03-02T10:00:00Z');
const at = now.toISOString();

describe('matchRecords', () => {
  it('records each evaluation with the batch key of a match, then each skipped trigger', () => {
    expect(
      matchRecords(
        [
          { processId: 'p1', triggerId: 't1', filter: 'x', result: true },
          { processId: 'p2', triggerId: 't2', result: false, error: 'boom' },
        ],
        new Map([
          ['p1', { key: 'acme/api' }],
          ['p2', { key: 'ignored' }],
        ]),
        [{ processId: 'p3', triggerId: 't3', skip: 'process_disabled' }],
        now,
      ),
    ).toEqual([
      { processId: 'p1', triggerId: 't1', expr: 'x', result: true, batchKey: 'acme/api', at },
      { processId: 'p2', triggerId: 't2', result: false, error: 'boom', at },
      { processId: 'p3', triggerId: 't3', result: false, skip: 'process_disabled', at },
    ]);
  });

  it('records a group-by error on a match', () => {
    const [record] = matchRecords(
      [{ processId: 'p1', triggerId: 't1', result: true }],
      new Map([['p1', { key: '', error: 'no field' }]]),
      [],
      now,
    );
    expect(record).toMatchObject({ error: 'groupBy: no field', batchKey: '' });
  });
});
