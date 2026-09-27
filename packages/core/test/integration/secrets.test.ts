import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  InstanceSummary,
  ProviderSecretsResponse,
  SourceDetail,
} from '../../src/api/contract.js';
import { defaultProcessDocument } from '../../src/domain/process.js';
import { createApiHarness, TEST_VAULT, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;
let h: ApiHarness;
const reason = 'secrets listing test';

beforeAll(async () => {
  process.env.TEST_SOURCE_SECRET = 's-fixture-env-secret';
  tdb = await createTestDatabase();
  h = await createApiHarness(tdb);
});

afterAll(async () => {
  await h.close();
  await tdb.destroy();
});

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await h.request('POST', url, { cookie: h.adminCookie, body: { ...body, reason } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<T>();
}

async function tokenFor(role: 'viewer' | 'operator'): Promise<string> {
  return (await post<{ secret: string }>('/api/v1/tokens', { name: `t-${role}`, role })).secret;
}

describe('GET /secret-providers/:id/secrets', () => {
  let vault: InstanceSummary;
  let source: SourceDetail;
  let executorId: string;
  let processId: string;

  beforeAll(async () => {
    vault = await post<InstanceSummary>('/api/v1/secret-providers', {
      typeId: 'test-vault',
      name: 'vault',
      settings: {},
    });
    source = await post<SourceDetail>('/api/v1/sources', {
      typeId: 'test-source',
      name: 'Vault source',
      settings: { secret: 'secret://vault/SOURCE_SECRET' },
    });
    executorId = (
      await post<{ id: string }>('/api/v1/executors', {
        typeId: 'test-executor',
        name: 'Vault executor',
        settings: { url: 'secret://vault/GONE_TOKEN' },
      })
    ).id;
    const doc = defaultProcessDocument('Vault process', executorId);
    doc.executor.target = { path: '/x', token: 'secret://vault/SOURCE_SECRET' };
    processId = (await post<{ id: string }>('/api/v1/processes', { document: doc })).id;
  });

  it('lists names with refs, who uses each, and the missing references', async () => {
    const res = await h.request('GET', `/api/v1/secret-providers/${vault.id}/secrets`, {
      cookie: h.adminCookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ProviderSecretsResponse>();
    expect(body).toMatchObject({ providerId: vault.id, provider: 'vault', available: true });
    expect(body.secrets.map((s) => s.name)).toEqual(['SOURCE_SECRET', 'UNUSED_TOKEN']);

    const used = body.secrets.find((s) => s.name === 'SOURCE_SECRET');
    expect(used).toMatchObject({
      ref: 'secret://vault/SOURCE_SECRET',
      description: 'vault entry SOURCE_SECRET',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(used?.usedBy).toEqual(
      expect.arrayContaining([
        { kind: 'source', id: source.id, name: 'Vault source', field: 'secret' },
        { kind: 'process', id: processId, name: 'Vault process', field: 'executor.target.token' },
      ]),
    );
    expect(body.secrets.find((s) => s.name === 'UNUSED_TOKEN')?.usedBy).toEqual([]);

    expect(body.missing).toEqual([
      {
        name: 'GONE_TOKEN',
        ref: 'secret://vault/GONE_TOKEN',
        usedBy: [{ kind: 'executor', id: executorId, name: 'Vault executor', field: 'url' }],
      },
    ]);
  });

  it('never returns a secret value, even when the provider puts one in its listing', async () => {
    const res = await h.request('GET', `/api/v1/secret-providers/${vault.id}/secrets`, {
      cookie: h.adminCookie,
    });
    for (const value of Object.values(TEST_VAULT)) expect(res.body).not.toContain(value);
    expect(res.body).not.toContain('"value"');
  });

  it('is admin only', async () => {
    for (const role of ['viewer', 'operator'] as const) {
      const res = await h.request('GET', `/api/v1/secret-providers/${vault.id}/secrets`, {
        token: await tokenFor(role),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ message: string }>().message).toMatch(/admin role/);
    }
    const anonymous = await h.request('GET', `/api/v1/secret-providers/${vault.id}/secrets`);
    expect(anonymous.statusCode).toBe(401);
  });

  it('reports a provider that cannot list as unavailable', async () => {
    const list = await h.request('GET', '/api/v1/secret-providers', { cookie: h.adminCookie });
    const env = list.json<InstanceSummary[]>().find((p) => p.typeId === 'env');
    expect(env).toBeDefined();
    const res = await h.request('GET', `/api/v1/secret-providers/${env?.id ?? ''}/secrets`, {
      cookie: h.adminCookie,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProviderSecretsResponse>();
    expect(body).toMatchObject({ available: false, secrets: [], missing: [] });
    expect(body.error).toMatch(/cannot list/);
    expect(res.body).not.toContain('s-fixture-env-secret');
  });

  it('reports a disabled provider as unavailable', async () => {
    const off = await post<InstanceSummary>('/api/v1/secret-providers', {
      typeId: 'test-vault',
      name: 'vault-off',
      settings: {},
      enabled: false,
    });
    const res = await h.request('GET', `/api/v1/secret-providers/${off.id}/secrets`, {
      cookie: h.adminCookie,
    });
    expect(res.json<ProviderSecretsResponse>()).toMatchObject({
      available: false,
      error: 'The provider is disabled.',
    });
  });

  it('404s for an unknown or malformed id', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await h.request('GET', `/api/v1/secret-providers/${id}/secrets`, {
        cookie: h.adminCookie,
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
