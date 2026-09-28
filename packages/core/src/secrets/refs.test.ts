import { describe, expect, it } from 'vitest';

import {
  collectDocumentSecretRefs,
  collectSecretRefs,
  formatSecretRef,
  literalSecretFields,
  parseSecretRef,
  redactSecretValues,
  referencesProvider,
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

describe('redactSecretValues', () => {
  it('replaces secret values inside nested strings and leaves the rest', () => {
    const out = redactSecretValues(
      { a: 'token abcd-1234 refused', list: ['x', 'abcd-1234abcd-1234'], n: 3, short: 'abc' },
      ['abcd-1234', 'abc'],
    );
    expect(out).toEqual({
      a: 'token [redacted] refused',
      list: ['x', '[redacted][redacted]'],
      n: 3,
      short: 'abc',
    });
  });
});

describe('document references', () => {
  it('finds secret:// fields and $secretRef calls in expressions', () => {
    const doc = {
      destination: { target: { token: 'secret://vault/A' } },
      mapping: {
        input: "{ 'k': $secretRef('vault/B'), 'j': $secretRef( \"secret://env/C\" ) }",
      },
      triggers: [{ filter: "$secretRef('nopath') and $secretRef(name)" }],
    };
    expect(collectDocumentSecretRefs(doc)).toEqual([
      { path: 'destination.target.token', ref: 'secret://vault/A' },
      { path: 'mapping.input', ref: 'secret://vault/B' },
      { path: 'mapping.input', ref: 'secret://env/C' },
    ]);
  });

  it('tells whether settings reference a provider', () => {
    const settings = { a: 'secret://vault/A', b: ['plain', 'secret://env/X'] };
    expect(referencesProvider(settings, new Set(['env']))).toBe(true);
    expect(referencesProvider(settings, new Set(['vault-2']))).toBe(false);
    expect(referencesProvider({}, new Set(['env']))).toBe(false);
  });
});
