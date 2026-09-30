import { describe, expect, it } from 'vitest';

import type { UsageDimension } from '@ai-switchboard/sdk';

import { mergeUsage, sanitizeUsage } from './usage.js';

const dims: UsageDimension[] = [
  { id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true },
  { id: 'peak', title: 'Peak', unit: 'bytes', aggregate: 'max', budgetable: false },
];

describe('sanitizeUsage', () => {
  it('drops undeclared keys and non-numbers', () => {
    expect(sanitizeUsage({ tokens: 10, bogus: 1, peak: 'x' }, dims)).toEqual({
      usage: { tokens: 10 },
      dropped: ['bogus', 'peak'],
    });
  });

  it.each([
    ['nothing reported', undefined, { usage: null, dropped: [] }],
    ['null', null, { usage: null, dropped: [] }],
    ['not an object', [1], { usage: null, dropped: ['(not an object)'] }],
    ['a negative value', { tokens: -1 }, { usage: null, dropped: ['tokens'] }],
    ['a non-finite value', { tokens: Infinity }, { usage: null, dropped: ['tokens'] }],
  ])('%s', (_name, report, want) => {
    expect(sanitizeUsage(report, dims)).toEqual(want);
  });
});

describe('mergeUsage', () => {
  it('a later report replaces sums and keeps the max of max dimensions', () => {
    expect(mergeUsage({ tokens: 10, peak: 5 }, { tokens: 12, peak: 3 }, dims)).toEqual({
      tokens: 12,
      peak: 5,
    });
  });

  it('either side may be missing', () => {
    expect(mergeUsage(null, { tokens: 1 }, dims)).toEqual({ tokens: 1 });
    expect(mergeUsage({ tokens: 1 }, null, dims)).toEqual({ tokens: 1 });
  });
});
