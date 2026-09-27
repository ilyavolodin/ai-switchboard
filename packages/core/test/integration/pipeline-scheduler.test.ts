import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scheduleTicks } from '../../src/db/schema.js';
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
});

/** Run the scheduler every minute from the clock's time to `until`. */
async function tickEveryMinute(harness: Harness, until: string): Promise<void> {
  const end = Date.parse(until);
  while (harness.clock.now().getTime() <= end) {
    await harness.queue.tick('scheduler.tick');
    await harness.drain();
    harness.clock.advanceSeconds(60);
  }
}

describe('scheduler', () => {
  it('a cron fires once across the DST fall-back (01:30 happens twice)', async () => {
    h = await createHarness(tdb.db, '2026-11-01T04:00:05Z'); // 00:00 EDT
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, null, {
      schedules: [
        {
          id: 's1',
          cron: '30 1 * * *',
          timezone: 'America/New_York',
          catchUp: 'skip',
          enabled: true,
        },
      ],
    });
    await tickEveryMinute(h, '2026-11-01T08:00:05Z');
    const runs = await runsOf(h.db, pid);
    expect(runs).toHaveLength(1);
    const ticks = await h.db.select().from(scheduleTicks);
    expect(ticks.map((t) => t.tickAt.toISOString())).toEqual(['2026-11-01T05:30:00.000Z']);
  });

  it('a cron in a spring-forward gap fires once, right after the gap', async () => {
    h = await createHarness(tdb.db, '2026-03-08T06:00:05Z'); // 01:00 EST
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, null, {
      schedules: [
        {
          id: 's1',
          cron: '30 2 * * *',
          timezone: 'America/New_York',
          catchUp: 'skip',
          enabled: true,
        },
      ],
    });
    await tickEveryMinute(h, '2026-03-08T08:00:05Z');
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    const ticks = await h.db.select().from(scheduleTicks);
    expect(ticks.map((t) => t.tickAt.toISOString())).toEqual(['2026-03-08T07:00:00.000Z']);
  });

  it("a restart at 07:20 runs the missed 07:00 sweep once (catchUp 'once')", async () => {
    h = await createHarness(tdb.db, '2026-01-05T06:59:30Z');
    const ex = await seedExecutor(h);
    const once = await seedProcess(h, ex.id, null, {
      schedules: [{ id: 's1', cron: '0 7 * * *', timezone: 'UTC', catchUp: 'once', enabled: true }],
    });
    const skip = await seedProcess(h, ex.id, null, {
      schedules: [{ id: 's1', cron: '0 7 * * *', timezone: 'UTC', catchUp: 'skip', enabled: true }],
    });
    // Yesterday's ticks fired normally (history).
    await h.db.insert(scheduleTicks).values([
      {
        processId: once,
        scheduleId: 's1',
        tickAt: new Date('2026-01-04T07:00:00Z'),
        firedAt: new Date('2026-01-04T07:00:02Z'),
      },
      {
        processId: skip,
        scheduleId: 's1',
        tickAt: new Date('2026-01-04T07:00:00Z'),
        firedAt: new Date('2026-01-04T07:00:02Z'),
      },
    ]);
    // The installation is down from 06:59:30 to 07:20; a fresh replica starts.
    h.clock.set('2026-01-05T07:20:00Z');
    const restarted = await h.replica();
    for (let i = 0; i < 3; i++) {
      await restarted.queue.tick('scheduler.tick');
      await restarted.queue.drain();
      h.clock.advanceSeconds(60);
    }
    const onceRuns = await runsOf(h.db, once);
    expect(onceRuns).toHaveLength(1);
    expect(onceRuns[0]?.kind).toBe('sweep');
    expect(await runsOf(h.db, skip)).toHaveLength(0);
    const ticks = (await h.db.select().from(scheduleTicks)).filter((t) => t.processId === once);
    expect(ticks.find((t) => t.catchUp)?.tickAt.toISOString()).toBe('2026-01-05T07:00:00.000Z');
  });

  it('a sweep merges the open event batch into one run', async () => {
    h = await createHarness(tdb.db, '2026-01-05T08:59:50Z');
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      batching: { debounceSeconds: 120 },
      schedules: [{ id: 's1', cron: '0 9 * * *', timezone: 'UTC', catchUp: 'skip', enabled: true }],
    });
    await deliver(h, src.id, [{ id: '1', version: 'a' }]);
    await h.drain();
    h.clock.set('2026-01-05T09:00:03Z');
    await h.queue.tick('scheduler.tick');
    await h.drain();
    await h.advance(200);
    const runs = await runsOf(h.db, pid);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe('sweep');
    expect(runs[0]?.input).toMatchObject({ mode: 'sweep', artifacts: ['1'] });
    const batches = await batchesOf(h.db, pid);
    expect(batches.map((b) => [b.kind, b.outcome])).toEqual([
      ['event', 'merged'],
      ['sweep', 'invoked'],
    ]);
  });

  it('two replicas ticking at once fire the sweep once', async () => {
    h = await createHarness(tdb.db, '2026-01-05T08:59:00Z');
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, null, {
      schedules: [{ id: 's1', cron: '0 9 * * *', timezone: 'UTC', catchUp: 'skip', enabled: true }],
    });
    h.clock.set('2026-01-05T09:00:01Z');
    const other = await h.replica();
    await Promise.all([h.pipeline.schedulerTick(), other.pipeline.schedulerTick()]);
    await Promise.all([h.drain(), other.queue.drain()]);
    expect(await runsOf(h.db, pid)).toHaveLength(1);
  });
});
