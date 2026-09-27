import { describe, expect, it } from 'vitest';

import { FakeClock } from '../clock.js';

import { dedupe, dedupeWindowStart, DEDUPE_WINDOW_SECONDS } from './dedupe.js';

describe('dedupe', () => {
  const clock = new FakeClock('2026-01-10T12:00:00Z');
  const now = clock.now();
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  it.each([
    ['a first delivery is new', [], 'batched'],
    ['a redelivery a minute later collapses', [{ id: 'd1', createdAt: ago(60) }], 'deduped'],
    ['a redelivery 6 days later collapses', [{ id: 'd1', createdAt: ago(6 * 86400) }], 'deduped'],
    [
      'the same key after 7 days is new again',
      [{ id: 'd1', createdAt: ago(DEDUPE_WINDOW_SECONDS + 1) }],
      'batched',
    ],
  ])('%s', (_name, prior, outcome) => {
    expect(dedupe(prior, now).outcome).toBe(outcome);
  });

  it('names the earliest duplicate', () => {
    expect(
      dedupe(
        [
          { id: 'late', createdAt: ago(10) },
          { id: 'early', createdAt: ago(100) },
        ],
        now,
      ),
    ).toEqual({ outcome: 'deduped', duplicateOf: 'early' });
  });

  it('a new version is a new key, so the service never finds prior dispatches for it', () => {
    // Keys are `${type}:${kind}:${id}:${version}`; version 2 has no prior dispatches.
    expect(dedupe([], now)).toEqual({ outcome: 'batched' });
  });

  it('window start is 7 days back', () => {
    expect(dedupeWindowStart(now).toISOString()).toBe('2026-01-03T12:00:00.000Z');
  });
});
