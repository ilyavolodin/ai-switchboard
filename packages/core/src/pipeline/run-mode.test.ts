import { describe, expect, it } from 'vitest';

import { runMode } from './run-mode.js';

describe('runMode', () => {
  it.each([
    ['event', 3, 'event'],
    ['event', 0, 'event'],
    ['sweep', 0, 'sweep'],
    ['sweep', 4, 'sweep'],
    ['manual', 2, 'event'],
    ['manual', 0, 'sweep'],
  ] as const)('%s batch with %d events maps as %s', (kind, count, want) => {
    expect(runMode(kind, count)).toBe(want);
  });
});
