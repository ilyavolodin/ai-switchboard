import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { InstanceSummary, SourceDetail } from '../../src/api/contract.js';
import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import { executors, secretProviders, sources } from '../../src/db/schema.js';
import { silentLogger } from '../../src/logger.js';
import { PluginHost, type ReconcileResult } from '../../src/plugins/host.js';
import { createRecordingTelemetry } from '../../src/telemetry/telemetry.js';
import { createApiHarness, testPlugin, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * Two replicas on one database: replica A serves the API (and rebuilds what it changes at once),
 * replica B is a second plugin host that converges on A's changes through `reconcile()`.
 */

let tdb: TestDatabase;
let a: ApiHarness;
let b: PluginHost;
const reason = 'replica convergence test';

function replica(): PluginHost {
  return new PluginHost({
    db: tdb.db,
    clock: new FakeClock('2026-03-02T10:00:00Z'),
    logger: silentLogger(),
    telemetry: createRecordingTelemetry(),
    config: testConfig({ databaseUrl: tdb.url, home: `/tmp/sb-test-replica-${Date.now()}` }),
    builtin: [{ name: 'test-plugin', version: '1.0.0', definition: testPlugin }],
    scanDirs: [],
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  a = await createApiHarness(tdb);
  b = replica();
  await b.boot();
});

afterAll(async () => {
  await b.stop();
  await a.close();
  await tdb.destroy();
});

async function call<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: Record<string, unknown>,
  status = 200,
): Promise<T> {
  const res = await a.request(method, url, { cookie: a.adminCookie, body: { ...body, reason } });
  expect(res.statusCode, res.body).toBe(status);
  return (res.body === '' ? undefined : res.json<T>()) as T;
}

const ids = (list: { id: string }[]) => list.map((i) => i.id);

/** Replica A handled the change and rebuilt already: its own pass must find nothing to do. */
async function expectNothingOnA(): Promise<void> {
  const own: ReconcileResult = await a.ctx.host.reconcile();
  expect(own).toEqual({ built: [], rebuilt: [], dropped: [], dependents: [] });
}

async function versionOf(table: typeof sources | typeof executors, id: string): Promise<number> {
  const [row] = await tdb.db.select({ v: table.configVersion }).from(table).where(eq(table.id, id));
  return row?.v ?? -1;
}

describe('instance convergence across replicas', () => {
  let provider: InstanceSummary;
  let source: SourceDetail;
  let executorId: string;

  it('builds instances created on another replica', async () => {
    provider = await call<InstanceSummary>(
      'POST',
      '/api/v1/secret-providers',
      { typeId: 'test-vault', name: 'vault', settings: {} },
      201,
    );
    source = await call<SourceDetail>(
      'POST',
      '/api/v1/sources',
      {
        typeId: 'test-source',
        name: 'Replica source',
        settings: { secret: 'secret://vault/SOURCE_SECRET' },
      },
      201,
    );
    executorId = (
      await call<{ id: string }>(
        'POST',
        '/api/v1/executors',
        { typeId: 'test-executor', name: 'Replica executor', settings: {} },
        201,
      )
    ).id;
    expect(b.source(source.id)).toBeUndefined();
    expect(b.secretProvider(provider.id)).toBeUndefined();

    const result = await b.reconcile();
    // The source references the new provider, so it is built as one of its dependents.
    expect(ids(result.built).sort()).toEqual([provider.id, executorId].sort());
    expect(ids(result.dependents)).toEqual([source.id]);
    expect(b.secretProvider(provider.id)?.name).toBe('vault');
    expect(b.source(source.id)?.name).toBe('Replica source');
    expect(b.instanceError(source.id)).toBeUndefined();
    expect(b.executor(executorId)).toBeDefined();
    await expectNothingOnA();
    // A second pass with nothing changed rebuilds nothing.
    expect(await b.reconcile()).toEqual({ built: [], rebuilt: [], dropped: [], dependents: [] });
  });

  it('rebuilds an instance updated on another replica', async () => {
    const before = await versionOf(sources, source.id);
    const old = b.source(source.id);
    await call('PUT', `/api/v1/sources/${source.id}`, { name: 'Renamed source' });
    expect(await versionOf(sources, source.id)).toBe(before + 1);
    await expectNothingOnA();

    const result = await b.reconcile();
    expect(ids(result.rebuilt)).toEqual([source.id]);
    expect(b.source(source.id)).not.toBe(old);
    expect(b.source(source.id)?.name).toBe('Renamed source');
  });

  it('a caps-only change needs no rebuild beyond the version bump of the write', async () => {
    await call('PUT', `/api/v1/executors/${executorId}`, { caps: { invokeTimeoutSeconds: 30 } });
    await expectNothingOnA();
    expect(ids((await b.reconcile()).rebuilt)).toEqual([executorId]);
  });

  it('follows disable and enable', async () => {
    await call('POST', `/api/v1/executors/${executorId}/enable`, { enabled: false });
    await expectNothingOnA();
    await b.reconcile();
    expect(b.instanceError(executorId)).toBe('disabled');

    await call('POST', `/api/v1/executors/${executorId}/enable`, { enabled: true });
    await expectNothingOnA();
    await b.reconcile();
    expect(b.instanceError(executorId)).toBeUndefined();
  });

  it('propagates an explicit reload (credential rotation)', async () => {
    const before = await versionOf(executors, executorId);
    const old = b.executor(executorId);
    await call('POST', `/api/v1/executors/${executorId}/reload`, {});
    expect(await versionOf(executors, executorId)).toBe(before + 1);
    await expectNothingOnA();
    expect(ids((await b.reconcile()).rebuilt)).toEqual([executorId]);
    expect(b.executor(executorId)).not.toBe(old);
  });

  it('picks up changes made by apply', async () => {
    const old = b.executor(executorId);
    const yaml = [
      'apiVersion: switchboard/v1',
      'kind: Configuration',
      'executors:',
      '  - name: Replica executor',
      '    type: test-executor',
      '    settings: { url: "https://applied.test" }',
    ].join('\n');
    const res = await a.request('POST', '/api/v1/apply', {
      cookie: a.adminCookie,
      body: { yaml, reason },
    });
    expect(res.json<{ errors: string[] }>().errors).toEqual([]);
    await expectNothingOnA();
    expect(ids((await b.reconcile()).rebuilt)).toEqual([executorId]);
    expect(b.executor(executorId)).not.toBe(old);
  });

  it('rebuilds the dependents of a secret provider changed on another replica', async () => {
    // Renaming the provider leaves the source's secret://vault/… reference dangling.
    await call('PUT', `/api/v1/secret-providers/${provider.id}`, { name: 'vault-2' });
    await expectNothingOnA();
    expect(a.ctx.runtime.instanceError(source.id)).toMatch(/^secret_error: .*"vault"/);

    const result = await b.reconcile();
    expect(ids(result.rebuilt)).toEqual([provider.id]);
    expect(ids(result.dependents)).toEqual([source.id]);
    expect(b.instanceError(source.id)).toMatch(/^secret_error: .*"vault"/);
    expect(b.source(source.id)).toBeUndefined();

    // Renaming it back resolves the reference again on both replicas.
    await call('PUT', `/api/v1/secret-providers/${provider.id}`, { name: 'vault' });
    await expectNothingOnA();
    expect(ids((await b.reconcile()).dependents)).toEqual([source.id]);
    expect(b.source(source.id)).toBeDefined();
    expect(b.instanceError(source.id)).toBeUndefined();
  });

  it('a provider created elsewhere resolves the references waiting for it', async () => {
    const waiting = await call<SourceDetail>(
      'POST',
      '/api/v1/sources',
      {
        typeId: 'test-source',
        name: 'Waiting source',
        settings: { secret: 'secret://late/SOURCE_SECRET' },
      },
      201,
    );
    await b.reconcile();
    expect(b.instanceError(waiting.id)).toMatch(/^secret_error/);

    const late = await call<InstanceSummary>(
      'POST',
      '/api/v1/secret-providers',
      { typeId: 'test-vault', name: 'late', settings: {} },
      201,
    );
    await expectNothingOnA();
    const result = await b.reconcile();
    expect(ids(result.built)).toEqual([late.id]);
    expect(ids(result.dependents)).toEqual([waiting.id]);
    expect(b.source(waiting.id)).toBeDefined();

    await call('DELETE', `/api/v1/sources/${waiting.id}`, {}, 204);
    await b.reconcile();
  });

  it('drops instances deleted on another replica', async () => {
    await call('DELETE', `/api/v1/executors/${executorId}`, {}, 204);
    await expectNothingOnA();
    const result = await b.reconcile();
    expect(ids(result.dropped)).toEqual([executorId]);
    expect(b.executor(executorId)).toBeUndefined();
    expect(b.instanceError(executorId)).toBeUndefined();
  });

  it('a provider deleted elsewhere rebuilds what still named it', async () => {
    const [late] = await tdb.db
      .select({ id: secretProviders.id })
      .from(secretProviders)
      .where(eq(secretProviders.name, 'late'));
    if (!late) throw new Error('fixture provider missing');
    await call('DELETE', `/api/v1/secret-providers/${late.id}`, {}, 204);
    const result = await b.reconcile();
    expect(ids(result.dropped)).toEqual([late.id]);
    expect(b.secretProvider(late.id)).toBeUndefined();
  });

  it('runs on an interval once started', async () => {
    const c = replica();
    await c.boot();
    try {
      c.startReconcile(0.05);
      const created = await call<{ id: string }>(
        'POST',
        '/api/v1/executors',
        { typeId: 'test-executor', name: 'Timed executor', settings: {} },
        201,
      );
      await vi.waitFor(() => expect(c.executor(created.id)).toBeDefined(), {
        timeout: 5000,
        interval: 20,
      });
    } finally {
      await c.stop();
    }
  });
});

describe('a reconcile pass and a local reload', () => {
  it('leave an instance with a reload in flight alone, so it is built once', async () => {
    const created = await call<SourceDetail>(
      'POST',
      '/api/v1/sources',
      {
        typeId: 'test-source',
        name: 'Racing source',
        settings: { secret: 'secret://vault/SOURCE_SECRET' },
      },
      201,
    );
    await b.reconcile();
    await tdb.db
      .update(sources)
      .set({ configVersion: (await versionOf(sources, created.id)) + 1 })
      .where(eq(sources.id, created.id));

    // Hold replica B's reload inside secret resolution while a pass runs.
    const [vault] = await tdb.db
      .select({ id: secretProviders.id })
      .from(secretProviders)
      .where(eq(secretProviders.name, 'vault'));
    const live = vault ? b.secretProvider(vault.id) : undefined;
    if (!live) throw new Error('vault provider is not running on replica B');
    const resolve = live.provider.resolve.bind(live.provider);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const spy = vi.spyOn(live.provider, 'resolve').mockImplementation(async (name) => {
      calls++;
      if (calls === 1) await gate;
      return resolve(name);
    });
    try {
      const reload = b.reload('source', created.id);
      await vi.waitFor(() => expect(calls).toBe(1));
      const result = await b.reconcile();
      expect(ids(result.rebuilt)).toEqual([]);
      release();
      await reload;
    } finally {
      release();
      spy.mockRestore();
    }
    expect(calls).toBe(1);
    expect(b.source(created.id)).toBeDefined();
    expect(await b.reconcile()).toEqual({ built: [], rebuilt: [], dropped: [], dependents: [] });
  });
});
