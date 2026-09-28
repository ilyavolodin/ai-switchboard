import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InstanceSummary, SourceDetail } from '../../src/api/contract.js';
import { defaultProcessDocument } from '../../src/domain/process.js';
import { createApiHarness, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * A secret provider's lifecycle rebuilds the instances whose settings reference it, and a
 * provider still referenced anywhere cannot be deleted.
 */

let tdb: TestDatabase;
let h: ApiHarness;
const reason = 'secret provider lifecycle test';

beforeAll(async () => {
  tdb = await createTestDatabase();
  h = await createApiHarness(tdb);
});

afterAll(async () => {
  await h.close();
  await tdb.destroy();
});

async function call<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: Record<string, unknown>,
  status: number,
): Promise<T> {
  const res = await h.request(method, url, { cookie: h.adminCookie, body: { ...body, reason } });
  expect(res.statusCode, res.body).toBe(status);
  return (res.body === '' ? undefined : res.json<T>()) as T;
}

describe('secret provider lifecycle', () => {
  let source: SourceDetail;
  let executorId: string;
  let provider: InstanceSummary;

  beforeAll(async () => {
    // Created before the provider exists: the reference cannot resolve yet.
    source = await call<SourceDetail>(
      'POST',
      '/api/v1/sources',
      {
        typeId: 'test-source',
        name: 'Vault source',
        settings: { secret: 'secret://late/SOURCE_SECRET' },
      },
      201,
    );
    executorId = (
      await call<{ id: string }>(
        'POST',
        '/api/v1/executors',
        { typeId: 'test-executor', name: 'Unrelated executor', settings: {} },
        201,
      )
    ).id;
  });

  it('a source waiting on a missing provider starts once the provider is created', async () => {
    expect(h.ctx.runtime.instanceError(source.id)).toMatch(/^secret_error: .*"late"/);
    expect(h.ctx.runtime.source(source.id)).toBeUndefined();

    provider = await call<InstanceSummary>(
      'POST',
      '/api/v1/secret-providers',
      { typeId: 'test-vault', name: 'late', settings: {} },
      201,
    );
    expect(h.ctx.runtime.source(source.id)).toBeDefined();
    expect(provider.dependents).toEqual([
      {
        kind: 'source',
        id: source.id,
        name: 'Vault source',
        status: expect.objectContaining({ tone: 'ok' }) as unknown,
        instanceError: null,
      },
    ]);
  });

  it('disabling the provider fails its dependents; enabling it brings them back', async () => {
    const off = await call<InstanceSummary>(
      'POST',
      `/api/v1/secret-providers/${provider.id}/enable`,
      { enabled: false },
      200,
    );
    expect(off.dependents?.[0]?.instanceError).toMatch(/^secret_error: /);
    expect(h.ctx.runtime.source(source.id)).toBeUndefined();

    const on = await call<InstanceSummary>(
      'POST',
      `/api/v1/secret-providers/${provider.id}/enable`,
      { enabled: true },
      200,
    );
    expect(on.dependents?.[0]).toMatchObject({ id: source.id, instanceError: null });
    expect(h.ctx.runtime.source(source.id)).toBeDefined();
  });

  it('lists each provider with its dependents', async () => {
    const res = await h.request('GET', '/api/v1/secret-providers', { cookie: h.adminCookie });
    const list = res.json<InstanceSummary[]>();
    expect(list.find((p) => p.id === provider.id)?.dependents?.map((d) => d.id)).toEqual([
      source.id,
    ]);
    expect(list.find((p) => p.name === 'env')?.dependents).toEqual([]);
  });

  it('after a rename, instances naming the old provider fail with a clear secret_error', async () => {
    const renamed = await call<InstanceSummary>(
      'PUT',
      `/api/v1/secret-providers/${provider.id}`,
      { name: 'renamed' },
      200,
    );
    expect(renamed.dependents).toEqual([]);
    expect(h.ctx.runtime.instanceError(source.id)).toMatch(
      /^secret_error: secret provider "late" is not configured/,
    );
    // Renaming back restores it.
    const back = await call<InstanceSummary>(
      'PUT',
      `/api/v1/secret-providers/${provider.id}`,
      { name: 'late' },
      200,
    );
    expect(back.dependents?.[0]).toMatchObject({ id: source.id, instanceError: null });
  });

  it('refuses to delete a provider still referenced, naming who uses it', async () => {
    const doc = defaultProcessDocument('Uses late', executorId);
    doc.executor.target = { path: '/x' };
    doc.input = "{ 'token': $secretRef('late/SOURCE_SECRET') }";
    const processId = (
      await call<{ id: string }>('POST', '/api/v1/processes', { document: doc }, 201)
    ).id;

    const refused = await h.request('DELETE', `/api/v1/secret-providers/${provider.id}`, {
      cookie: h.adminCookie,
      body: { reason },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    const message = refused.json<{ message: string }>().message;
    expect(message).toContain('process "Uses late"');
    expect(message).toContain('source "Vault source"');
    expect(message).toContain('secret://late/');

    // Point both elsewhere, then the delete goes through.
    await call(
      'PUT',
      `/api/v1/sources/${source.id}`,
      { settings: { secret: 'secret://env/X' } },
      200,
    );
    await call('DELETE', `/api/v1/processes/${processId}`, {}, 204);
    await call('DELETE', `/api/v1/secret-providers/${provider.id}`, {}, 204);
  });
});
