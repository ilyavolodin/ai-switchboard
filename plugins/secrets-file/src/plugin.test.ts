import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
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

runConformance('plugin', pluginConformanceChecks(plugin, {}), { describe, it });

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

  describe('writes', () => {
    let store: string;
    beforeAll(async () => {
      store = join(root, 'store');
      await mkdir(store);
    });
    const writable = () => make({ directory: store, writable: true });

    it('is read-only unless writes are turned on', () => {
      const provider = make();
      expect(provider).not.toHaveProperty('set');
      expect(provider).not.toHaveProperty('delete');
      expect(writable()).toHaveProperty('set');
    });

    it('creates, replaces and deletes a secret file', async () => {
      const provider = writable();
      await provider.set?.('rotated', 'fixture-secret-one');
      expect(await provider.resolve('rotated')).toBe('fixture-secret-one');
      await provider.set?.('rotated', 'fixture-secret-two');
      expect(await readFile(join(store, 'rotated'), 'utf8')).toBe('fixture-secret-two');
      await provider.delete?.('rotated');
      await expect(provider.resolve('rotated')).rejects.toMatchObject({
        name: 'SecretNotFoundError',
      });
      await expect(provider.delete?.('rotated')).resolves.toBeUndefined();
    });

    it('writes through a temporary file and leaves none behind', async () => {
      const provider = writable();
      const set = (value: string): Promise<void> =>
        provider.set?.('busy', value) ?? Promise.reject(new Error('not writable'));
      await Promise.all(Array.from({ length: 5 }, (_, i) => set(`fixture-secret-${i}`)));
      expect((await readdir(store)).filter((n) => n.includes('busy'))).toEqual(['busy']);
      expect(await provider.resolve('busy')).toMatch(/^fixture-secret-\d$/);
    });

    it('creates new files 0600 and keeps the mode of an existing one', async () => {
      const provider = writable();
      await provider.set?.('fresh', 'fixture-secret-fresh');
      expect((await stat(join(store, 'fresh'))).mode & 0o777).toBe(0o600);
      await writeFile(join(store, 'shared'), 'fixture-secret-old');
      await chmod(join(store, 'shared'), 0o640);
      await provider.set?.('shared', 'fixture-secret-new');
      expect((await stat(join(store, 'shared'))).mode & 0o777).toBe(0o640);
    });

    it.each(['../outside', 'a/b', '', '.hidden', 'x\0y'])(
      'refuses to write the unsafe name %j without echoing the value',
      async (name) => {
        const err: unknown = await writable()
          .set?.(name, 'fixture-secret-unsafe')
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).not.toContain('fixture-secret-unsafe');
      },
    );

    it('is unhealthy when writes are on but the directory is read-only', async () => {
      const readOnly = join(root, 'read-only');
      await mkdir(readOnly);
      await chmod(readOnly, 0o500);
      try {
        if (process.getuid?.() !== 0) {
          const health = await make({ directory: readOnly, writable: true }).health();
          expect(health.status).toBe('unhealthy');
          expect(health.message).toMatch(/not writable/);
        }
      } finally {
        await chmod(readOnly, 0o700);
      }
    });

    it('passes the conformance checks with writes on', async () => {
      for (const check of secretProviderConformanceChecks(fileSecretProviderType, {
        settings: { directory: store, writable: true },
      })) {
        await check.run();
      }
    });
  });
});
