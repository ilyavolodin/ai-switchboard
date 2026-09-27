import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type {
  ExecutorDetail,
  MeResponse,
  Page,
  ProcessDetail,
  ProcessSummary,
  RunSummary,
  SourceDetail,
  UserDTO,
} from '../../src/api/contract.js';
import { auditLog, batches, dispatches, events, runs, sources } from '../../src/db/schema.js';
import { defaultProcessDocument, type ProcessDocument } from '../../src/domain/process.js';
import { createApiHarness, ADMIN_EMAIL, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;
let h: ApiHarness;

beforeAll(async () => {
  process.env.TEST_SOURCE_SECRET = 's-fixture-secret';
  tdb = await createTestDatabase();
  h = await createApiHarness(tdb);
});

afterAll(async () => {
  await h.close();
  await tdb.destroy();
});

const reason = 'integration test';

async function createSource(name = 'Test — acme'): Promise<SourceDetail> {
  const res = await h.request('POST', '/api/v1/sources', {
    cookie: h.adminCookie,
    body: {
      typeId: 'test-source',
      name,
      settings: { secret: 'secret://env/TEST_SOURCE_SECRET' },
      reason,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<SourceDetail>();
}

async function createExecutor(name = 'Exec — one'): Promise<ExecutorDetail> {
  const res = await h.request('POST', '/api/v1/executors', {
    cookie: h.adminCookie,
    body: { typeId: 'test-executor', name, settings: {}, reason },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<ExecutorDetail>();
}

function processDoc(sourceId: string, executorId: string, name = 'Autofix'): ProcessDocument {
  const doc = defaultProcessDocument(name, executorId);
  doc.triggers = [
    {
      id: 't1',
      sourceId,
      eventTypes: ['test-source.item.created'],
      filter: "attributes.label = 'x'",
      describe: 'Item labeled x',
      enabled: true,
    },
  ];
  doc.executor.target = { path: '/run' };
  doc.schedules = [
    { id: 's1', cron: '0 7 * * *', timezone: 'Europe/London', catchUp: 'once', enabled: true },
  ];
  return doc;
}

describe('auth', () => {
  it('reports the signed-in user and rejects anonymous API calls', async () => {
    const me = await h.request('GET', '/api/v1/auth/me', { cookie: h.adminCookie });
    expect(me.json<MeResponse>().user?.email).toBe(ADMIN_EMAIL);
    expect(me.json<MeResponse>().authMode).toBe('local');
    const anon = await h.request('GET', '/api/v1/sources');
    expect(anon.statusCode).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const res = await h.request('POST', '/api/v1/auth/login', {
      body: { email: ADMIN_EMAIL, password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('enforces roles server-side and names the role', async () => {
    const created = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'viewer@acme.test', role: 'viewer', reason },
    });
    expect(created.statusCode).toBe(201);
    const viewer = created.json<UserDTO>();
    const tokenRes = await h.request('POST', '/api/v1/tokens', {
      cookie: h.adminCookie,
      body: { name: 'ci', role: 'operator', reason },
    });
    expect(tokenRes.statusCode).toBe(201);
    const { secret } = tokenRes.json<{ secret: string }>();
    const withToken = await h.request('GET', '/api/v1/processes', { token: secret });
    expect(withToken.statusCode).toBe(200);
    const adminOnly = await h.request('GET', '/api/v1/users', { token: secret });
    expect(adminOnly.statusCode).toBe(403);
    expect(adminOnly.json<{ message: string }>().message).toMatch(/admin role/);
    expect(viewer.role).toBe('viewer');
  });

  it('refuses a token with more than the caller’s role', async () => {
    const tokenRes = await h.request('POST', '/api/v1/tokens', {
      cookie: h.adminCookie,
      body: { name: 'op', role: 'operator', reason },
    });
    const { secret } = tokenRes.json<{ secret: string }>();
    const res = await h.request('POST', '/api/v1/tokens', {
      token: secret,
      body: { name: 'escalate', role: 'admin', reason },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('sources and executors', () => {
  it('requires a reason for every change', async () => {
    const res = await h.request('POST', '/api/v1/sources', {
      cookie: h.adminCookie,
      body: {
        typeId: 'test-source',
        name: 'x',
        settings: { secret: 'secret://env/TEST_SOURCE_SECRET' },
        reason: '  ',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/reason/);
  });

  it('refuses a literal secret value but accepts a reference despite the field pattern', async () => {
    const literal = await h.request('POST', '/api/v1/sources', {
      cookie: h.adminCookie,
      body: { typeId: 'test-source', name: 'Literal', settings: { secret: 's-plaintext' }, reason },
    });
    expect(literal.statusCode).toBe(400);
    expect(literal.json<{ details: string[] }>().details[0]).toMatch(/secret:\/\//);
    const src = await createSource();
    expect(src.webhookUrl).toBe(`http://switchboard.test/hooks/${src.id}`);
    expect(src.secretRefs).toEqual([
      expect.objectContaining({
        field: 'secret',
        ref: 'secret://env/TEST_SOURCE_SECRET',
        ok: true,
      }),
    ]);
    expect(src.settings).toEqual({ secret: 'secret://env/TEST_SOURCE_SECRET', org: 'acme' });
    expect(JSON.stringify(src)).not.toContain('s-fixture-secret');
  });

  it('refuses a settings change it cannot check while the plugin is unavailable', async () => {
    const [row] = await tdb.db
      .insert(sources)
      .values({ typeId: 'gone-type', name: 'Orphan', settings: { token: 'secret://env/X' } })
      .returning();
    const res = await h.request('PUT', `/api/v1/sources/${row!.id}`, {
      cookie: h.adminCookie,
      body: { settings: { token: 'plain-text-token' }, reason },
    });
    expect(res.statusCode).toBe(422);
    const [after] = await tdb.db.select().from(sources).where(eq(sources.id, row!.id));
    expect(after?.settings).toEqual({ token: 'secret://env/X' });
    // A rename without settings still works.
    const renamed = await h.request('PUT', `/api/v1/sources/${row!.id}`, {
      cookie: h.adminCookie,
      body: { name: 'Orphan 2', reason },
    });
    expect(renamed.statusCode).toBe(200);
    await tdb.db.delete(sources).where(eq(sources.id, row!.id));
  });

  it('shows a secret error when the reference does not resolve', async () => {
    const res = await h.request('POST', '/api/v1/sources', {
      cookie: h.adminCookie,
      body: {
        typeId: 'test-source',
        name: 'Broken',
        settings: { secret: 'secret://env/NOT_SET_ANYWHERE' },
        reason,
      },
    });
    expect(res.statusCode).toBe(201);
    const src = res.json<SourceDetail>();
    expect(src.status).toEqual({ tone: 'error', label: 'secret error' });
    expect(src.instanceError).toMatch(/NOT_SET_ANYWHERE/);
  });

  it('writes field-level audit rows for a settings change', async () => {
    const src = await createSource('Audited');
    const res = await h.request('PUT', `/api/v1/sources/${src.id}`, {
      cookie: h.adminCookie,
      body: { caps: { eventCapPerHour: 100 }, reason: 'cap the flood' },
    });
    expect(res.statusCode).toBe(200);
    const rows = await tdb.db.select().from(auditLog);
    const row = rows.find((r) => r.targetId === src.id && r.field === 'caps.eventCapPerHour');
    expect(row).toMatchObject({ after: 100, reason: 'cap the flood', actor: ADMIN_EMAIL });
  });

  it('refuses to delete an instance a process still uses', async () => {
    const src = await createSource('In use');
    const ex = await createExecutor('In use exec');
    const proc = await h.request('POST', '/api/v1/processes', {
      cookie: h.adminCookie,
      body: { document: processDoc(src.id, ex.id, 'Uses them'), reason },
    });
    expect(proc.statusCode, proc.body).toBe(201);
    const del = await h.request('DELETE', `/api/v1/sources/${src.id}`, {
      cookie: h.adminCookie,
      body: { reason },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json<{ message: string }>().message).toMatch(/Uses them/);
  });

  it('delegates pipeline actions with the actor and reason', async () => {
    const ex = await createExecutor('Meters');
    const res = await h.request('POST', `/api/v1/executors/${ex.id}/meters/read`, {
      cookie: h.adminCookie,
      body: { reason },
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls.some((c) => c.method === 'readMetersNow' && c.args[0] === ex.id)).toBe(true);
    const gauges = res.json<{ meterId: string; stale: boolean }[]>();
    expect(gauges).toEqual([expect.objectContaining({ meterId: 'window', stale: true })]);
  });
});

describe('processes', () => {
  it('validates references and expressions semantically', async () => {
    const src = await createSource('Semantic');
    const ex = await createExecutor('Semantic exec');
    const doc = processDoc(src.id, ex.id, 'Broken');
    doc.triggers[0]!.eventTypes = ['test-source.item.deleted'];
    doc.triggers[0]!.filter = 'attributes.label = ';
    doc.executor.target = {};
    doc.budgets.meterCeilings = { nope: { events: 80, sweeps: 95 } };
    const res = await h.request('POST', '/api/v1/processes', {
      cookie: h.adminCookie,
      body: { document: doc, reason },
    });
    expect(res.statusCode).toBe(422);
    const details = res.json<{ details: string[] }>().details.join('\n');
    expect(details).toMatch(/does not declare event type test-source\.item\.deleted/);
    expect(details).toMatch(/filter/);
    expect(details).toMatch(/executor\.target/);
    expect(details).toMatch(/no meter "nope"/);
  });

  it('versions every save, guards concurrent edits, and restores', async () => {
    const src = await createSource('Versioned');
    const ex = await createExecutor('Versioned exec');
    const created = await h.request('POST', '/api/v1/processes', {
      cookie: h.adminCookie,
      body: { document: processDoc(src.id, ex.id, 'Versioned'), reason },
    });
    const p = created.json<ProcessDetail>();
    expect(p.version).toBe(1);
    expect(p.nextSweepAt).not.toBeNull();

    const doc = { ...p.document, gates: { ...p.document.gates, approval: 'always' } };
    const updated = await h.request('PUT', `/api/v1/processes/${p.id}`, {
      cookie: h.adminCookie,
      body: { document: doc, expectedVersion: 1, reason: 'a human looks first' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<ProcessDetail>().version).toBe(2);

    const stale = await h.request('PUT', `/api/v1/processes/${p.id}`, {
      cookie: h.adminCookie,
      body: { document: doc, expectedVersion: 1, reason },
    });
    expect(stale.statusCode).toBe(409);

    const audit = await tdb.db.select().from(auditLog);
    expect(audit.find((r) => r.targetId === p.id && r.field === 'gates.approval')).toMatchObject({
      before: 'none',
      after: 'always',
      reason: 'a human looks first',
    });

    const restored = await h.request('POST', `/api/v1/processes/${p.id}/versions/1/restore`, {
      cookie: h.adminCookie,
      body: { reason },
    });
    expect(restored.json<ProcessDetail>()).toMatchObject({
      version: 3,
      document: { gates: { approval: 'none' } },
    });
    const versions = await h.request('GET', `/api/v1/processes/${p.id}/versions`, {
      cookie: h.adminCookie,
    });
    expect(versions.json<{ version: number }[]>().map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('lists summaries with dots, sparkline and daily cap', async () => {
    const res = await h.request('GET', '/api/v1/processes', { cookie: h.adminCookie });
    const list = res.json<ProcessSummary[]>();
    expect(list.length).toBeGreaterThan(0);
    const first = list[0]!;
    expect(first.sparkline).toHaveLength(7);
    expect(first.dots.tones).toHaveLength(5);
    expect(first.status.label).toBe('disabled');
  });
});

describe('board and status', () => {
  it('draws trigger and binding edges and needs-attention rows', async () => {
    const res = await h.request('GET', '/api/v1/board', { cookie: h.adminCookie });
    expect(res.statusCode).toBe(200);
    const board = res.json<{ edges: { kind: string }[]; attention: { kind: string }[] }>();
    expect(board.edges.some((e) => e.kind === 'trigger')).toBe(true);
    expect(board.edges.some((e) => e.kind === 'binding')).toBe(true);
    expect(board.attention.some((a) => a.kind === 'meter_stale')).toBe(true);
    const status = await h.request('GET', '/api/v1/status', { cookie: h.adminCookie });
    expect(status.json<{ meters: unknown[] }>().meters.length).toBeGreaterThan(0);
  });
});

describe('configuration export and apply', () => {
  it('round-trips through YAML onto an empty database', async () => {
    const exported = await h.request('GET', '/api/v1/export', { cookie: h.adminCookie });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toMatch(/yaml/);
    const yaml = exported.body;
    expect(yaml).toContain('secret://env/TEST_SOURCE_SECRET');
    expect(yaml).not.toContain('s-fixture-secret');
    const parsed = parse(yaml) as { processes: { triggers: { source: string }[] }[] };
    expect(parsed.processes[0]?.triggers[0]?.source).toBeTypeOf('string');

    const fresh = await createTestDatabase();
    const other = await createApiHarness(fresh);
    try {
      const dry = await other.request('POST', '/api/v1/apply', {
        cookie: other.adminCookie,
        body: { yaml, dryRun: true, reason },
      });
      expect(dry.statusCode, dry.body).toBe(200);
      const dryBody = dry.json<{ errors: string[]; changes: { action: string }[] }>();
      expect(dryBody.errors).toEqual([]);
      expect(dryBody.changes.some((c) => c.action === 'create')).toBe(true);
      const before = await other.request('GET', '/api/v1/processes', { cookie: other.adminCookie });
      expect(before.json<unknown[]>()).toHaveLength(0);

      const applied = await other.request('POST', '/api/v1/apply', {
        cookie: other.adminCookie,
        body: { yaml, reason },
      });
      expect(applied.json<{ errors: string[] }>().errors).toEqual([]);
      const reexported = await other.request('GET', '/api/v1/export', {
        cookie: other.adminCookie,
      });
      expect(parse(reexported.body)).toEqual(parse(yaml));

      const again = await other.request('POST', '/api/v1/apply', {
        cookie: other.adminCookie,
        body: { yaml, reason },
      });
      expect(
        again
          .json<{ changes: { action: string }[] }>()
          .changes.every((c) => c.action === 'unchanged'),
      ).toBe(true);
    } finally {
      await other.close();
      await fresh.destroy();
    }
  });
});

describe('ingress surfaces', () => {
  it('hands raw bytes to the pipeline and answers without a body on rejection', async () => {
    const src = await createSource('Ingress');
    const res = await h.app.inject({
      method: 'POST',
      url: `/hooks/${src.id}`,
      payload: '{"a":1}',
      headers: { 'content-type': 'application/json', 'x-secret': 's-fixture-secret' },
    });
    expect(res.statusCode).toBe(200);
    const call = h.calls.find((c) => c.method === 'ingestPush');
    const raw = call?.args[1] as { body: Buffer; headers: Record<string, string> };
    expect(raw.body.toString()).toBe('{"a":1}');
    expect(raw.headers['x-secret']).toBe('s-fixture-secret');
    expect((await h.app.inject({ method: 'POST', url: '/hooks/not-a-uuid' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });
});

describe('read models over pipeline rows', () => {
  it('interpret merged sweeps and count only budget-counted runs', async () => {
    const src = await createSource('Rows source');
    const ex = await createExecutor('Rows exec');
    const created = await h.request('POST', '/api/v1/processes', {
      cookie: h.adminCookie,
      body: {
        document: {
          ...processDoc(src.id, ex.id, 'Rows'),
          budgets: { runsPerDay: 5, meterCeilings: {} },
        },
        reason,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pid = created.json<ProcessDetail>().id;
    const now = h.clock.now();
    const run = (batchId: string, extra: Partial<typeof runs.$inferInsert>) => ({
      batchId,
      processId: pid,
      processVersion: 1,
      executorId: ex.id,
      kind: 'event' as const,
      status: 'ok' as const,
      attempts: 1,
      invokedAt: now,
      createdAt: now,
      ...extra,
    });
    const ids = Array.from({ length: 5 }, () => randomUUID());
    await tdb.db.insert(batches).values(
      ids.map((id) => ({
        id,
        processId: pid,
        kind: 'event' as const,
        openedAt: now,
        fireAfter: now,
        outcome: 'invoked' as const,
      })),
    );
    await tdb.db.insert(runs).values([
      run(ids[0]!, {}),
      run(ids[1]!, { status: 'held', statusReason: 'paused:paused' }),
      run(ids[2]!, {
        status: 'failed',
        statusReason: 'input_invalid',
        attempts: 0,
        invokedAt: null,
      }),
      run(ids[3]!, { dryRun: true }),
    ]);

    // A sweep that merged an open event batch: the event's dispatch points at the event batch.
    const sweepId = randomUUID();
    const eventBatch = ids[4]!;
    await tdb.db
      .update(batches)
      .set({ outcome: 'merged', mergedInto: sweepId })
      .where(eq(batches.id, eventBatch));
    await tdb.db.insert(batches).values({
      id: sweepId,
      processId: pid,
      kind: 'sweep',
      openedAt: now,
      fireAfter: now,
      outcome: 'invoked',
    });
    await tdb.db.insert(runs).values(run(sweepId, { kind: 'sweep', status: 'running' }));
    const eventId = randomUUID();
    await tdb.db.insert(events).values({
      id: eventId,
      sourceId: src.id,
      sourceType: 'test-source',
      type: 'test-source.item.created',
      occurredAt: now,
      receivedAt: now,
      artifact: { kind: 'test.item', id: 'MERGED-1' },
      artifactKey: 'test.item:MERGED-1',
      attributes: { label: 'x' },
      dedupeKey: 'k-merged',
      rawRef: 'r-merged',
      stage: 'matched',
    });
    await tdb.db.insert(dispatches).values({
      eventId,
      processId: pid,
      triggerId: 't1',
      dedupeKey: 'k-merged',
      outcome: 'batched',
      batchId: eventBatch,
      createdAt: now,
    });

    const list = await h.request('GET', '/api/v1/processes', { cookie: h.adminCookie });
    const summary = list.json<ProcessSummary[]>().find((p) => p.id === pid);
    // The budget counts the ok run and the running sweep; not the held, never-invoked or dry runs.
    expect(summary?.dailyCap).toEqual({ used: 2, limit: 5 });

    const sweepRuns = await h.request('GET', `/api/v1/runs?process=${pid}&status=running`, {
      cookie: h.adminCookie,
    });
    const [sweepRun] = sweepRuns.json<Page<RunSummary>>().items;
    expect(sweepRun).toMatchObject({ kind: 'sweep', eventCount: 1 });
    expect(sweepRun?.artifacts).toEqual([{ kind: 'test.item', id: 'MERGED-1' }]);

    const byExecutor = await h.request('GET', `/api/v1/events?executor=${ex.id}`, {
      cookie: h.adminCookie,
    });
    expect(byExecutor.json<Page<{ eventId: string }>>().items.map((i) => i.eventId)).toContain(
      eventId,
    );
  });
});
