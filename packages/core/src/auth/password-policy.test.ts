import { describe, expect, it } from 'vitest';

import { passwordProblem } from './password-policy.js';

describe('passwordProblem', () => {
  it.each<[string, string, RegExp | null]>([
    ['short1', 'alice@acme.test', /at least 12/],
    ['x'.repeat(257), 'alice@acme.test', /at most 256/],
    ['alice@acme.test', 'alice@acme.test', /email/],
    ['ALICE@ACME.TEST', 'alice@acme.test', /email/],
    ['alice.example', 'alice.example@acme.test', /email/],
    ['password1234', 'alice@acme.test', /too common/],
    ['Password1234', 'alice@acme.test', /too common/],
    ['aaaaaaaaaaaaaa', 'alice@acme.test', /too common/],
    ['river-lamp-quiet-77', 'alice@acme.test', null],
  ])('%s for %s', (password, email, expected) => {
    const problem = passwordProblem(password, email);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });
});
