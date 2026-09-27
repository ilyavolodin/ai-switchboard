import { describe, expect, it } from 'vitest';

import { formatAmount } from './format.js';

describe('formatAmount', () => {
  it.each([
    [0.01, '0.01'],
    [0.007, '0.007'],
    [2.345, '2.35'],
    [185, '185'],
    [48_200, '48.2k'],
  ])('%s → %s', (n, text) => {
    // Real usage reports fractional costs and durations; they must not round to 0.
    expect(formatAmount(n)).toBe(text);
  });
});
