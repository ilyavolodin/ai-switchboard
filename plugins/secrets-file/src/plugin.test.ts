import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestContext,
  pluginConformanceChecks,
  runConformance,
  secretProviderConformanceChecks,
} from '@ai-switchboard/sdk/testing';

import plugin, { fileSecretProviderType } from './plugin.js';

runConformance('plugin', pluginConformanceChecks(plugin), { describe, it });

describe('file secret provider', () => {
  let root: string;
  let dir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'switchboard-secrets-'));
    dir = join(root, 'secrets');
    await mkdir(dir);
    await writeFile(join(dir, 'github-token'), 'fixture-secret\n');
    await writeFile(join(dir, 'crlf'), 'fixture-secret-crlf\r\n\r\n');
    await writeFile(join(dir, 'no-newline'), 'fixture-secret-raw');
    await writeFile(join(dir, 'inner-newline'), 'line1\nline2\n');
    await writeFile(join(dir, 'empty'), '\n');
    await writeFile(join(root, 'outside'), 'fixture-secret-outside');
    // Kubernetes mounts secrets as symlinks into a ..data directory.
    await mkdir(join(dir, '..data'));
    await writeFile(join(dir, '..data', 'linked'), 'fixture-secret-linked\n');
    await symlink(join(dir, '..data', 'linked'), join(dir, 'linked'));
    await symlink(join(dir, 'nowhere'), join(dir, 'dangling'));
    await writeFile(join(dir, '.hidden'), 'fixture-secret-hidden');
    await writeFile(join(dir, 'zero'), '');
    await mkdir(join(dir, 'subdir'));
    await utimes(join(dir, 'github-token'), new Date(0), new Date('2026-01-02T03:04:05.000Z'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const make = (
    settings: Record<string, unknown> = { directory: dir },
  ): ReturnType<typeof fileSecretProviderType.create> =>
    fileSecretProviderType.create(settings, createTestContext());

  it('uses the id file and defaults the directory to /run/secrets', () => {
    expect(fileSecretProviderType.id).toBe('file');
    expect(
      (fileSecretProviderType.settingsSchema.properties as Record<string, { default?: unknown }>)
        .directory?.default,
    ).toBe('/run/secrets');
  });

  it('reads a file and trims trailing newlines', async () => {
    const provider = make();
    expect(await provider.resolve('github-token')).toBe('fixture-secret');
    expect(await provider.resolve('crlf')).toBe('fixture-secret-crlf');
    expect(await provider.resolve('no-newline')).toBe('fixture-secret-raw');
    expect(await provider.resolve('inner-newline')).toBe('line1\nline2');
  });

  it('follows the symlinks Kubernetes mounts', async () => {
    expect(await make().resolve('linked')).toBe('fixture-secret-linked');
  });

  it('throws when the file is missing or empty', async () => {
    await expect(make().resolve('missing')).rejects.toThrow(/does not exist/);
    await expect(make().resolve('empty')).rejects.toThrow(/is empty/);
    await expect(make().resolve('missing')).rejects.toMatchObject({ name: 'SecretNotFoundError' });
  });

  it.each(['../outside', '..', '.', 'a/b', 'a\\b', '', 'x\0y', '..data'])(
    'rejects the unsafe name %j',
    async (name) => {
      await expect(make().resolve(name)).rejects.toThrow(/not a valid secret file name/);
    },
  );

  describe('list', () => {
    it('lists regular files, following symlinks and skipping dotfiles, dirs and empty files', async () => {
      const names = (await make().list?.())?.map((s) => s.name);
      expect(names).toEqual([
        'crlf',
        'empty',
        'github-token',
        'inner-newline',
        'linked',
        'no-newline',
      ]);
    });

    it('reports the mtime as updatedAt and never a value', async () => {
      const listing = (await make().list?.()) ?? [];
      expect(listing.find((s) => s.name === 'github-token')).toEqual({
        name: 'github-token',
        updatedAt: '2026-01-02T03:04:05.000Z',
      });
      expect(JSON.stringify(listing)).not.toMatch(/fixture-secret/);
    });

    it('throws a clear error when the directory cannot be listed', async () => {
      await expect(make({ directory: join(root, 'nope') }).list?.()).rejects.toThrow(
        /cannot be listed \(ENOENT\)/,
      );
    });

    it('passes the secret provider conformance checks', async () => {
      for (const check of secretProviderConformanceChecks(fileSecretProviderType, {
        settings: { directory: dir },
        expectNames: ['github-token', 'linked'],
      })) {
        await check.run();
      }
    });
  });

  it('is healthy when the directory is readable', async () => {
    expect((await make().health()).status).toBe('healthy');
  });

  it('is unhealthy when the directory is missing, a file, or unreadable', async () => {
    expect((await make({ directory: join(root, 'nope') }).health()).status).toBe('unhealthy');
    expect((await make({ directory: join(root, 'outside') }).health()).status).toBe('unhealthy');
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      // Root ignores permission bits; only assert when the check can observe them.
      if (process.getuid?.() !== 0) {
        expect((await make({ directory: locked }).health()).status).toBe('unhealthy');
      }
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('requires an absolute directory', () => {
    expect(() => make({ directory: 'relative/path' })).toThrow(/directory/);
  });
});
