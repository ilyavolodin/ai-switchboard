import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTestContext,
  pluginConformanceChecks,
  runConformance,
} from '@ai-switchboard/sdk/testing';

import plugin, { envSecretProviderType } from './plugin.js';

runConformance('plugin', pluginConformanceChecks(plugin), { describe, it });

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

  it('is healthy', async () => {
    expect((await make().health()).status).toBe('healthy');
  });
});
