import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  definePlugin,
  SecretNotFoundError,
  TransportError,
  type PluginContext,
} from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import {
  instanceState,
  notifiers,
  plugins,
  pluginTypes,
  secretProviders,
  sources,
} from '../../src/db/schema.js';
import { silentLogger } from '../../src/logger.js';
import { PluginHost } from '../../src/plugins/host.js';
import { createRecordingTelemetry } from '../../src/telemetry/telemetry.js';
import { testPlugin, testSourceType } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const sdkDir = join(dirname(fileURLToPath(import.meta.url)), '../../../sdk');

let tdb: TestDatabase;
let root: string;

async function writePlugin(name: string, options: { sdk?: string; body: string }): Promise<void> {
  const dir = join(root, 'node_modules', ...name.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '2.3.4',
      type: 'module',
      switchboard: { entry: './plugin.js', sdk: options.sdk ?? '^2.0.0' },
    }),
  );
  await writeFile(join(dir, 'plugin.js'), options.body);
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'sb-host-'));
  await mkdir(join(root, 'node_modules', '@ai-switchboard'), { recursive: true });
  // The plugins below import the SDK's built dist, as an installed plugin would (no source
  // condition): a package.json exporting dist plus a link to packages/sdk/dist. Needs `pnpm build`.
  const sdkPkg = join(root, 'node_modules', '@ai-switchboard', 'sdk');
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
  await writePlugin('@acme/good', {
    body: `import { definePlugin } from '@ai-switchboard/sdk';
export default definePlugin({ id: 'acme-good', displayName: 'Good', capabilities: { network: ['api.acme.test'] },
  notifiers: [{ id: 'acme-notify', displayName: 'Acme notify', settingsSchema: { type: 'object' },
    create: () => ({ send: async () => {}, health: async () => ({ status: 'healthy', checkedAt: new Date().toISOString() }) }) }] });`,
  });
  // Built against SDK 1.x (before executor became destination): refused, not loaded.
  await writePlugin('@acme/incompatible', { sdk: '^1.0.0', body: 'export default {};' });
  await writePlugin('@acme/broken', { body: `throw new Error('boom at import');` });
  await writePlugin('@acme/invalid', {
    body: `import { definePlugin } from '@ai-switchboard/sdk';
export default definePlugin({ id: 'Not_Kebab', displayName: 'Invalid' });`,
  });
  await writePlugin('@acme/bad-export', { body: 'export default 1;' });
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(
    join(root, 'node_modules', 'left-pad', 'package.json'),
    JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await tdb.destroy();
});

function host(extra: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}): PluginHost {
  return new PluginHost({
    db: tdb.db,
    clock: new FakeClock(),
    logger: silentLogger(),
    telemetry: createRecordingTelemetry(),
    config: testConfig({ home: root }),
    scanDirs: [{ path: join(root, 'node_modules'), origin: 'installed' }],
    ...extra,
  });
}

describe('plugin host', () => {
  it('discovers, validates and registers plugin packages', async () => {
    const h = host();
    await h.boot();
    const byName = Object.fromEntries(h.loaded.map((p) => [p.name, p]));
    expect(byName['@acme/good']).toMatchObject({ status: 'loaded' });
    expect(byName['@acme/incompatible']).toMatchObject({
      status: 'incompatible',
      message: expect.stringMatching(/\^1\.0\.0; running SDK is 2\.\d+\.\d+/),
    });
    expect(byName['@acme/broken']).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/boom at import/),
    });
    expect(byName['@acme/invalid']).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/kebab-case/),
    });
    expect(byName['@acme/bad-export']).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/definePlugin/),
    });
    expect(byName['left-pad']).toBeUndefined();
    expect(h.notifierType('acme-notify')?.pluginName).toBe('@acme/good');

    const [row] = await tdb.db.select().from(plugins).where(eq(plugins.name, '@acme/good'));
    expect(row).toMatchObject({
      status: 'loaded',
      version: '2.3.4',
      capabilities: { network: ['api.acme.test'] },
    });
    const types = await tdb.db
      .select()
      .from(pluginTypes)
      .where(eq(pluginTypes.plugin, '@acme/good'));
    expect(types).toEqual([
      expect.objectContaining({ kind: 'notifier', typeId: 'acme-notify', available: true }),
    ]);
  });

  it('marks a plugin that disappeared as unavailable and keeps its instances configured', async () => {
    const first = host({
      builtin: [{ name: 'test-plugin', version: '1.0.0', definition: testPlugin }],
    });
    await first.boot();
    process.env.HOST_TEST_SECRET = 's-host';
    const [src] = await tdb.db
      .insert(sources)
      .values({
        typeId: 'test-source',
        name: 'Needs plugin',
        settings: { secret: 'secret://env/HOST_TEST_SECRET' },
      })
      .returning();
    await first.reload('source', src!.id);
    expect(first.source(src!.id)).toBeDefined();

    const second = host();
    await second.boot();
    expect(second.source(src!.id)).toBeUndefined();
    expect(second.instanceError(src!.id)).toBe('plugin_unavailable');
    const [p] = await tdb.db.select().from(plugins).where(eq(plugins.name, 'test-plugin'));
    expect(p?.status).toBe('unavailable');
    const [t] = await tdb.db
      .select()
      .from(pluginTypes)
      .where(eq(pluginTypes.typeId, 'test-source'));
    expect(t?.available).toBe(false);
    const [still] = await tdb.db.select().from(sources).where(eq(sources.id, src!.id));
    expect(still?.settings).toEqual({ secret: 'secret://env/HOST_TEST_SECRET' });
  });

  it('resolves secret references through the provider named in the reference', async () => {
    const h = host({
      builtin: [{ name: 'test-plugin', version: '1.0.0', definition: testPlugin }],
    });
    await h.boot();
    process.env.RESOLVE_ME = 'resolved-value';
    await expect(h.resolveSecret('secret://env/RESOLVE_ME')).resolves.toBe('resolved-value');
    await expect(h.resolveSecret('secret://vault/x')).rejects.toThrow(/vault/);
    await expect(h.resolveSecret('not-a-ref')).rejects.toThrow(/malformed/);
  });

  it('attributes unexpected plugin exceptions and counts them, but not expected backend errors', async () => {
    const telemetry = createRecordingTelemetry();
    const throwing = definePlugin({
      id: 'throwing',
      displayName: 'Throwing',
      sources: [
        {
          ...testSourceType,
          id: 'throwing-source',
          eventTypes: testSourceType.eventTypes.map((e) => ({
            ...e,
            type: 'throwing-source.item.created',
          })),
          create: () => ({
            parse: () => {
              throw new Error('parse exploded');
            },
            resolve: () => Promise.reject(new TransportError('down', { sent: false })),
            health: () =>
              Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
          }),
        },
      ],
    });
    const h = host({
      telemetry,
      builtin: [{ name: 'throwing', version: '1.0.0', definition: throwing }],
    });
    await h.boot();
    const [src] = await tdb.db
      .insert(sources)
      .values({ typeId: 'throwing-source', name: 'Throws', settings: {} })
      .returning();
    await h.reload('source', src!.id);
    const live = h.source(src!.id)!;
    expect(() =>
      live.source.parse?.({
        method: 'POST',
        path: '/',
        headers: {},
        query: {},
        body: Buffer.alloc(0),
        receivedAt: '',
      }),
    ).toThrow('parse exploded');
    await expect(live.source.resolve?.({ kind: 'k', id: '1' })).rejects.toThrow('down');
    await h.stop();
    const [p] = await tdb.db.select().from(plugins).where(eq(plugins.name, 'throwing'));
    expect(p?.errorCount).toBe(1);
    expect(telemetry.signals.filter((s) => s.name === 'switchboard.plugin.errors')).toHaveLength(1);
  });
  it("checks a source action against its argsSchema before the plugin's act", async () => {
    const acted: { action: string; args: unknown }[] = [];
    const acting = definePlugin({
      id: 'acting',
      displayName: 'Acting',
      sources: [
        {
          ...testSourceType,
          id: 'acting-source',
          eventTypes: testSourceType.eventTypes.map((e) => ({
            ...e,
            type: 'acting-source.item.created',
          })),
          actions: [
            {
              id: 'addLabel',
              title: 'Add label',
              argsSchema: {
                type: 'object',
                required: ['label'],
                properties: { label: { type: 'string' } },
              },
            },
          ],
          create: () => ({
            act: (action: string, args: unknown) => {
              acted.push({ action, args });
              return Promise.resolve({ ok: true });
            },
            health: () =>
              Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
          }),
        },
      ],
    });
    const h = host({ builtin: [{ name: 'acting', version: '1.0.0', definition: acting }] });
    await h.boot();
    const [src] = await tdb.db
      .insert(sources)
      .values({ typeId: 'acting-source', name: 'Acts', settings: {} })
      .returning();
    await h.reload('source', src!.id);
    const live = h.source(src!.id)!.source;
    const act = (action: string, args: unknown) => live.act!(action, args);
    await expect(act('addLabel', { label: 'x' })).resolves.toEqual({ ok: true });
    await expect(act('merge', {})).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/unknown action "merge"/),
    });
    await expect(act('addLabel', { label: 7 })).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/invalid args for action "addLabel"/),
    });
    expect(acted).toEqual([{ action: 'addLabel', args: { label: 'x' } }]);
    await h.stop();
  });

  it('counts a create() that throws against the plugin for every kind', async () => {
    const telemetry = createRecordingTelemetry();
    const failing = definePlugin({
      id: 'failing',
      displayName: 'Failing',
      notifiers: [
        {
          id: 'failing-notifier',
          displayName: 'Failing notifier',
          settingsSchema: { type: 'object' },
          create: () => {
            throw new Error('notifier create exploded');
          },
        },
      ],
      secretProviders: [
        {
          id: 'failing-provider',
          displayName: 'Failing provider',
          settingsSchema: { type: 'object' },
          create: () => {
            throw new Error('provider create exploded');
          },
        },
      ],
    });
    const h = host({
      telemetry,
      builtin: [{ name: 'failing', version: '1.0.0', definition: failing }],
    });
    await h.boot();
    const [n] = await tdb.db
      .insert(notifiers)
      .values({ typeId: 'failing-notifier', name: 'Fails', settings: {} })
      .returning();
    const [p] = await tdb.db
      .insert(secretProviders)
      .values({ typeId: 'failing-provider', name: 'fails', settings: {} })
      .returning();
    await h.reload('notifier', n!.id);
    await h.reload('secret_provider', p!.id);
    expect(h.instanceError(n!.id)).toMatch(/^create_failed: notifier create exploded/);
    expect(h.instanceError(p!.id)).toMatch(/^create_failed: provider create exploded/);
    await h.stop();
    const errors = telemetry.signals.filter((s) => s.name === 'switchboard.plugin.errors');
    expect(errors.map((e) => e.attributes)).toEqual([
      { plugin: 'failing', kind: 'exception' },
      { plugin: 'failing', kind: 'exception' },
    ]);
    const [row] = await tdb.db.select().from(plugins).where(eq(plugins.name, 'failing'));
    expect(row?.errorCount).toBe(2);
    await tdb.db.delete(notifiers).where(eq(notifiers.id, n!.id));
    await tdb.db.delete(secretProviders).where(eq(secretProviders.id, p!.id));
  });

  it('keeps rotated credentials in the referenced writable provider, never in instance_state', async () => {
    const vault = new Map<string, string>([['seed', 'fixture-secret-seed-value']]);
    let ctxRef: PluginContext | undefined;
    const rotating = definePlugin({
      id: 'rotating',
      displayName: 'Rotating',
      secretProviders: [
        {
          id: 'vault',
          displayName: 'Vault',
          settingsSchema: { type: 'object' },
          create: () => ({
            resolve: (name: string) => {
              const v = vault.get(name);
              return v === undefined
                ? Promise.reject(new SecretNotFoundError(`${name} is not stored`))
                : Promise.resolve(v);
            },
            list: () => Promise.resolve([...vault.keys()].map((name) => ({ name }))),
            set: (name: string, value: string) => {
              vault.set(name, value);
              return Promise.resolve();
            },
            delete: (name: string) => {
              vault.delete(name);
              return Promise.resolve();
            },
            health: () => Promise.resolve({ status: 'healthy', checkedAt: '' }),
          }),
        },
      ],
      notifiers: [
        {
          id: 'rotating-notifier',
          displayName: 'Rotating notifier',
          settingsSchema: {
            type: 'object',
            properties: { token: { type: 'string', 'x-secret': true } },
          },
          create: (_settings, ctx) => {
            ctxRef = ctx;
            return {
              send: () => Promise.resolve(),
              health: () => Promise.resolve({ status: 'healthy', checkedAt: '' }),
            };
          },
        },
      ],
    });
    const h = host({ builtin: [{ name: 'rotating', version: '1.0.0', definition: rotating }] });
    await h.boot();
    const [p] = await tdb.db
      .insert(secretProviders)
      .values({ typeId: 'vault', name: 'vault', settings: {} })
      .returning();
    await h.reload('secret_provider', p!.id);
    const [n] = await tdb.db
      .insert(notifiers)
      .values({
        typeId: 'rotating-notifier',
        name: 'Rotates',
        settings: { token: 'secret://vault/seed' },
      })
      .returning();
    await h.reload('notifier', n!.id);
    const ctx = ctxRef!;

    expect(await ctx.secrets.check()).toEqual({ writable: true, provider: 'vault' });
    await ctx.secrets.set('refresh', 'fixture-secret-rotated-1');
    expect(vault.get(`switchboard-${n!.id}-refresh`)).toBe('fixture-secret-rotated-1');
    expect(await ctx.secrets.get('refresh')).toBe('fixture-secret-rotated-1');

    await expect(
      ctx.state.set('oauth', { token: 'fixture-secret-rotated-1' }),
    ).rejects.toMatchObject({ name: 'SecretInStateError' });
    await expect(ctx.state.set('seed', 'fixture-secret-seed-value')).rejects.toMatchObject({
      name: 'SecretInStateError',
    });
    await ctx.state.set('oauth', { expiresAt: '2026-01-01T00:00:00Z' });
    const rows = await tdb.db
      .select()
      .from(instanceState)
      .where(eq(instanceState.instanceId, n!.id));
    expect(JSON.stringify(rows)).not.toContain('fixture-secret');

    await tdb.db.delete(notifiers).where(eq(notifiers.id, n!.id));
    await h.reload('notifier', n!.id);
    expect(vault.has(`switchboard-${n!.id}-refresh`)).toBe(false);
    expect(vault.get('seed')).toBe('fixture-secret-seed-value');
    await tdb.db.delete(instanceState).where(eq(instanceState.instanceId, n!.id));
    await tdb.db.delete(secretProviders).where(eq(secretProviders.id, p!.id));
    await h.stop();
  });

  it('keeps the live instance through a reload and lets the newest reload win a race', async () => {
    // A secret provider whose resolve can be held open, to interleave two reloads.
    let held: { promise: Promise<string>; release: () => void } | undefined;
    const gated = definePlugin({
      id: 'gated',
      displayName: 'Gated',
      secretProviders: [
        {
          id: 'gated',
          displayName: 'Gated',
          settingsSchema: { type: 'object' },
          create: () => ({
            resolve: () => held?.promise ?? Promise.resolve('s-gated'),
            health: () =>
              Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
          }),
        },
      ],
    });
    const h = host({
      builtin: [
        { name: 'test-plugin', version: '1.0.0', definition: testPlugin },
        { name: 'gated', version: '1.0.0', definition: gated },
      ],
    });
    await h.boot();
    const [provider] = await tdb.db
      .insert(secretProviders)
      .values({ typeId: 'gated', name: 'gated', settings: {} })
      .returning();
    await h.reload('secret_provider', provider!.id);
    const [src] = await tdb.db
      .insert(sources)
      .values({ typeId: 'test-source', name: 'v1', settings: { secret: 'secret://gated/x' } })
      .returning();
    const id = src!.id;
    await h.reload('source', id);
    expect(h.source(id)?.name).toBe('v1');

    let release = (): void => undefined;
    held = {
      promise: new Promise<string>((resolve) => {
        release = () => resolve('s-gated');
      }),
      release: () => release(),
    };
    await tdb.db.update(sources).set({ name: 'v2' }).where(eq(sources.id, id));
    const slow = h.reload('source', id);
    await new Promise((r) => setTimeout(r, 20));
    // While v2 resolves its secrets, the previous object keeps serving.
    expect(h.source(id)?.name).toBe('v1');

    const stuck = held;
    held = undefined;
    await tdb.db.update(sources).set({ name: 'v3' }).where(eq(sources.id, id));
    await h.reload('source', id);
    expect(h.source(id)?.name).toBe('v3');
    stuck.release();
    await slow;
    // The older reload read an older row: it must not replace the newer object.
    expect(h.source(id)?.name).toBe('v3');

    await tdb.db.delete(sources).where(eq(sources.id, id));
    await tdb.db.delete(secretProviders).where(eq(secretProviders.id, provider!.id));
  });
});
