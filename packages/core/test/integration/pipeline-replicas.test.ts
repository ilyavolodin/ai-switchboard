import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import { silentLogger } from '../../src/logger.js';
import { PgBossQueue } from '../../src/queue/queue.js';
import { createPipeline } from '../../src/services/pipeline/index.js';
import { createRecordingTelemetry } from '../../src/telemetry/telemetry.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import {
  createHarness,
  deliver,
  resetDb,
  runsOf,
  seedDestination,
  seedProcess,
  seedSource,
  type Harness,
} from '../helpers/harness.js';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});
beforeEach(async () => {
  await resetDb(tdb.db);
});

describe('two replicas on one database', () => {
  it('racing ingest, matching, firing and dispatch produce no duplicate runs', async () => {
    const h: Harness = await createHarness(tdb.db);
    const other = await h.replica();
    const src = await seedSource(h);
    const ex = await seedDestination(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      batching: { groupBy: 'attributes.repository' },
    });

    for (let round = 0; round < 3; round++) {
      await Promise.all([
        deliver(h, src.id, [{ id: '1', version: 'v1', repository: 'acme/api' }], {
          deliveryId: `r${round}-a`,
        }),
        deliver(other, src.id, [{ id: '1', version: 'v1', repository: 'acme/api' }], {
          deliveryId: `r${round}-b`,
          clock: h.clock,
        }),
        deliver(other, src.id, [{ id: '2', version: 'v1', repository: 'acme/web' }], {
          deliveryId: `r${round}-c`,
          clock: h.clock,
        }),
      ]);
    }
    await Promise.all([h.drain(), other.queue.drain()]);
    h.clock.advanceSeconds(31);
    // Both replicas get a fire job for every batch, and a dispatch job too.
    const open = await tdb.db.query.batches.findMany();
    for (const b of open) {
      await h.queue.send('pipeline.fire', { batchId: b.id });
      await other.queue.send('pipeline.fire', { batchId: b.id });
      await other.queue.send('pipeline.dispatch', { batchId: b.id });
    }
    await Promise.all([h.drain(), other.queue.drain()]);
    await Promise.all([h.drain(), other.queue.drain()]);
    const runs = await runsOf(tdb.db, pid);
    expect(runs).toHaveLength(2);
    expect(ex.state.invocations).toHaveLength(2);
  });

  it('with real pg-boss queues, two replicas process the same work once', async () => {
    const clock = new FakeClock(new Date());
    const runtime = new FakeRuntime();
    const make = () => {
      const queue = new PgBossQueue(tdb.url, silentLogger());
      const deps = {
        db: tdb.db,
        clock,
        runtime,
        queue,
        logger: silentLogger(),
        telemetry: createRecordingTelemetry(),
        config: testConfig({ replicaId: `r-${Math.random()}` }),
      };
      return {
        queue,
        pipeline: createPipeline({
          ...deps,
          heartbeatIntervalMs: 0,
          secrets: { resolve: () => Promise.resolve('') },
        }),
      };
    };
    const a = make();
    const b = make();
    await a.queue.start();
    await b.queue.start();
    try {
      await a.pipeline.registerWorkers();
      await b.pipeline.registerWorkers();
      const h = { clock, runtime, db: tdb.db };
      const src = await seedSource(h);
      const ex = await seedDestination(h);
      const pid = await seedProcess(h, ex.id, src.id, {
        batching: { debounceSeconds: 0, maxSize: 1 },
      });
      await Promise.all([
        deliver(a, src.id, [{ id: '1', version: 'v1' }], { deliveryId: 'x1', clock }),
        deliver(b, src.id, [{ id: '1', version: 'v1' }], { deliveryId: 'x2', clock }),
        deliver(b, src.id, [{ id: '1', version: 'v1' }], { deliveryId: 'x1', clock }),
      ]);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const runs = await runsOf(tdb.db, pid);
        if (runs.length > 0 && runs.every((r) => r.status === 'ok')) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      // Give the other replica time to (not) produce a duplicate.
      await new Promise((r) => setTimeout(r, 2500));
      const runs = await runsOf(tdb.db, pid);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('ok');
      expect(ex.state.invocations).toHaveLength(1);
    } finally {
      await a.pipeline.stop();
      await b.pipeline.stop();
      await a.queue.stop();
      await b.queue.stop();
    }
  }, 60_000);
});
