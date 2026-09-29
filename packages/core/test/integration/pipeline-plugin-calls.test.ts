import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processes, runs } from '../../src/db/schema.js';
import { createExpressionEngine } from '../../src/expr/index.js';
import type { Ctx } from '../../src/services/pipeline/context.js';
import { pollSource } from '../../src/services/pipeline/ingest.js';
import { pollRun } from '../../src/services/pipeline/runs.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { EXEC_PLUGIN, HOOK_PLUGIN, callbackRequest } from '../helpers/fake-runtime.js';
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

function directCtx(pluginCallTimeoutMs?: number): Ctx {
  return {
    ...h.deps,
    secrets: { resolve: () => Promise.resolve('') },
    engine: createExpressionEngine(),
    log: h.deps.logger,
    ...(pluginCallTimeoutMs !== undefined ? { pluginCallTimeoutMs } : {}),
  };
}

async function fireOne(sourceId: string, id: string): Promise<void> {
  await deliver(h, sourceId, [{ id, version: 'v1' }]);
  await h.drain();
  await h.advance(31);
}

function errorsOf(plugin: string) {
  return h.runtime.errors.filter((e) => e.plugin === plugin && e.kind === 'exception');
}

describe('plugin calls', () => {
  it('a poll that never settles times out, is counted and scheduled again', async () => {
    const src = await seedSource(h);
    const ex = await seedDestination(h, { tracking: 'poll' });
    const pid = await seedProcess(h, ex.id, src.id);
    h.runtime.destinations.get(ex.id)!.destination.poll = () => new Promise(() => undefined);
    await fireOne(src.id, '1');
    const [run] = await runsOf(h.db, pid);
    h.clock.advanceSeconds(30);
    await pollRun(directCtx(50), run!.id);
    expect(errorsOf(EXEC_PLUGIN)).toEqual([
      expect.objectContaining({ detail: expect.stringContaining('timed out') as unknown }),
    ]);
    const [after] = await h.db.select().from(runs).where(eq(runs.id, run!.id));
    expect(after).toMatchObject({ status: 'running', pollCount: 1 });
    expect(after?.nextPollAt?.getTime()).toBeGreaterThan(h.clock.now().getTime());
  });

  it('two replicas handling the same poll job at once poll the backend once', async () => {
    const src = await seedSource(h);
    const ex = await seedDestination(h, { tracking: 'poll' });
    const pid = await seedProcess(h, ex.id, src.id);
    let polls = 0;
    h.runtime.destinations.get(ex.id)!.destination.poll = async () => {
      polls++;
      await new Promise((r) => setTimeout(r, 30));
      return { state: 'running' };
    };
    await fireOne(src.id, '1');
    const [run] = await runsOf(h.db, pid);
    h.clock.advanceSeconds(30);
    await Promise.all([pollRun(directCtx(), run!.id), pollRun(directCtx(), run!.id)]);
    expect(polls).toBe(1);
  });

  it('a pull source whose poll throws or returns garbage is counted, not crashed', async () => {
    const pull = await seedSource(h, { caps: { pollIntervalSeconds: 10 } });
    const live = h.runtime.sources.get(pull.id)!;
    live.type = { ...live.type, mode: 'pull' };
    live.source.poll = () => Promise.resolve(null as never);
    await expect(pollSource(directCtx(), pull.id)).resolves.toBeUndefined();
    live.source.poll = () => Promise.reject(new Error('upstream 502'));
    await expect(pollSource(directCtx(), pull.id)).resolves.toBeUndefined();
    const errors = errorsOf(HOOK_PLUGIN).map((e) => e.detail);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain('upstream 502');
  });

  it('a parse or verifyCallback that throws is counted once, by the runtime wrapper', async () => {
    const src = await seedSource(h);
    const ex = await seedDestination(h, { tracking: 'callback' });
    h.runtime.sources.get(src.id)!.source.parse = () => {
      throw new Error('unexpected payload');
    };
    expect(await deliver(h, src.id, [{ id: '1' }])).toBe(200);
    expect(errorsOf(HOOK_PLUGIN)).toHaveLength(1);
    h.runtime.destinations.get(ex.id)!.destination.verifyCallback = () => {
      throw new Error('bad token format');
    };
    const res = await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('callback-token', { runId: ex.id, state: 'ok' }),
    );
    expect(res.status).toBe(401);
    expect(errorsOf(EXEC_PLUGIN)).toHaveLength(1);
  });
});

describe('breaker cooldown', () => {
  it('never closes a breaker that re-opened while the batch was being gated', async () => {
    const src = await seedSource(h);
    const ex = await seedDestination(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      gates: {
        breaker: { threshold: 2, cooldownMinutes: 30 },
        // Evaluated before the gate: its lookup is where another replica's write lands.
        approval: '$exists($resolve(events[0].artifact).nope)',
      },
    });
    const opened = h.clock.now();
    await h.db
      .update(processes)
      .set({ breakerState: 'open', breakerOpenedAt: opened })
      .where(eq(processes.id, pid));
    await deliver(h, src.id, [{ id: '1', version: 'v1' }]);
    await h.drain();
    h.clock.advanceMinutes(31);
    const reopenedAt = h.clock.now();
    h.runtime.sources.get(src.id)!.source.resolve = async () => {
      await h.db
        .update(processes)
        .set({ breakerState: 'open', breakerOpenedAt: reopenedAt })
        .where(eq(processes.id, pid));
      return null;
    };
    await h.drain();
    const [proc] = await h.db.select().from(processes).where(eq(processes.id, pid));
    expect(proc).toMatchObject({ breakerState: 'open', breakerOpenedAt: reopenedAt });
  });
});
