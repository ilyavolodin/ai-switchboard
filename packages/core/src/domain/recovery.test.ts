import { describe, expect, it } from 'vitest';

import { isRecoveryError } from './recovery.js';

const shaped = (fields: Record<string, unknown>): Error =>
  Object.assign(new Error('x'), { name: 'RecoveryError', ...fields });

describe('isRecoveryError', () => {
  it.each([
    [shaped({ code: 'unknown_user', suggestions: ['a@b.c'] }), true],
    [shaped({ code: 'no_reason', suggestions: [] }), true],
    [shaped({ code: 'something_else', suggestions: [] }), false],
    [shaped({ code: 'unknown_user' }), false],
    [{ name: 'RecoveryError', code: 'unknown_user', suggestions: [] }, false],
    [new Error('x'), false],
    [null, false],
  ])('%o is %s', (err, expected) => {
    expect(isRecoveryError(err)).toBe(expected);
  });
});
