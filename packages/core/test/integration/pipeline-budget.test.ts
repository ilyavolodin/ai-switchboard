import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { executors, meterReadings } from '../../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
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

describe('budget and meters', () => {
  it('a 429 opens a soft-hold honoured by the next batch', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    ex.state.script.push({ retryAfter: 600 });
    await fireOne(src.id, '1');
    const [first] = await runsOf(h.db, pid);
    expect(first).toMatchObject({ status: 'failed', statusReason: 'rate_limited' });
    const [row] = await h.db.select().from(executors).where(eq(executors.id, ex.id));
    expect(row?.softHoldUntil?.toISOString()).toBe(
      new Date(h.clock.now().getTime() + 600_000 - 0).toISOString(),
    );

    await fireOne(src.id, '2');
    const batches = await batchesOf(h.db, pid);
    expect(batches[1]).toMatchObject({ outcome: 'throttled', outcomeReason: 'soft_hold' });
    expect(ex.state.invocations).toHaveLength(1);

    // After the hold expires the next batch runs.
    h.clock.advanceMinutes(11);
    await fireOne(src.id, '3');
    expect((await runsOf(h.db, pid)).map((r) => r.status)).toEqual(['failed', 'ok']);
  });

  it('a ceiling holds event runs and admits a sweep', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      budgets: { meterCeilings: { five_hour: { events: 85, sweeps: 95 } } },
      schedules: [
        { id: 's1', cron: '*/10 * * * *', timezone: 'UTC', catchUp: 'skip', enabled: true },
      ],
    });
    ex.state.readings = [
      { id: 'five_hour', utilization: 90, observedAt: h.clock.now().toISOString() },
    ];
    await h.pipeline.readMetersNow(ex.id);

    await fireOne(src.id, '1');
    const [eventBatch] = await batchesOf(h.db, pid);
    expect(eventBatch).toMatchObject({
      kind: 'event',
      outcome: 'throttled',
      outcomeReason: 'meter:five_hour',
    });
    const budget = eventBatch?.decisions.find((d) => d.stage === 'budget');
    expect(budget?.data?.meters).toMatchObject({ five_hour: { utilization: 90 } });

    // 09:10 sweep: 90 % is under the sweeps ceiling of 95 %.
    h.clock.set('2026-01-05T09:10:00Z');
    await h.pipeline.readMetersNow(ex.id);
    await h.queue.tick('scheduler.tick');
    await h.drain();
    const runs = await runsOf(h.db, pid);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'sweep', status: 'ok' });
    expect((runs[0]?.input as { mode: string }).mode).toBe('sweep');
  });

  it('a stale reading does not hold; counters still apply and meter_stale is recorded', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      budgets: { runsPerHour: 1, meterCeilings: { five_hour: { events: 50, sweeps: 50 } } },
    });
    ex.state.readings = [
      { id: 'five_hour', utilization: 99, observedAt: h.clock.now().toISOString() },
    ];
    await h.pipeline.readMetersNow(ex.id);
    h.clock.advanceMinutes(45); // default staleness is 30 minutes
    await fireOne(src.id, '1');
    await fireOne(src.id, '2');
    const batches = await batchesOf(h.db, pid);
    expect(batches.map((b) => b.outcome)).toEqual(['invoked', 'throttled']);
    expect(batches[1]?.outcomeReason).toBe('runs_per_hour');
    const data = batches[0]?.decisions.find((d) => d.stage === 'budget')?.data;
    expect(data?.meterStale).toEqual(['five_hour']);
  });

  it('estimated meters count runs against the typed-in limit', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { caps: { estimatedLimits: { daily_runs: 2 } } });
    const pid = await seedProcess(h, ex.id, src.id, {
      budgets: { meterCeilings: { daily_runs: { events: 100, sweeps: 100 } } },
    });
    await fireOne(src.id, '1');
    await fireOne(src.id, '2');
    await fireOne(src.id, '3');
    expect((await batchesOf(h.db, pid)).map((b) => b.outcomeReason)).toEqual([
      null,
      null,
      'meter:daily_runs',
    ]);
    await h.pipeline.readMetersNow(ex.id);
    const readings = await h.db
      .select()
      .from(meterReadings)
      .where(eq(meterReadings.meterId, 'daily_runs'));
    expect(readings.at(-1)).toMatchObject({ estimated: true, used: 2, limit: 2, utilization: 100 });
  });

  it('executor-instance caps and usage caps throttle with the binding limit', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { caps: { runsPerDay: 5 } });
    ex.state.usageOnComplete = { tokens: 600, bogus: 1 };
    const pid = await seedProcess(h, ex.id, src.id, { budgets: { usagePerDay: { tokens: 1000 } } });
    await fireOne(src.id, '1');
    await fireOne(src.id, '2');
    await fireOne(src.id, '3');
    const batches = await batchesOf(h.db, pid);
    expect(batches.map((b) => b.outcomeReason)).toEqual([null, null, 'usage_per_day:tokens']);
    const runs = await runsOf(h.db, pid);
    expect(runs[0]?.usage).toEqual({ tokens: 600 });
    expect(h.runtime.errors.some((e) => e.kind === 'invalid_usage')).toBe(true);
  });

  it('an invalid input fails the run before any budget is spent', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      input: '{ "runId": 5 }',
      budgets: { runsPerHour: 1 },
    });
    await fireOne(src.id, '1');
    await fireOne(src.id, '2');
    const runs = await runsOf(h.db, pid);
    expect(runs.map((r) => [r.status, r.statusReason, r.invokedAt])).toEqual([
      ['failed', 'input_invalid', null],
      ['failed', 'input_invalid', null],
    ]);
    expect(ex.state.invocations).toHaveLength(0);
    // Neither failure consumed the hourly cap of 1: fix the mapping and a run goes through.
    await h.db.execute(
      (await import('drizzle-orm'))
        .sql`UPDATE processes SET document = jsonb_set(document, '{input}', '"{ \\"runId\\": run.id, \\"mode\\": mode }"') WHERE id = ${pid}`,
    );
    await fireOne(src.id, '3');
    expect((await runsOf(h.db, pid)).at(-1)?.status).toBe('ok');
  });

  it('concurrent batches against one cap reserve exactly the cap', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      budgets: { runsPerHour: 2 },
      batching: { groupBy: 'artifact.id' },
    });
    await deliver(
      h,
      src.id,
      ['1', '2', '3', '4', '5'].map((id) => ({ id, version: 'a' })),
    );
    await h.drain();
    h.clock.advanceSeconds(31);
    // Fire all five batches concurrently through five replicas.
    const replicas = await Promise.all([1, 2, 3, 4, 5].map(() => h.replica()));
    const open = await batchesOf(h.db, pid);
    await Promise.all(
      open.map((b, i) => replicas[i]!.queue.send('pipeline.fire', { batchId: b.id })),
    );
    await Promise.all(replicas.map((r) => r.queue.drain()));
    const batches = await batchesOf(h.db, pid);
    expect(batches.filter((b) => b.outcome === 'invoked')).toHaveLength(2);
    expect(batches.filter((b) => b.outcome === 'throttled')).toHaveLength(3);
    expect(await runsOf(h.db, pid)).toHaveLength(2);
  });
});
