import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type {
  ActivityRow,
  ApiError,
  EventDetail,
  ExecutorDetail,
  MeResponse,
  Page,
  ProcessDetail,
  ProcessSummary,
  RunSummary,
  SourceDetail,
  UserDTO,
} from '../../src/api/contract.js';
import {
  approvals,
  auditLog,
  batches,
  dispatches,
  events,
  runs,
  sources,
  users,
} from '../../src/db/schema.js';
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

describe('plugin types', () => {
  it('serves settings schemas with their declared field order', async () => {
    // jsonb would reorder keys (shortest first: org, secret); the form must keep secret first.
    const res = await h.request('GET', '/api/v1/plugin-types?kind=source', {
      cookie: h.adminCookie,
    });
    const type = res
      .json<{ typeId: string; settingsSchema: { properties: Record<string, unknown> } }[]>()
      .find((t) => t.typeId === 'test-source');
    expect(Object.keys(type?.settingsSchema.properties ?? {})).toEqual(['secret', 'org']);
  });

  it('carries the icon a type declares, on the type and on instance summaries', async () => {
    const res = await h.request('GET', '/api/v1/plugin-types?kind=source', {
      cookie: h.adminCookie,
    });
    const type = res
      .json<{ typeId: string; icon?: string }[]>()
      .find((t) => t.typeId === 'test-source');
    expect(type?.icon).toBe('webhook');
    const created = await createSource('Icon check');
    expect(created.typeIcon).toBe('webhook');
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
    const body = del.json<ApiError>();
    expect(body.message).toMatch(/Uses them/);
    const pid = proc.json<ProcessDetail>().id;
    expect(body.usedBy).toEqual([{ id: pid, name: 'Uses them' }]);

    // Once the process is gone the source can go too.
    const gone = await h.request('DELETE', `/api/v1/processes/${pid}`, {
      cookie: h.adminCookie,
      body: { reason: 'retired' },
    });
    expect(gone.statusCode).toBe(204);
    const again = await h.request('GET', `/api/v1/processes/${pid}`, { cookie: h.adminCookie });
    expect(again.statusCode).toBe(404);
    const freed = await h.request('DELETE', `/api/v1/sources/${src.id}`, {
      cookie: h.adminCookie,
      body: { reason },
    });
    expect(freed.statusCode).toBe(204);
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

  it('flags a never-run disabled process that turned events away, and explains the event', async () => {
    const src = await createSource('Test — forgotten');
    const ex = await createExecutor('Exec — forgotten');
    const doc = { ...processDoc(src.id, ex.id, 'Forgotten'), enabled: false };
    const created = await h.request('POST', '/api/v1/processes', {
      cookie: h.adminCookie,
      body: { document: doc, reason },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pid = created.json<ProcessDetail>().id;
    const at = h.clock.now();
    const eventId = randomUUID();
    await tdb.db.insert(events).values({
      id: eventId,
      sourceId: src.id,
      sourceType: 'test-source',
      type: 'test-source.item.created',
      occurredAt: at,
      receivedAt: at,
      artifact: { kind: 'test.item', id: 'FORGOT-1' },
      artifactKey: 'test.item:FORGOT-1',
      attributes: { label: 'x' },
      dedupeKey: 'k-forgot',
      rawRef: 'r-forgot',
      stage: 'unmatched',
      matchDecisions: [
        {
          processId: pid,
          triggerId: 't1',
          result: false,
          skip: 'process_disabled',
          at: at.toISOString(),
        },
      ],
    });
    const res = await h.request('GET', '/api/v1/board', { cookie: h.adminCookie });
    const board = res.json<{ attention: { kind: string; targetId: string; title: string }[] }>();
    const item = board.attention.find((a) => a.kind === 'process_disabled' && a.targetId === pid);
    expect(item?.title).toBe('Forgotten is disabled and turned away 1 event in 24 h');

    const detail = await h.request('GET', `/api/v1/events/${eventId}`, { cookie: h.adminCookie });
    expect(detail.json<EventDetail>().explanations).toEqual([
      {
        processId: pid,
        processName: 'Forgotten',
        taken: false,
        reason: 'process is disabled',
        basis: 'recorded',
        tone: 'warn',
      },
    ]);
    const list = await h.request('GET', `/api/v1/events?source=${src.id}`, {
      cookie: h.adminCookie,
    });
    expect(list.json<Page<ActivityRow>>().items[0]?.whyNothingRan).toBe(
      'Forgotten: process is disabled',
    );
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

  it('rate-limits one instance however its id is spelled', async () => {
    const id = randomUUID();
    const hit = (url: string) => h.app.inject({ method: 'POST', url, payload: '{}' });
    for (let i = 0; i < 600; i++) await hit(`/hooks/${id}`);
    expect((await hit(`/hooks/${id.toUpperCase()}`)).statusCode).toBe(429);
    expect((await hit(`/hooks/${randomUUID()}`)).statusCode).toBe(200);
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

describe('unauthenticated sources', () => {
  const create = (typeId: string, settings: Record<string, unknown>, caps = {}) =>
    h.request('POST', '/api/v1/sources', {
      cookie: h.adminCookie,
      body: { typeId, name: `${typeId} ${randomUUID().slice(0, 6)}`, settings, caps, reason },
    });

  it('derives unauthenticated from the plugin setting alone (verification: none)', async () => {
    const res = await create('test-open', { verification: 'none' });
    expect(res.statusCode, res.body).toBe(201);
    const detail = res.json<SourceDetail>();
    expect(detail.unauthenticated).toBe(true);
    expect(detail.caps.unauthenticated).toBe(true);
    const [row] = await tdb.db.select().from(sources).where(eq(sources.id, detail.id));
    expect(row?.caps.unauthenticated).toBe(true);
  });

  it('ignores an unauthenticated flag when the instance verifies, and clears it on update', async () => {
    const res = await create(
      'test-open',
      { verification: 'secret', secret: 'secret://env/TEST_SOURCE_SECRET' },
      { unauthenticated: true, eventCapPerHour: 10 },
    );
    expect(res.statusCode, res.body).toBe(201);
    const detail = res.json<SourceDetail>();
    expect(detail.unauthenticated).toBe(false);
    expect(detail.caps).toEqual({ eventCapPerHour: 10 });

    const open = await h.request('PUT', `/api/v1/sources/${detail.id}`, {
      cookie: h.adminCookie,
      body: { settings: { verification: 'none' }, reason },
    });
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json<SourceDetail>()).toMatchObject({
      unauthenticated: true,
      caps: { eventCapPerHour: 10, unauthenticated: true },
    });

    const closed = await h.request('PUT', `/api/v1/sources/${detail.id}`, {
      cookie: h.adminCookie,
      body: {
        settings: { verification: 'secret', secret: 'secret://env/TEST_SOURCE_SECRET' },
        reason,
      },
    });
    expect(closed.json<SourceDetail>()).toMatchObject({
      unauthenticated: false,
      caps: { eventCapPerHour: 10 },
    });
    expect(closed.json<SourceDetail>().caps).not.toHaveProperty('unauthenticated');
  });

  it('refuses a push instance without verify for a type that does not allow it', async () => {
    const res = await create('test-noverify', {}, { unauthenticated: true });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ message: string }>().message).toMatch(/must verify deliveries/);
    const rows = await tdb.db.select().from(sources).where(eq(sources.typeId, 'test-noverify'));
    expect(rows).toHaveLength(0);
  });
});

describe('edge cases', () => {
  /** Walk every page of a list endpoint with `limit=1`, collecting the ids it returns. */
  async function walk(url: string, idOf: (item: never) => string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const sep = url.includes('?') ? '&' : '?';
      const res = await h.request(
        'GET',
        `${url}${sep}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        { cookie: h.adminCookie },
      );
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<Page<never>>();
      seen.push(...page.items.map(idOf));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return seen;
  }

  async function processWithBatches(name: string, n: number) {
    const src = await createSource(`${name} source`);
    const ex = await createExecutor(`${name} exec`);
    const created = await h.request('POST', '/api/v1/processes', {
      cookie: h.adminCookie,
      body: { document: processDoc(src.id, ex.id, name), reason },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pid = created.json<ProcessDetail>().id;
    const now = h.clock.now();
    const ids: string[] = Array.from({ length: n }, () => randomUUID());
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
    return { src, ex, pid, ids, now };
  }

  it('pages runs that share a timestamp without skipping any', async () => {
    const { ex, pid, ids, now } = await processWithBatches('Tied runs', 3);
    await tdb.db.insert(runs).values(
      ids.map((batchId) => ({
        batchId,
        processId: pid,
        processVersion: 1,
        executorId: ex.id,
        kind: 'event' as const,
        status: 'ok' as const,
        attempts: 1,
        createdAt: now,
      })),
    );
    const seen = await walk(`/api/v1/runs?process=${pid}`, (r: RunSummary) => r.id);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('pages approval history that shares a decision time without skipping any', async () => {
    const { pid, ids, now } = await processWithBatches('Tied approvals', 3);
    await tdb.db.insert(approvals).values(
      ids.map((batchId) => ({
        batchId,
        processId: pid,
        rule: 'always',
        requestedAt: now,
        decidedAt: now,
        decidedBy: ADMIN_EMAIL,
        decision: 'approved' as const,
        reason,
      })),
    );
    const seen = await walk('/api/v1/approvals/history', (a: { batchId: string }) => a.batchId);
    expect(seen.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
  });

  it('filters a source’s events by type before paging', async () => {
    const src = await createSource('Typed events');
    const base = h.clock.now().getTime();
    const event = (i: number, type: string) => ({
      id: randomUUID(),
      sourceId: src.id,
      sourceType: 'test-source',
      type,
      occurredAt: new Date(base + i * 1000),
      receivedAt: new Date(base + i * 1000),
      artifact: { kind: 'test.item', id: `TYPED-${i}` },
      artifactKey: `test.item:TYPED-${i}`,
      attributes: {},
      dedupeKey: `k-typed-${i}`,
      rawRef: `r-typed-${i}`,
      stage: 'received' as const,
    });
    // Newest first: the other type is on top, the wanted type below it.
    await tdb.db
      .insert(events)
      .values([
        event(1, 'test-source.item.created'),
        event(2, 'test-source.item.created'),
        event(3, 'test-source.other'),
      ]);
    const res = await h.request(
      'GET',
      `/api/v1/sources/${src.id}/events?type=test-source.item.created&limit=1`,
      { cookie: h.adminCookie },
    );
    const page = res.json<Page<{ type: string }>>();
    expect(page.items.map((i) => i.type)).toEqual(['test-source.item.created']);
    expect(page.nextCursor).not.toBeNull();
    const all = await walk(
      `/api/v1/sources/${src.id}/events?type=test-source.item.created`,
      (e: { eventId: string }) => e.eventId,
    );
    expect(all).toHaveLength(2);
  });

  it('answers 400, not 500, for a malformed time filter or cursor', async () => {
    for (const url of [
      '/api/v1/events?from=yesterday',
      '/api/v1/events?to=2026-13-45',
      `/api/v1/events?cursor=${Buffer.from(JSON.stringify({ t: 'soon' })).toString('base64url')}`,
      `/api/v1/runs?cursor=${Buffer.from(JSON.stringify({ t: 'soon' })).toString('base64url')}`,
    ]) {
      const res = await h.request('GET', url, { cookie: h.adminCookie });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('keeps one admin when two admins are demoted at the same time', async () => {
    const second = await h.request('POST', '/api/v1/users', {
      cookie: h.adminCookie,
      body: { email: 'second-admin@acme.test', role: 'admin', reason },
    });
    expect(second.statusCode, second.body).toBe(201);
    const admins = await tdb.db.select().from(users).where(eq(users.role, 'admin'));
    expect(admins).toHaveLength(2);
    const results = await Promise.all(
      admins.map((a) =>
        h.request('PUT', `/api/v1/users/${a.id}`, {
          cookie: h.adminCookie,
          body: { role: 'viewer', reason },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const left = await tdb.db.select().from(users).where(eq(users.role, 'admin'));
    expect(left).toHaveLength(1);
    // Put things back for the tests that follow.
    for (const a of admins)
      await tdb.db.update(users).set({ role: 'admin' }).where(eq(users.id, a.id));
    await tdb.db.delete(users).where(eq(users.email, 'second-admin@acme.test'));
  });

  it('refuses an enable request that does not say enabled or disabled', async () => {
    const src = await createSource('Enable body');
    const ex = await createExecutor('Enable body exec');
    const created = await h.request('POST', '/api/v1/processes', {
      cookie: h.adminCookie,
      body: { document: processDoc(src.id, ex.id, 'Enable body'), reason },
    });
    const proc = created.json<ProcessDetail>();
    for (const url of [
      `/api/v1/sources/${src.id}/enable`,
      `/api/v1/executors/${ex.id}/enable`,
      `/api/v1/processes/${proc.id}/enable`,
    ]) {
      const res = await h.request('POST', url, { cookie: h.adminCookie, body: { reason } });
      expect(res.statusCode, url).toBe(400);
    }
    const after = await h.request('GET', `/api/v1/processes/${proc.id}`, { cookie: h.adminCookie });
    expect(after.json<ProcessDetail>()).toMatchObject({
      version: 1,
      document: { enabled: proc.document.enabled },
    });
  });

  it('answers 404 for a malformed id in the path', async () => {
    for (const url of ['/api/v1/sources/not-a-uuid', '/api/v1/processes/123', '/api/v1/runs/x']) {
      const res = await h.request('GET', url, { cookie: h.adminCookie });
      expect(res.statusCode, url).toBe(404);
    }
    const res = await h.request('GET', '/api/v1/processes/not-a-uuid/versions/abc', {
      cookie: h.adminCookie,
    });
    expect(res.statusCode).toBe(404);
  });

  it('audits target names for the page it returns', async () => {
    const src = await createSource('Audited name');
    const res = await h.request('GET', `/api/v1/audit?target=${src.id}`, {
      cookie: h.adminCookie,
    });
    const page = res.json<Page<{ targetName: string | null }>>();
    expect(page.items[0]?.targetName).toBe('Audited name');
    const settings = await h.request('GET', '/api/v1/audit?scope=settings', {
      cookie: h.adminCookie,
    });
    expect(settings.statusCode).toBe(200);
    // The actor filter is a substring match: LIKE wildcards in it are literal.
    const wildcard = await h.request('GET', '/api/v1/audit?actor=%25', { cookie: h.adminCookie });
    expect(wildcard.json<Page<unknown>>().items).toEqual([]);
  });
});
