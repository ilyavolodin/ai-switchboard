import { describe, expect, it } from 'vitest';

import { SecretNotFoundError, type SecretProvider } from '@ai-switchboard/sdk';
import { createMemoryState } from '@ai-switchboard/sdk/testing';

import { silentLogger } from '../logger.js';

import {
  chooseStore,
  createInstanceSecrets,
  instanceSecretName,
  referencedProviders,
} from './instance-secrets.js';
import { guardInstanceState } from '../plugins/plugin-context.js';

function readOnly(values: Record<string, string> = {}): SecretProvider {
  return {
    resolve: (name) => {
      const v = values[name];
      return v === undefined ? Promise.reject(new SecretNotFoundError(name)) : Promise.resolve(v);
    },
    health: () => Promise.resolve({ status: 'healthy', checkedAt: '' }),
  };
}

function writable(): SecretProvider & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    resolve: (name) => {
      const v = data.get(name);
      return v === undefined ? Promise.reject(new SecretNotFoundError(name)) : Promise.resolve(v);
    },
    health: () => Promise.resolve({ status: 'healthy', checkedAt: '' }),
    set: (name, value) => {
      data.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      data.delete(name);
      return Promise.resolve();
    },
  };
}

describe('referencedProviders', () => {
  it('lists each provider once, in reference order', () => {
    expect(
      referencedProviders({
        token: 'secret://env/TOKEN',
        usage: { refresh: 'secret://file/seat', other: 'secret://env/X' },
        plain: 'not-a-ref',
      }),
    ).toEqual(['env', 'file']);
  });
});

describe('chooseStore', () => {
  const providers: Record<string, SecretProvider> = { env: readOnly(), file: writable() };
  const lookup = (name: string) => providers[name];
  const cases: { name: string; referenced: string[]; expected: RegExp | string }[] = [
    { name: 'the first writable reference', referenced: ['env', 'file'], expected: 'file' },
    { name: 'no reference at all', referenced: [], expected: /reference no secret provider/ },
    { name: 'only read-only ones', referenced: ['env'], expected: /"env" cannot store values/ },
    {
      name: 'a provider that is not running',
      referenced: ['vault'],
      expected: /"vault" is not running/,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const choice = chooseStore(c.referenced, lookup);
      if (typeof c.expected === 'string') {
        expect(choice.writable && choice.target.name).toBe(c.expected);
      } else {
        expect(choice.writable).toBe(false);
        expect(!choice.writable && choice.reason).toMatch(c.expected);
      }
    });
  }
});

describe('createInstanceSecrets', () => {
  const settings = { seed: 'secret://env/SEED', key: 'secret://file/api' };

  it('stores under a name derived from the instance and key, in the referenced provider', async () => {
    const file = writable();
    const known = new Set<string>();
    const secrets = createInstanceSecrets({
      instanceId: 'i-1',
      settings,
      provider: (n) => (n === 'file' ? file : n === 'env' ? readOnly() : undefined),
      logger: silentLogger(),
      known,
    });
    expect(await secrets.check()).toEqual({ writable: true, provider: 'file' });
    expect(await secrets.get('oauth')).toBeUndefined();
    await secrets.set('oauth', 'fixture-secret-rotated');
    expect(file.data.get(instanceSecretName('i-1', 'oauth'))).toBe('fixture-secret-rotated');
    expect(await secrets.get('oauth')).toBe('fixture-secret-rotated');
    expect(known.has('fixture-secret-rotated')).toBe(true);
    await secrets.delete('oauth');
    expect(await secrets.get('oauth')).toBeUndefined();
  });

  it('fails clearly, and never falls back, without a writable provider', async () => {
    const secrets = createInstanceSecrets({
      instanceId: 'i-1',
      settings: { seed: 'secret://env/SEED' },
      provider: () => readOnly(),
      logger: silentLogger(),
      known: new Set(),
    });
    expect(await secrets.check()).toMatchObject({ writable: false });
    await expect(secrets.set('oauth', 'fixture-secret-x')).rejects.toMatchObject({
      name: 'SecretStoreError',
      message: expect.stringMatching(/"env" cannot store values/),
    });
    expect(await secrets.get('oauth')).toBeUndefined();
  });

  it('refuses a malformed key', async () => {
    const secrets = createInstanceSecrets({
      instanceId: 'i-1',
      settings,
      provider: () => writable(),
      logger: silentLogger(),
      known: new Set(),
    });
    await expect(secrets.set('../Oauth', 'fixture-secret-x')).rejects.toThrow(/not a valid/);
  });

  it('redacts the value if a provider error echoes it', async () => {
    const leaky: SecretProvider = {
      ...readOnly(),
      set: (_n, value) => Promise.reject(new Error(`disk full writing ${value}`)),
      delete: () => Promise.resolve(),
    };
    const secrets = createInstanceSecrets({
      instanceId: 'i-1',
      settings,
      provider: () => leaky,
      logger: silentLogger(),
      known: new Set(),
    });
    const err = (await secrets
      .set('oauth', 'fixture-secret-leak')
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/disk full/);
    expect(err.message).not.toContain('fixture-secret-leak');
  });
});

describe('guardInstanceState', () => {
  it('refuses a value that carries a known secret, anywhere in it', async () => {
    const state = createMemoryState();
    const guarded = guardInstanceState(state, new Set(['fixture-secret-refresh']));
    await expect(
      guarded.set('oauth', { nested: { refreshToken: 'fixture-secret-refresh' } }),
    ).rejects.toMatchObject({ name: 'SecretInStateError' });
    expect(state.data).toEqual({});
    await guarded.set('oauth', { seed: 'abc', expiresAt: '2026-01-01T00:00:00Z' });
    expect(await guarded.get('oauth')).toEqual({ seed: 'abc', expiresAt: '2026-01-01T00:00:00Z' });
  });

  it('ignores very short values, which would match by accident', async () => {
    const guarded = guardInstanceState(createMemoryState(), new Set(['abc']));
    await expect(guarded.set('k', 'abcdef')).resolves.toBeUndefined();
  });

  it('uses the same threshold as redaction, so a short credential is still refused', async () => {
    const guarded = guardInstanceState(createMemoryState(), new Set(['pin42']));
    await expect(guarded.set('k', { code: 'pin42' })).rejects.toMatchObject({
      name: 'SecretInStateError',
    });
  });
});
