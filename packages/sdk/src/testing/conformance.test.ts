import { describe, expect, it } from 'vitest';

import type { SecretListing, SecretProvider, SecretProviderType } from '../index.js';
import {
  ConformanceFailure,
  runConformance,
  secretProviderConformanceChecks,
  type ConformanceCheck,
} from './index.js';

const VALUES: Record<string, string> = {
  GITHUB_TOKEN: 'fixture-secret-github',
  PIN: 'abc',
};

function providerType(list?: () => Promise<unknown[]>): SecretProviderType {
  return {
    id: 'demo',
    displayName: 'Demo',
    settingsSchema: { type: 'object', properties: {} },
    create: (): SecretProvider => ({
      resolve: (name) => {
        const value = VALUES[name];
        return value === undefined
          ? Promise.reject(new Error(`${name} is not set`))
          : Promise.resolve(value);
      },
      health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date(0).toISOString() }),
      ...(list ? { list: list as () => Promise<SecretListing[]> } : {}),
    }),
  };
}

async function failures(checks: ConformanceCheck[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const check of checks) {
    try {
      await check.run();
    } catch (err) {
      expect(err).toBeInstanceOf(ConformanceFailure);
      out[check.name] = (err as Error).message;
    }
  }
  return out;
}

const good = providerType(() =>
  Promise.resolve([
    { name: 'GITHUB_TOKEN', updatedAt: '2026-01-01T00:00:00.000Z' },
    { name: 'PIN', description: 'door code' },
  ]),
);

runConformance(
  'a provider that lists names only',
  secretProviderConformanceChecks(good, { settings: {}, expectNames: ['GITHUB_TOKEN'] }),
  { describe, it },
);

runConformance(
  'a provider without list()',
  secretProviderConformanceChecks(providerType(), { settings: {} }),
  { describe, it },
);

describe('secretProviderConformanceChecks', () => {
  it('fails a provider whose listing carries a value in an extra field', async () => {
    const leaky = providerType(() =>
      Promise.resolve([{ name: 'GITHUB_TOKEN', value: 'fixture-secret-github' }]),
    );
    const failed = await failures(secretProviderConformanceChecks(leaky, { settings: {} }));
    expect(failed['list() returns well-formed names']).toMatch(/unexpected field "value"/);
    expect(failed['list() never contains a secret value']).toMatch(/contains a secret value/);
  });

  it('fails a provider that leaks part of a value in the description', async () => {
    const leaky = providerType(() =>
      Promise.resolve([{ name: 'GITHUB_TOKEN', description: 'starts fixture-secret-github…' }]),
    );
    const failed = await failures(secretProviderConformanceChecks(leaky, { settings: {} }));
    expect(failed['list() never contains a secret value']).toMatch(/contains a secret value/);
  });

  it('matches a short value only as an exact field', async () => {
    const shortLeak = providerType(() => Promise.resolve([{ name: 'PIN', description: 'abc' }]));
    const failed = await failures(secretProviderConformanceChecks(shortLeak, { settings: {} }));
    expect(failed['list() never contains a secret value']).toBeDefined();
    // "abc" inside a longer word is not a leak worth failing on.
    const fine = providerType(() => Promise.resolve([{ name: 'PIN', description: 'fabcd' }]));
    expect(await failures(secretProviderConformanceChecks(fine, { settings: {} }))).toEqual({});
  });

  it('checks the extra secrets fixture even for names that do not resolve', async () => {
    const leaky = providerType(() =>
      Promise.resolve([{ name: 'UNSET', description: 'fixture-secret-extra' }]),
    );
    const failed = await failures(
      secretProviderConformanceChecks(leaky, { settings: {}, secrets: ['fixture-secret-extra'] }),
    );
    expect(failed['list() never contains a secret value']).toBeDefined();
  });

  it('fails on missing, duplicate or malformed entries', async () => {
    const bad = providerType(() =>
      Promise.resolve([{ name: 'PIN' }, { name: 'PIN' }, { name: 'X', updatedAt: 'yesterday' }]),
    );
    const failed = await failures(
      secretProviderConformanceChecks(bad, { settings: {}, expectNames: ['GITHUB_TOKEN'] }),
    );
    expect(failed['list() returns well-formed names']).toMatch(/twice/);
    const noName = providerType(() => Promise.resolve([{ description: 'x' }]));
    expect(
      (await failures(secretProviderConformanceChecks(noName, { settings: {} })))[
        'list() returns well-formed names'
      ],
    ).toMatch(/no name/);
    const missing = providerType(() => Promise.resolve([{ name: 'PIN' }]));
    expect(
      (
        await failures(
          secretProviderConformanceChecks(missing, { settings: {}, expectNames: ['GITHUB_TOKEN'] }),
        )
      )['list() returns well-formed names'],
    ).toMatch(/expected name "GITHUB_TOKEN"/);
    const badTime = providerType(() => Promise.resolve([{ name: 'X', updatedAt: 'yesterday' }]));
    expect(
      (await failures(secretProviderConformanceChecks(badTime, { settings: {} })))[
        'list() returns well-formed names'
      ],
    ).toMatch(/ISO-8601/);
  });
});
