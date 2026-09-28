import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { executors, runUpdates, runs } from '../../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { EXEC_PLUGIN, callbackRequest } from '../helpers/fake-runtime.js';
import {
  batchesOf,
  createHarness,
  deliver,
  resetDb,
  runsOf,
  seedExecutor,
  seedProcess,
  seedSource,
  type Harness,
} from '../helpers/harness.js';

let tdb: TestDatabase;
let h: Harness;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});
beforeEach(async () => {
  await resetDb(tdb.db);
  h = await createHarness(tdb.db);
});

async function fireOne(sourceId: string, id: string): Promise<void> {
  await deliver(h, sourceId, [{ id, version: 'v1' }]);
  await h.drain();
  await h.advance(31);
}

async function onlyRun(pid: string) {
  const list = await runsOf(h.db, pid);
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe('tracking', () => {
  it('a callback closes a run with its usage', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'callback' });
    const pid = await seedProcess(h, ex.id, src.id);
    await fireOne(src.id, '1');
    const run = await onlyRun(pid);
    expect(run.status).toBe('running');
    expect(run.externalUrl).toBe(`https://backend.test/runs/${run.id}`);
    expect(ex.state.invocations[0]?.run.callbackUrl).toBe(
      `http://switchboard.test/callbacks/${ex.id}`,
    );

    const bad = await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('wrong', { runId: run.id, state: 'ok' }),
    );
    expect(bad.status).toBe(401);
    const unknownRun = await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('callback-token', {
        runId: '00000000-0000-4000-8000-000000000123',
        state: 'ok',
      }),
    );
    expect(unknownRun.status).toBe(404);

    const res = await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('callback-token', {
        runId: run.id,
        state: 'ok',
        usage: { tokens: 1234, nope: 1 },
      }),
    );
    expect(res.status).toBe(200);
    await h.drain();
    const closed = await onlyRun(pid);
    expect(closed).toMatchObject({ status: 'ok', usage: { tokens: 1234 } });
    expect(h.runtime.errors).toContainEqual(
      expect.objectContaining({ plugin: EXEC_PLUGIN, kind: 'invalid_usage' }),
    );
    // A repeated callback is a no-op.
    expect(
      (
        await h.pipeline.handleCallback(
          ex.id,
          callbackRequest('callback-token', { runId: run.id, state: 'error' }),
        )
      ).status,
    ).toBe(200);
    expect((await onlyRun(pid)).status).toBe('ok');
  });

  it('a missing callback hits the deadline and the run is unknown', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'callback' });
    const pid = await seedProcess(h, ex.id, src.id, { trackingDeadlineMinutes: 60 });
    await fireOne(src.id, '1');
    expect((await onlyRun(pid)).status).toBe('running');
    await h.advance(59 * 60);
    expect((await onlyRun(pid)).status).toBe('running');
    await h.advance(60);
    const run = await onlyRun(pid);
    expect(run).toMatchObject({ status: 'unknown', statusReason: 'deadline' });
  });

  it('polls on backoff until the executor reports a terminal state', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'poll' });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.pollScript.push(
      { state: 'running' },
      { state: 'running' },
      { state: 'error', errors: ['boom'], usage: { tokens: 5 } },
    );
    await fireOne(src.id, '1');
    expect(ex.state.polls).toHaveLength(0);
    await h.advance(30);
    expect(ex.state.polls).toHaveLength(1);
    await h.advance(59);
    expect(ex.state.polls).toHaveLength(1);
    await h.advance(1);
    expect(ex.state.polls).toHaveLength(2);
    await h.advance(120);
    expect(ex.state.polls).toHaveLength(3);
    const run = await onlyRun(pid);
    expect(run).toMatchObject({ status: 'error', errors: ['boom'], usage: { tokens: 5 } });
  });

  it('a lost response on a non-idempotent executor is uncertain and never re-invoked', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'callback', idempotent: false });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push('timeout');
    await fireOne(src.id, '1');
    const run = await onlyRun(pid);
    expect(run.status).toBe('uncertain');
    await h.advance(600);
    await h.pipeline.maintenance();
    await h.drain();
    expect(ex.state.invocations).toHaveLength(1);
    // Tracking settles it.
    await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('callback-token', { runId: run.id, state: 'ok' }),
    );
    expect((await onlyRun(pid)).status).toBe('ok');
    expect(ex.state.invocations).toHaveLength(1);
  });

  it('an idempotent executor retries a lost response with the same run id', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { idempotent: true });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push('timeout');
    await fireOne(src.id, '1');
    expect((await onlyRun(pid)).status).toBe('invoking');
    await h.advance(5);
    const run = await onlyRun(pid);
    expect(run.status).toBe('ok');
    expect(ex.state.invocations.map((i) => i.run.id)).toEqual([run.id, run.id]);
  });

  it('connection refused and 503 are retried; the run completes once', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push('refused', '503');
    await fireOne(src.id, '1');
    await h.advance(5);
    await h.advance(10);
    const run = await onlyRun(pid);
    expect(run).toMatchObject({ status: 'ok', attempts: 3 });
    expect(ex.state.invocations).toHaveLength(3);
    const updates = await h.db.select().from(runUpdates).where(eq(runUpdates.runId, run.id));
    expect(
      updates.filter((u) => (u.detail as { retry?: boolean } | null)?.retry === true),
    ).toHaveLength(2);
  });

  it('401 fails the run, marks the executor unhealthy and holds the next batch', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push('401');
    await fireOne(src.id, '1');
    expect((await onlyRun(pid)).status).toBe('failed');
    const [row] = await h.db.select().from(executors).where(eq(executors.id, ex.id));
    expect(row?.health?.status).toBe('unhealthy');
    await fireOne(src.id, '2');
    const batches = await batchesOf(h.db, pid);
    expect(batches[1]).toMatchObject({ outcome: 'held', outcomeReason: 'executor_unhealthy' });
  });

  it('a paused target is a held run (terminal)', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push('paused');
    await fireOne(src.id, '1');
    expect(await onlyRun(pid)).toMatchObject({ status: 'held', statusReason: 'paused:paused' });
  });

  it('tracking none closes ok on start; a sync failure is error', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'none' });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push('started', 'failed');
    await fireOne(src.id, '1');
    await fireOne(src.id, '2');
    expect((await runsOf(h.db, pid)).map((r) => r.status)).toEqual(['ok', 'error']);
  });

  it('after a restart, an invoking run past its invoke deadline becomes uncertain', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'callback' });
    const pid = await seedProcess(h, ex.id, src.id);
    // The invoke never returns (the replica died mid-call).
    ex.state.script.push(() => new Promise(() => undefined));
    await deliver(h, src.id, [{ id: '1', version: 'v1' }]);
    await h.drain();
    h.clock.advanceSeconds(31);
    void h.drain();
    await new Promise((r) => setTimeout(r, 200));
    expect((await onlyRun(pid)).status).toBe('invoking');
    // The core default timeout (300 s) plus the margin (30 s) has passed.
    h.clock.advanceSeconds(331);
    const restarted = await h.replica();
    await restarted.queue.drain();
    const run = await onlyRun(pid);
    expect(run).toMatchObject({ status: 'uncertain', invokeDeadlineAt: null });
    const [update] = await h.db.select().from(runUpdates).where(eq(runUpdates.runId, run.id));
    expect(update?.source).toBe('recovery');
    expect(ex.state.invocations).toHaveLength(1);
  });

  it('recovery leaves an invoke alone while it is inside its own deadline', async () => {
    const src = await seedSource(h);
    // A slow backend: the type allows 10 minutes for invoke to answer.
    const ex = await seedExecutor(h, { tracking: 'callback', invokeTimeoutSeconds: 600 });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push(() => new Promise(() => undefined));
    await deliver(h, src.id, [{ id: '1', version: 'v1' }]);
    await h.drain();
    h.clock.advanceSeconds(31);
    void h.drain();
    await new Promise((r) => setTimeout(r, 200));
    const claimed = await onlyRun(pid);
    expect(claimed.invokeDeadlineAt?.getTime()).toBe(
      (claimed.invokeStartedAt?.getTime() ?? 0) + (600 + 30) * 1000,
    );
    // Well past the old fixed 60 s staleness, but inside the attempt's deadline.
    h.clock.advanceSeconds(400);
    const other = await h.replica();
    await other.pipeline.maintenance();
    await other.queue.drain();
    expect((await onlyRun(pid)).status).toBe('invoking');
    h.clock.advanceSeconds(231);
    await other.pipeline.maintenance();
    await other.queue.drain();
    expect((await onlyRun(pid)).status).toBe('uncertain');
    expect(ex.state.invocations).toHaveLength(1);
  });

  it('a hung invoke times out: uncertain for a non-idempotent executor, not a plugin error', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, {
      tracking: 'callback',
      idempotent: false,
      caps: { invokeTimeoutSeconds: 1 },
      // The instance cap wins over the type's value.
      invokeTimeoutSeconds: 600,
    });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push(() => new Promise(() => undefined));
    await fireOne(src.id, '1');
    const run = await onlyRun(pid);
    expect(run).toMatchObject({ status: 'uncertain', statusReason: 'no answer within 1 s' });
    expect(h.runtime.errors).toEqual([]);
    await h.advance(600);
    await h.pipeline.maintenance();
    await h.drain();
    expect(ex.state.invocations).toHaveLength(1);
  });

  it('a hung invoke on an idempotent executor is retried with the same run id', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { idempotent: true, invokeTimeoutSeconds: 1 });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push(() => new Promise(() => undefined));
    await fireOne(src.id, '1');
    expect((await onlyRun(pid)).status).toBe('invoking');
    await h.advance(5);
    const run = await onlyRun(pid);
    expect(run.status).toBe('ok');
    expect(ex.state.invocations.map((i) => i.run.id)).toEqual([run.id, run.id]);
    expect(h.runtime.errors).toEqual([]);
  });

  it('closeRun by hand settles an uncertain run and is audited', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'callback' });
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push('timeout');
    await fireOne(src.id, '1');
    const run = await onlyRun(pid);
    await h.pipeline.closeRun(run.id, 'ok', 'op@example.com', 'checked the backend');
    const [row] = await h.db.select().from(runs).where(eq(runs.id, run.id));
    expect(row?.status).toBe('ok');
    await expect(
      h.pipeline.closeRun(run.id, 'ok', 'op@example.com', 'again'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
