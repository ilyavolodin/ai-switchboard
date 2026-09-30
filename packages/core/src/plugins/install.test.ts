import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inspectPlugin,
  installPlugin,
  isPluginInstallError,
  listInstalled,
  removePlugin,
  specPackageName,
  type RunNpm,
} from './install.js';

interface FakePackage {
  name: string;
  version: string;
  switchboard?: Record<string, string>;
  /** Source of `dist/plugin.js`; omitted = no file. */
  entrySource?: string;
  integrity?: string;
}

const pluginSource = (caps: string): string => `export default {
  id: 'acme-jira',
  displayName: 'Jira',
  sources: [{ id: 'jira', displayName: 'Jira' }],
  destinations: [],
  notifiers: [],
  secretProviders: [],
  capabilities: ${caps},
  switchboardSdk: { major: 2, version: '2.0.0' },
};
`;

const jira: FakePackage = {
  name: '@acme/switchboard-source-jira',
  version: '1.2.0',
  switchboard: { entry: './dist/plugin.js', sdk: '^2.0.0' },
  entrySource: pluginSource("{ network: ['*.atlassian.net'], secrets: ['api-token'] }"),
  integrity: 'sha512-fakeintegrity==',
};

async function writePackage(dir: string, pkg: FakePackage): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true });
  const manifest: Record<string, unknown> = { name: pkg.name, version: pkg.version };
  if (pkg.switchboard) manifest.switchboard = pkg.switchboard;
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
  if (pkg.entrySource !== undefined)
    await writeFile(join(dir, 'dist', 'plugin.js'), pkg.entrySource);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/** A fake npm that "installs" packages from a registry map by writing node_modules files. */
function fakeNpm(registry: Record<string, FakePackage>): RunNpm & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> => {
    calls.push(args);
    const [cmd, spec = ''] = args;
    const pkgPath = join(cwd, 'package.json');
    const lockPath = join(cwd, 'package-lock.json');
    if (cmd === 'install') {
      const pkg = registry[spec];
      if (!pkg) throw new Error(`404 ${spec}`);
      await writePackage(join(cwd, 'node_modules', pkg.name), pkg);
      const root = await readJson(pkgPath);
      root.dependencies = { ...(root.dependencies as object), [pkg.name]: `^${pkg.version}` };
      await writeFile(pkgPath, JSON.stringify(root));
      const lock = await readJson(lockPath).catch(() => ({ packages: {} }));
      (lock.packages as Record<string, unknown>)[`node_modules/${pkg.name}`] = {
        version: pkg.version,
        integrity: pkg.integrity,
      };
      await writeFile(lockPath, JSON.stringify(lock));
    } else if (cmd === 'uninstall') {
      await rm(join(cwd, 'node_modules', spec), { recursive: true, force: true });
      const root = await readJson(pkgPath);
      root.dependencies = Object.fromEntries(
        Object.entries(root.dependencies as Record<string, string>).filter(([k]) => k !== spec),
      );
      await writeFile(pkgPath, JSON.stringify(root));
    } else if (cmd === 'pack') {
      const pkg = registry[spec];
      if (!pkg) throw new Error(`404 ${spec}`);
      const staging = join(cwd, 'staging');
      await writePackage(join(staging, 'package'), pkg);
      const filename = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
      execFileSync('tar', ['-czf', join(cwd, filename), '-C', staging, 'package']);
      await rm(staging, { recursive: true, force: true });
      return {
        stdout: JSON.stringify([
          { name: pkg.name, version: pkg.version, filename, integrity: pkg.integrity },
        ]),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
  return Object.assign(run, { calls });
}

let home: string;
const now = (): Date => new Date('2026-09-27T12:00:00.000Z');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sb-install-test-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('installPlugin', () => {
  it('installs, reads capabilities and pins version and integrity in the lockfile', async () => {
    const runNpm = fakeNpm({ '@acme/switchboard-source-jira@^1': jira });
    const result = await installPlugin({
      home,
      spec: '@acme/switchboard-source-jira@^1',
      runNpm,
      now,
    });

    expect(result).toMatchObject({
      name: '@acme/switchboard-source-jira',
      version: '1.2.0',
      integrity: 'sha512-fakeintegrity==',
      sdkRange: '^2.0.0',
      compatible: true,
      capabilities: { network: ['*.atlassian.net'], secrets: ['api-token'] },
      plugin: {
        pluginId: 'acme-jira',
        types: [{ kind: 'source', typeId: 'jira', displayName: 'Jira' }],
      },
      warnings: [],
    });
    expect(runNpm.calls[0]).toEqual([
      'install',
      '@acme/switchboard-source-jira@^1',
      '--save',
      '--install-links',
      '--ignore-scripts=false',
      '--no-audit',
      '--no-fund',
    ]);

    const pluginsPkg = await readJson(join(home, 'plugins', 'package.json'));
    expect(pluginsPkg.private).toBe(true);
    const lock = await readJson(join(home, 'plugins.lock.json'));
    expect(lock.plugins).toEqual({
      '@acme/switchboard-source-jira': {
        version: '1.2.0',
        integrity: 'sha512-fakeintegrity==',
        sdk: '^2.0.0',
        installedAt: '2026-09-27T12:00:00.000Z',
        spec: '@acme/switchboard-source-jira@^1',
      },
    });
  });

  it('removes a package without a switchboard field and refuses it', async () => {
    const runNpm = fakeNpm({ 'left-pad': { name: 'left-pad', version: '1.3.0' } });
    const err: unknown = await installPlugin({ home, spec: 'left-pad', runNpm }).catch(
      (e: unknown) => e,
    );
    expect(isPluginInstallError(err)).toBe(true);
    expect((err as Error).message).toMatch(/not a Switchboard plugin/);
    expect(runNpm.calls.map((c) => c[0])).toEqual(['install', 'uninstall']);
    expect(await listInstalled(home)).toEqual([]);
  });

  it('installs but returns undefined capabilities with a warning when the entry fails to import', async () => {
    const broken = { ...jira, entrySource: 'throw new Error("boom at import");' };
    const result = await installPlugin({
      home,
      spec: 'jira',
      runNpm: fakeNpm({ jira: broken }),
      now,
    });
    expect(result.capabilities).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(/boom at import/);
    expect((await listInstalled(home)).map((p) => p.name)).toEqual([
      '@acme/switchboard-source-jira',
    ]);
  });

  it('refuses what the host would never load: a field without an entry or an sdk range', async () => {
    const fields: Record<string, string>[] = [
      { source: './dist/plugin.js', sdk: '^2.0.0' },
      { entry: './dist/plugin.js' },
    ];
    for (const switchboard of fields) {
      const runNpm = fakeNpm({ x: { ...jira, switchboard } });
      const err: unknown = await installPlugin({ home, spec: 'x', runNpm }).catch(
        (e: unknown) => e,
      );
      expect(isPluginInstallError(err)).toBe(true);
      expect((err as Error).message).toMatch(/not a Switchboard plugin: .*(entry|sdk)/);
      expect(runNpm.calls.map((c) => c[0])).toEqual(['install', 'uninstall']);
      expect(await listInstalled(home)).toEqual([]);
    }
  });

  it('reads capabilities from the file the host loads: the source in dev or when the entry is not built', async () => {
    const devOnly: FakePackage = {
      ...jira,
      switchboard: { entry: './dist/plugin.js', source: './src/missing.ts', sdk: '^2.0.0' },
    };
    const dev = await installPlugin({
      home,
      spec: 'd',
      runNpm: fakeNpm({ d: devOnly }),
      allowSource: true,
    });
    expect(dev.warnings.join()).toMatch(/could not import \.\/src\/missing\.ts/);

    const unbuilt: FakePackage = {
      ...jira,
      name: '@acme/switchboard-source-unbuilt',
      switchboard: { entry: './dist/missing.js', source: './dist/plugin.js', sdk: '^2.0.0' },
    };
    const withSource = await installPlugin({ home, spec: 'x', runNpm: fakeNpm({ x: unbuilt }) });
    expect(withSource.capabilities).toEqual({
      network: ['*.atlassian.net'],
      secrets: ['api-token'],
    });
  });

  it('flags an incompatible SDK range', async () => {
    const future = { ...jira, switchboard: { entry: './dist/plugin.js', sdk: '^3.0.0' } };
    const result = await installPlugin({ home, spec: 'f', runNpm: fakeNpm({ f: future }) });
    expect(result.compatible).toBe(false);
    expect(result.warnings.join()).toMatch(/does not satisfy/);
  });
});

describe('installPlugin edge cases', () => {
  it('refuses a spec that npm would read as an option', async () => {
    const runNpm = fakeNpm({});
    for (const spec of ['--registry=https://evil.example', '-g']) {
      const err: unknown = await installPlugin({ home, spec, runNpm }).catch((e: unknown) => e);
      expect(isPluginInstallError(err)).toBe(true);
    }
    await expect(inspectPlugin({ spec: '--foo', runNpm, tmpRoot: home })).rejects.toThrow(
      /not a package spec/,
    );
    expect(runNpm.calls).toEqual([]);
  });

  it('names a corrupt lockfile and does not run npm', async () => {
    await writeFile(join(home, 'plugins.lock.json'), '{ not json');
    const runNpm = fakeNpm({ jira });
    const err: unknown = await installPlugin({ home, spec: 'jira', runNpm }).catch(
      (e: unknown) => e,
    );
    expect(isPluginInstallError(err)).toBe(true);
    expect((err as Error).message).toMatch(/plugins\.lock\.json is not valid JSON/);
    expect(runNpm.calls).toEqual([]);
    await expect(listInstalled(home)).rejects.toThrow(/plugins\.lock\.json is not valid JSON/);
  });

  it('restores the pinned version when an upgrade is not a plugin', async () => {
    const notPlugin: FakePackage = { name: jira.name, version: '2.0.0' };
    const runNpm = fakeNpm({ jira, 'jira-next': notPlugin, [`${jira.name}@1.2.0`]: jira });
    await installPlugin({ home, spec: 'jira', runNpm, now });

    const err: unknown = await installPlugin({ home, spec: 'jira-next', runNpm }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/not a Switchboard plugin.*1\.2\.0 was restored/);
    expect(runNpm.calls.at(-1)?.slice(0, 2)).toEqual(['install', `${jira.name}@1.2.0`]);
    const pkg = await readJson(join(home, 'plugins', 'node_modules', jira.name, 'package.json'));
    expect(pkg.version).toBe('1.2.0');
    expect((await listInstalled(home)).map((p) => [p.name, p.version])).toEqual([
      [jira.name, '1.2.0'],
    ]);
  });

  it('never runs two npm commands in one home at once', async () => {
    const other: FakePackage = { ...jira, name: '@acme/switchboard-source-other' };
    const inner = fakeNpm({ jira, other });
    let running = 0;
    let most = 0;
    const runNpm: RunNpm = async (args, cwd) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await inner(args, cwd);
      } finally {
        running--;
      }
    };
    await Promise.all([
      installPlugin({ home, spec: 'jira', runNpm, now }),
      installPlugin({ home, spec: 'other', runNpm, now }),
    ]);
    expect(most).toBe(1);
    expect((await listInstalled(home)).map((p) => p.name)).toEqual([jira.name, other.name]);
  });
});

describe('removePlugin and listInstalled', () => {
  it('uninstalls and drops the lockfile entry', async () => {
    const runNpm = fakeNpm({ jira });
    await installPlugin({ home, spec: 'jira', runNpm, now });
    expect(await listInstalled(home)).toHaveLength(1);

    await removePlugin({ home, name: '@acme/switchboard-source-jira', runNpm });
    expect(runNpm.calls.at(-1)?.slice(0, 2)).toEqual([
      'uninstall',
      '@acme/switchboard-source-jira',
    ]);
    expect(await listInstalled(home)).toEqual([]);
  });

  it('refuses to remove something that is not installed', async () => {
    await expect(removePlugin({ home, name: 'nope', runNpm: fakeNpm({}) })).rejects.toThrow(
      /not installed/,
    );
  });

  it('returns an empty list without a lockfile', async () => {
    expect(await listInstalled(join(home, 'missing'))).toEqual([]);
  });
});

describe('inspectPlugin', () => {
  it('reads the manifest from the packed tarball without installing', async () => {
    const result = await inspectPlugin({
      spec: 'jira@1.2.0',
      runNpm: fakeNpm({ 'jira@1.2.0': jira }),
      tmpRoot: home,
    });
    expect(result).toMatchObject({
      name: '@acme/switchboard-source-jira',
      version: '1.2.0',
      sdkRange: '^2.0.0',
      compatible: true,
      integrity: 'sha512-fakeintegrity==',
      capabilities: { network: ['*.atlassian.net'], secrets: ['api-token'] },
    });
  });

  it('rejects a tarball that is not a plugin', async () => {
    await expect(
      inspectPlugin({
        spec: 'left-pad',
        runNpm: fakeNpm({ 'left-pad': { name: 'left-pad', version: '1.0.0' } }),
        tmpRoot: home,
      }),
    ).rejects.toThrow(/not a Switchboard plugin/);
  });
});

describe('specPackageName', () => {
  it.each([
    ['@acme/switchboard-source-jira@^1', '@acme/switchboard-source-jira'],
    ['@acme/x', '@acme/x'],
    ['left-pad@1.3.0', 'left-pad'],
    ['left-pad', 'left-pad'],
    ['./local/dir', undefined],
    ['https://example.com/x.tgz', undefined],
    ['github:acme/x', undefined],
    ['acme/x', undefined],
  ])('%s → %s', (spec, name) => {
    expect(specPackageName(spec)).toBe(name);
  });
});
