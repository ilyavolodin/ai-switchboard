import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PluginSearchResponse, PluginSummary, PluginTypeDTO } from '../../src/api/contract.js';
import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import { auditLog, notifiers, plugins, pluginTypes } from '../../src/db/schema.js';
import { silentLogger } from '../../src/logger.js';
import { PluginHost } from '../../src/plugins/host.js';
import { listInstalled, type RunNpm } from '../../src/plugins/install.js';
import type { RegistryFetch } from '../../src/plugins/search.js';
import { createRecordingTelemetry } from '../../src/telemetry/telemetry.js';
import { createApiHarness, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * Installing plugins at runtime: the host hot-loads a freshly installed package (no restart),
 * records it in Postgres, and every other replica converges on the record — at boot and on its
 * sync pass — by installing it into its own $SWITCHBOARD_HOME. npm is a fake that "installs" by
 * copying fixture package directories; the fixtures import the SDK's built dist, as a real
 * installed plugin would (needs `pnpm --filter @ai-switchboard/sdk build`).
 */

const sdkDir = join(dirname(fileURLToPath(import.meta.url)), '../../../sdk');

let tdb: TestDatabase;
let root: string;

interface FixturePackage {
  name: string;
  version: string;
  dir: string;
}

/** A notifier plugin package whose entry is plain JS importing the SDK. */
async function writeFixture(name: string, version: string, typeId: string): Promise<string> {
  const dir = join(root, 'fixtures', `${name.replace('/', '__')}-${version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version,
      type: 'module',
      keywords: ['switchboard-plugin'],
      switchboard: { entry: './plugin.js', sdk: '^1.0.0' },
    }),
  );
  await writeFile(
    join(dir, 'plugin.js'),
    `import { definePlugin } from '@ai-switchboard/sdk';
export default definePlugin({ id: '${typeId}-plugin', displayName: '${typeId} ${version}',
  capabilities: { network: ['api.acme.test'] },
  notifiers: [{ id: '${typeId}', displayName: '${typeId}', settingsSchema: { type: 'object' },
    create: () => ({ send: async () => {}, health: async () => ({ status: 'healthy', checkedAt: new Date().toISOString() }) }) }] });`,
  );
  return dir;
}

/** `$home/plugins/node_modules/@ai-switchboard/sdk` → the SDK's dist, so installed entries import it. */
async function prepareHome(name: string): Promise<string> {
  const home = join(root, name);
  const sdkPkg = join(home, 'plugins', 'node_modules', '@ai-switchboard', 'sdk');
  await mkdir(sdkPkg, { recursive: true });
  await writeFile(
    join(sdkPkg, 'package.json'),
    JSON.stringify({
      name: '@ai-switchboard/sdk',
      type: 'module',
      exports: { '.': './dist/index.js' },
    }),
  );
  await symlink(join(sdkDir, 'dist'), join(sdkPkg, 'dist'));
  await symlink(join(sdkDir, 'node_modules'), join(sdkPkg, 'node_modules'));
  return home;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/** A fake npm over a spec → package map: `install` copies the fixture, `uninstall` removes it. */
function fakeNpm(registry: Record<string, FixturePackage>): RunNpm & { installs: string[] } {
  const installs: string[] = [];
  const run: RunNpm = async (args, cwd) => {
    const [cmd, spec = ''] = args;
    const pkgPath = join(cwd, 'package.json');
    const lockPath = join(cwd, 'package-lock.json');
    const manifest = await readJson(pkgPath);
    let deps = { ...(manifest.dependencies as Record<string, string>) };
    if (cmd === 'install') {
      const pkg = registry[spec];
      if (!pkg) throw new Error(`npm install failed: 404 ${spec}`);
      installs.push(spec);
      const target = join(cwd, 'node_modules', pkg.name);
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await cp(pkg.dir, target, { recursive: true });
      deps[pkg.name] = `^${pkg.version}`;
      const lock = await readJson(lockPath).catch(() => ({ packages: {} }));
      (lock.packages as Record<string, unknown>)[`node_modules/${pkg.name}`] = {
        version: pkg.version,
        integrity: `sha512-${pkg.name}-${pkg.version}`,
      };
      await writeFile(lockPath, JSON.stringify(lock));
    } else if (cmd === 'uninstall') {
      deps = Object.fromEntries(Object.entries(deps).filter(([name]) => name !== spec));
      await rm(join(cwd, 'node_modules', spec), { recursive: true, force: true });
    }
    await writeFile(pkgPath, JSON.stringify({ ...manifest, dependencies: deps }));
    return { stdout: '', stderr: '' };
  };
  return Object.assign(run, { installs });
}

const ECHO = '@acme/ai-switchboard-notifier-echo';
const BELL = 'ai-switchboard-notifier-bell';
let registry: Record<string, FixturePackage>;

beforeAll(async () => {
  tdb = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'sb-install-'));
  const echo1 = { name: ECHO, version: '1.0.0', dir: await writeFixture(ECHO, '1.0.0', 'echo') };
  const echo11 = { name: ECHO, version: '1.1.0', dir: await writeFixture(ECHO, '1.1.0', 'echo') };
  const bell = { name: BELL, version: '0.2.0', dir: await writeFixture(BELL, '0.2.0', 'bell') };
  registry = {
    [ECHO]: echo1,
    [`${ECHO}@1.0.0`]: echo1,
    [`${ECHO}@^1.1.0`]: echo11,
    [`${ECHO}@1.1.0`]: echo11,
    [BELL]: bell,
    [`${BELL}@^0.2.0`]: bell,
    [`${BELL}@0.2.0`]: bell,
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await tdb.destroy();
});

function host(home: string, runNpm: RunNpm): PluginHost {
  return new PluginHost({
    db: tdb.db,
    clock: new FakeClock(),
    logger: silentLogger(),
    telemetry: createRecordingTelemetry(),
    config: testConfig({ home }),
    scanDirs: [{ path: join(home, 'plugins', 'node_modules'), origin: 'installed' }],
    runNpm,
  });
}

describe('hot install and replica convergence', () => {
  let a: PluginHost;
  let c: PluginHost;
  let npmC: ReturnType<typeof fakeNpm>;
  let notifierId: string;

  it('hot-loads an installed package: types, rows and waiting instances, no restart', async () => {
    // Replica C is already running before anything is installed.
    npmC = fakeNpm(registry);
    c = host(await prepareHome('c'), npmC);
    await c.boot();

    const [row] = await tdb.db
      .insert(notifiers)
      .values({ typeId: 'echo', name: 'Echo', settings: {} })
      .returning();
    notifierId = row!.id;

    a = host(await prepareHome('a'), fakeNpm(registry));
    await a.boot();
    expect(a.notifierType('echo')).toBeUndefined();
    expect(a.instanceError(notifierId)).toBe('plugin_unavailable');

    const result = await a.installAndLoad(ECHO);
    expect(result.pendingRestart).toBe(false);
    expect(result.plugin).toMatchObject({ name: ECHO, status: 'loaded', version: '1.0.0' });
    expect(a.notifierType('echo')?.pluginName).toBe(ECHO);
    expect(a.notifier(notifierId)).toBeDefined();

    const [p] = await tdb.db.select().from(plugins).where(eq(plugins.name, ECHO));
    expect(p).toMatchObject({
      status: 'loaded',
      origin: 'installed',
      version: '1.0.0',
      installSpec: ECHO,
      installVersion: '1.0.0',
      capabilities: { network: ['api.acme.test'] },
    });
    const [t] = await tdb.db
      .select()
      .from(pluginTypes)
      .where(and(eq(pluginTypes.kind, 'notifier'), eq(pluginTypes.typeId, 'echo')));
    expect(t).toMatchObject({ plugin: ECHO, available: true });
  });

  it('a running replica installs and hot-loads the recorded plugin on its sync pass, once', async () => {
    expect(c.notifierType('echo')).toBeUndefined();
    await c.syncInstalled();
    expect(c.notifierType('echo')?.pluginName).toBe(ECHO);
    expect(c.notifier(notifierId)).toBeDefined();
    // Pinned to the recorded version so every replica runs the same code.
    expect(npmC.installs).toEqual([`${ECHO}@1.0.0`]);
    await c.syncInstalled();
    expect(npmC.installs).toHaveLength(1);
  });

  it('a fresh replica with an empty home installs recorded plugins at boot', async () => {
    const npmB = fakeNpm(registry);
    const b = host(await prepareHome('b'), npmB);
    await b.boot();
    expect(npmB.installs).toEqual([`${ECHO}@1.0.0`]);
    expect(b.notifierType('echo')?.pluginName).toBe(ECHO);
    expect(b.loaded.find((p) => p.name === ECHO)?.origin).toBe('installed');
  });

  it('upgrading a loaded plugin reports pendingRestart; replicas install the new version', async () => {
    const result = await a.installAndLoad(`${ECHO}@^1.1.0`);
    expect(result.pendingRestart).toBe(true);
    expect(result.install.version).toBe('1.1.0');
    const [p] = await tdb.db.select().from(plugins).where(eq(plugins.name, ECHO));
    // The running code is still 1.0.0; the record asks for 1.1.0.
    expect(p).toMatchObject({ version: '1.0.0', installVersion: '1.1.0' });

    await c.syncInstalled();
    expect(npmC.installs).toEqual([`${ECHO}@1.0.0`, `${ECHO}@1.1.0`]);
    const locked = (await listInstalled(join(root, 'c'))).find((l) => l.name === ECHO);
    expect(locked?.version).toBe('1.1.0');
    expect(c.loaded.find((l) => l.name === ECHO)?.version).toBe('1.0.0');
  });

  it('logs a recorded install that fails and keeps going', async () => {
    await tdb.db.insert(plugins).values({
      name: 'ai-switchboard-source-gone',
      pluginId: 'gone',
      displayName: 'gone',
      version: '9.9.9',
      sdkRange: '^1.0.0',
      status: 'unavailable',
      origin: 'installed',
      installSpec: 'ai-switchboard-source-gone',
      installVersion: '9.9.9',
    });
    await expect(c.syncInstalled()).resolves.toBeUndefined();
    expect(c.notifierType('echo')).toBeDefined();
    await tdb.db.delete(plugins).where(eq(plugins.name, 'ai-switchboard-source-gone'));
  });
});

describe('plugins API: search, install and remove', () => {
  let h: ApiHarness;
  let registryUp = true;
  const searched: string[] = [];
  const object = (name: string, version = '0.2.0') => ({
    package: {
      name,
      version,
      description: `${name} description`,
      date: '2026-01-02T03:04:05.000Z',
      publisher: { username: 'acme-dev' },
      links: { npm: `https://www.npmjs.com/package/${name}` },
    },
    downloads: { weekly: 42, monthly: 170 },
  });
  const registryFetch: RegistryFetch = (url) => {
    searched.push(url);
    if (!registryUp) return Promise.reject(new Error('getaddrinfo ENOTFOUND registry.test'));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          objects: [
            object(BELL),
            object(ECHO, '1.1.0'),
            object('@ai-switchboard/notifier-slack', '1.0.0'),
            object('ai-switchboard-source-other'),
            object('left-pad'),
            object('@ai-switchboard/sdk'),
          ],
        }),
    });
  };
  const reason = 'integration test';
  let viewerToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    h = await createApiHarness(tdb, {
      home: await prepareHome('api'),
      runNpm: fakeNpm(registry),
      registryFetch,
    });
    const token = async (role: string) => {
      const res = await h.request('POST', '/api/v1/tokens', {
        cookie: h.adminCookie,
        body: { name: `${role}-token`, role, reason },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ secret: string }>().secret;
    };
    viewerToken = await token('viewer');
    operatorToken = await token('operator');
  });

  afterAll(async () => {
    await h.close();
  });

  it('searches the registry for convention-named plugins of a kind, for any role', async () => {
    const res = await h.request('GET', '/api/v1/plugins/search?kind=notifier&q=bell', {
      token: viewerToken,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<PluginSearchResponse>();
    expect(body.registry).toBe('https://registry.npmjs.org');
    expect(body.results.map((r) => r.package)).toEqual([
      BELL,
      ECHO,
      '@ai-switchboard/notifier-slack',
    ]);
    expect(body.results[0]).toEqual({
      package: BELL,
      kind: 'notifier',
      version: '0.2.0',
      description: `${BELL} description`,
      publisher: 'acme-dev',
      date: '2026-01-02T03:04:05.000Z',
      links: { npm: `https://www.npmjs.com/package/${BELL}` },
      weeklyDownloads: 42,
      installed: false,
      installedVersion: null,
      reviewed: false,
    });
    // The harness's boot installed the recorded echo plugin into this replica's home.
    expect(body.results[1]).toMatchObject({ installed: true, installedVersion: '1.1.0' });
    expect(body.results[2]).toMatchObject({ reviewed: true });
    expect(searched.map((u) => new URL(u).searchParams.get('text'))).toEqual([
      'ai-switchboard-notifier bell',
      'keywords:switchboard-plugin bell',
    ]);
  });

  it('refuses an unknown kind and says when the registry is unreachable', async () => {
    const bad = await h.request('GET', '/api/v1/plugins/search?kind=widget', {
      token: viewerToken,
    });
    expect(bad.statusCode).toBe(400);
    registryUp = false;
    try {
      const offline = await h.request('GET', '/api/v1/plugins/search', { token: viewerToken });
      expect(offline.statusCode).toBe(503);
      expect(offline.json<{ error: string; message: string }>()).toMatchObject({
        error: 'registry_unavailable',
        message: expect.stringMatching(/unreachable.*ENOTFOUND/),
      });
    } finally {
      registryUp = true;
    }
  });

  it('keeps inspect, install and remove admin-only', async () => {
    for (const [method, url, body] of [
      ['POST', '/api/v1/plugins/inspect', { package: BELL }],
      ['POST', '/api/v1/plugins', { package: BELL, reason }],
      ['DELETE', `/api/v1/plugins/${encodeURIComponent(ECHO)}`, { reason }],
    ] as const) {
      const res = await h.request(method, url, { token: operatorToken, body });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json<{ message: string }>().message).toMatch(/admin role/);
    }
  });

  it('installs, loads at once and audits; the new type is usable with no restart', async () => {
    const res = await h.request('POST', '/api/v1/plugins', {
      cookie: h.adminCookie,
      body: { package: BELL, range: '^0.2.0', reason: 'bells please' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<PluginSummary>()).toMatchObject({
      name: BELL,
      status: 'loaded',
      origin: 'installed',
      version: '0.2.0',
      pendingRestart: false,
      types: [{ kind: 'notifier', typeId: 'bell', instanceCount: 0 }],
    });
    const types = await h.request('GET', '/api/v1/plugin-types?kind=notifier', {
      cookie: h.adminCookie,
    });
    expect(types.json<PluginTypeDTO[]>()).toContainEqual(
      expect.objectContaining({ typeId: 'bell', plugin: BELL, available: true }),
    );
    const created = await h.request('POST', '/api/v1/notifiers', {
      cookie: h.adminCookie,
      body: { typeId: 'bell', name: 'Bell', settings: {}, reason },
    });
    expect(created.statusCode, created.body).toBe(201);

    const [audit] = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.scope, 'plugin'), eq(auditLog.targetId, BELL)));
    expect(audit).toMatchObject({
      field: 'installed',
      reason: 'bells please',
      after: expect.objectContaining({ spec: `${BELL}@^0.2.0`, version: '0.2.0', loaded: true }),
    });
  });

  it('removes a plugin so replicas stop installing it', async () => {
    const res = await h.request('DELETE', `/api/v1/plugins/${encodeURIComponent(BELL)}`, {
      cookie: h.adminCookie,
      body: { reason: 'not needed' },
    });
    expect(res.statusCode, res.body).toBe(204);
    const [row] = await tdb.db.select().from(plugins).where(eq(plugins.name, BELL));
    expect(row).toMatchObject({ installSpec: null, installVersion: null });
    const list = await h.request('GET', '/api/v1/plugins', { cookie: h.adminCookie });
    expect(list.json<PluginSummary[]>().find((p) => p.name === BELL)).toBeDefined();
  });
});
