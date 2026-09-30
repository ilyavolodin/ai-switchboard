import { describe, expect, it } from 'vitest';

import { isDomainError } from '../../services/errors.js';
import { decodeCursor, encodeCursor, pageLimit } from './paging.js';

const raw = (s: string) => Buffer.from(s).toString('base64url');

function refusal(cursor: string): unknown {
  try {
    decodeCursor(cursor);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('decodeCursor', () => {
  it('reads back what encodeCursor wrote', () => {
    const t = '2026-09-29T12:00:00.000Z';
    expect(decodeCursor(encodeCursor({ t, id: 'abc' }))).toEqual({ t, id: 'abc' });
    expect(decodeCursor(encodeCursor({ t }))).toEqual({ t });
  });

  it('starts at the first page without a cursor', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it.each([
    ['not base64 JSON', raw('not json')],
    ['JSON without a time', raw(JSON.stringify({ id: 'x' }))],
    ['a time Date cannot read', raw(JSON.stringify({ t: 'soon' }))],
    ['a JSON array', raw('[1,2]')],
  ])('answers 400 for a cursor that is not ours: %s', (_name, cursor) => {
    const err = refusal(cursor);
    expect(isDomainError(err) && err.kind).toBe('bad_request');
  });
});

describe('pageLimit', () => {
  it.each([
    [undefined, 50],
    [10, 10],
    [999, 200],
  ] as const)('%s → %i', (limit, expected) => {
    expect(pageLimit(limit)).toBe(expected);
  });
});
