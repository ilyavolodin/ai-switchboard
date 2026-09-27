import { describe, expect, it } from 'vitest';

import { childExitCode } from './deps.js';

describe('childExitCode', () => {
  it.each([
    [0, null, 0],
    [3, null, 3],
    [null, 'SIGTERM', 143],
    [null, 'SIGINT', 130],
    [null, null, 1],
  ] as const)('code %s, signal %s → %s', (code, signal, expected) => {
    expect(childExitCode(code, signal)).toBe(expected);
  });
});
