import { describe, expect, it } from 'vitest';

import { isDomainError } from './errors.js';
import { isRecoveryError, RecoveryError } from './recovery.js';

describe('RecoveryError', () => {
  it('is recognised by shape', () => {
    expect(isRecoveryError(new RecoveryError('unknown_user', 'x', ['a@b.c']))).toBe(true);
    expect(isRecoveryError(new Error('x'))).toBe(false);
    expect(isRecoveryError(null)).toBe(false);
  });

  it.each([
    ['unknown_user', 'not_found'],
    ['invalid_password', 'bad_request'],
    ['invalid_email', 'bad_request'],
    ['no_reason', 'bad_request'],
  ] as const)('%s is a %s refusal', (code, kind) => {
    const err = new RecoveryError(code, 'x');
    expect(isDomainError(err)).toBe(true);
    expect(err).toMatchObject({ name: 'RecoveryError', code, kind });
  });
});
