import { describe, expect, it } from 'vitest';

import { passwordError, passwordRules } from './passwordRules.js';

describe('passwordRules', () => {
  it('reports length and email rules', () => {
    expect(passwordError('short', 'a@b.test')).toMatch(/12 characters/);
    expect(passwordError('alice@acme.test', 'alice@acme.test')).toMatch(/email/);
    expect(passwordError('river-lamp-quiet-7', 'alice@acme.test')).toBeNull();
    expect(passwordRules('river-lamp-quiet-7', 'alice@acme.test').every((r) => r.met)).toBe(true);
  });
});
