import { describe, expect, it } from 'vitest';

import {
  collectSecretRefs,
  formatSecretRef,
  literalSecretFields,
  parseSecretRef,
  resolveSecretRefs,
} from './refs.js';

describe('secret references', () => {
  it('parses and formats', () => {
    expect(parseSecretRef('secret://env/GITHUB_TOKEN')).toEqual({
      provider: 'env',
      name: 'GITHUB_TOKEN',
    });
    expect(parseSecretRef('secret://file/nested/name')).toEqual({
      provider: 'file',
      name: 'nested/name',
    });
    expect(parseSecretRef('secret://env/')).toBeNull();
    expect(parseSecretRef('secret:///x')).toBeNull();
    expect(parseSecretRef('plain')).toBeNull();
    expect(formatSecretRef({ provider: 'vault', name: 'a' })).toBe('secret://vault/a');
  });

  it('collects references with their paths', () => {
    expect(
      collectSecretRefs({
        token: 'secret://env/T',
        nested: { key: 'secret://file/k' },
        list: ['secret://env/L'],
        n: 1,
      }),
    ).toEqual([
      { path: 'token', ref: 'secret://env/T' },
      { path: 'nested.key', ref: 'secret://file/k' },
      { path: 'list[0]', ref: 'secret://env/L' },
    ]);
  });

  it('resolves deeply and reports the values', async () => {
    const { value, secrets } = await resolveSecretRefs(
      { token: 'secret://env/T', name: 'x', headers: { a: 'secret://env/H' } },
      (ref) => Promise.resolve(`value-of-${ref.slice(-1)}`),
    );
    expect(value).toEqual({ token: 'value-of-T', name: 'x', headers: { a: 'value-of-H' } });
    expect(secrets).toEqual(['value-of-T', 'value-of-H']);
  });

  it('flags literal values in x-secret fields', () => {
    expect(
      literalSecretFields(['token', 'auth.key', 'empty'], {
        token: 'ghp_literal',
        auth: { key: 'secret://env/K' },
        empty: '',
      }),
    ).toEqual(['token']);
  });
});
