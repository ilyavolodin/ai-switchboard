import { describe, expect, it } from 'vitest';

import { groupBy } from './collections.js';

describe('groupBy', () => {
  it('keeps keys in first-seen order and items in input order', () => {
    const out = groupBy(['b1', 'a1', 'b2', 'a2', 'c1'], (s) => s[0]);
    expect([...out.entries()]).toEqual([
      ['b', ['b1', 'b2']],
      ['a', ['a1', 'a2']],
      ['c', ['c1']],
    ]);
  });
});
