import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createTestContext,
  pluginConformanceChecks,
  runConformance,
  secretProviderConformanceChecks,
} from '@ai-switchboard/sdk/testing';

import plugin, { envSecretProviderType } from './plugin.js';

runConformance('plugin', pluginConformanceChecks(plugin), { describe, it });

describe('with seeded variables', () => {
  beforeAll(() => {
    vi.stubEnv('SBCONF_FIXTURE_TOKEN', 'fixture-secret-conformance');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  runConformance(
    'env secret provider',
    secretProviderConformanceChecks(envSecretProviderType, {
      settings: { prefix: 'SBCONF_' },
      expectNames: ['FIXTURE_TOKEN'],
    }),
    { describe, it },
  );
});

describe('env secret provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const make = (settings = {}): ReturnType<typeof envSecretProviderType.create> =>
    envSecretProviderType.create(settings, createTestContext());

  it('uses the id env', () => {
    expect(envSecretProviderType.id).toBe('env');
  });

  it('resolves a variable', async () => {
    vi.stubEnv('FIXTURE_TOKEN', 'fixture-secret');
    expect(await make().resolve('FIXTURE_TOKEN')).toBe('fixture-secret');
  });

  it('applies the prefix', async () => {
    vi.stubEnv('SB_FIXTURE_TOKEN', 'fixture-secret-prefixed');
    vi.stubEnv('FIXTURE_TOKEN', 'unprefixed');
    expect(await make({ prefix: 'SB_' }).resolve('FIXTURE_TOKEN')).toBe('fixture-secret-prefixed');
  });

  it('throws a clear error, naming the variable but no value, when unset or empty', async () => {
    vi.stubEnv('FIXTURE_EMPTY', '');
    await expect(make({ prefix: 'SB_' }).resolve('FIXTURE_MISSING')).rejects.toThrow(
      'Environment variable SB_FIXTURE_MISSING is not set or is empty',
    );
    await expect(make().resolve('FIXTURE_EMPTY')).rejects.toThrow(/FIXTURE_EMPTY is not set/);
    await expect(make().resolve('FIXTURE_EMPTY')).rejects.toMatchObject({
      name: 'SecretNotFoundError',
    });
  });

  it('rejects names that are not variable names', async () => {
    await expect(make().resolve('')).rejects.toThrow(/not a valid/);
    await expect(make().resolve('A-B')).rejects.toThrow(/not a valid/);
    await expect(make().resolve('../etc')).rejects.toThrow(/not a valid/);
  });

  it('rejects an invalid prefix', () => {
    expect(() => make({ prefix: 'bad-prefix' })).toThrow(/prefix/);
  });

  describe('list', () => {
    const names = async (settings = {}): Promise<string[]> =>
      (await make(settings).list?.())?.map((s) => s.name) ?? [];

    it('lists only prefixed variables, with the prefix stripped', async () => {
      vi.stubEnv('SBLIST_GITHUB_TOKEN', 'fixture-secret-a');
      vi.stubEnv('SBLIST_SLACK_URL', 'fixture-secret-b');
      vi.stubEnv('OTHER_TOKEN', 'fixture-secret-c');
      expect(await names({ prefix: 'SBLIST_' })).toEqual(['GITHUB_TOKEN', 'SLACK_URL']);
    });

    it('returns names only, never a value', async () => {
      vi.stubEnv('SBLIST_GITHUB_TOKEN', 'fixture-secret-a');
      const listing = await make({ prefix: 'SBLIST_' }).list?.();
      expect(listing).toEqual([{ name: 'GITHUB_TOKEN' }]);
      expect(JSON.stringify(listing)).not.toContain('fixture-secret-a');
    });

    it('leaves out empty variables, which would not resolve', async () => {
      vi.stubEnv('SBLIST_EMPTY', '');
      vi.stubEnv('SBLIST_SET', 'fixture-secret');
      expect(await names({ prefix: 'SBLIST_' })).toEqual(['SET']);
    });

    it('without a prefix, leaves out system variables', async () => {
      vi.stubEnv('PATH', '/usr/bin');
      vi.stubEnv('HOME', '/home/x');
      vi.stubEnv('LC_ALL', 'C');
      vi.stubEnv('NODE_OPTIONS', '--x');
      vi.stubEnv('npm_config_cache', '/tmp');
      vi.stubEnv('FIXTURE_LISTED_TOKEN', 'fixture-secret');
      const listed = await names();
      expect(listed).toContain('FIXTURE_LISTED_TOKEN');
      for (const system of ['PATH', 'HOME', 'LC_ALL', 'NODE_OPTIONS', 'npm_config_cache'])
        expect(listed).not.toContain(system);
    });

    it('narrows the listing with include globs, without affecting resolve', async () => {
      vi.stubEnv('SBLIST_GITHUB_TOKEN', 'fixture-secret-a');
      vi.stubEnv('SBLIST_GITHUB_APP_KEY', 'fixture-secret-b');
      vi.stubEnv('SBLIST_SLACK_URL', 'fixture-secret-c');
      vi.stubEnv('SBLIST_DATADOG_KEY', 'fixture-secret-d');
      const settings = { prefix: 'SBLIST_', include: 'GITHUB_*, SLACK_URL' };
      expect(await names(settings)).toEqual(['GITHUB_APP_KEY', 'GITHUB_TOKEN', 'SLACK_URL']);
      expect(await make(settings).resolve('DATADOG_KEY')).toBe('fixture-secret-d');
    });

    it('rejects an include with characters other than names, stars and commas', () => {
      expect(() => make({ include: 'A.*' })).toThrow(/include/);
    });
  });

  it('is healthy', async () => {
    expect((await make().health()).status).toBe('healthy');
  });
});
