import { describe, expect, it } from 'vitest';

import { formatAmount, formatCount, formatSeconds } from './format.js';

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

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [999.6, '1k'],
    [48_213, '48.2k'],
    [999_999, '1M'],
    [1_200_000, '1.2M'],
    [-2500, '-2.5k'],
  ])('%s → %s', (n, text) => {
    // Rounding must not produce "1000" or "1000k" at a unit boundary.
    expect(formatCount(n)).toBe(text);
  });
});

describe('formatSeconds', () => {
  it.each([
    [0, '0 s'],
    [45.4, '45 s'],
    [59.6, '1 m'],
    [119.7, '2 m'],
    [552, '9 m 12 s'],
    [3600, '1 h'],
  ])('%s → %s', (n, text) => {
    expect(formatSeconds(n)).toBe(text);
  });
});
