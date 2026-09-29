import { describe, expect, it } from 'vitest';

import { countsTowardBudget, neverInvoked } from './counted.js';

describe('counted runs', () => {
  it.each([
    ['failed', 0, false, true, false],
    ['failed', 1, false, false, true],
    ['held', 1, false, false, false],
    ['ok', 1, true, false, false],
    ['ok', 1, false, false, true],
    ['invoking', 0, false, false, true],
  ] as const)('%s after %d attempts (dry run %s)', (status, attempts, dryRun, never, counts) => {
    expect(neverInvoked({ status, attempts })).toBe(never);
    expect(countsTowardBudget({ status, attempts, dryRun })).toBe(counts);
  });
});
