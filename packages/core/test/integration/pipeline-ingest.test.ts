import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { rawRequest } from '@ai-switchboard/sdk/testing';

import { connect } from '../../src/db/client.js';
import { eventRaw, events, sources } from '../../src/db/schema.js';
import { createPipeline } from '../../src/services/pipeline/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import {
  EXEC_PLUGIN,
  HOOK_PLUGIN,
  ISSUE_UPDATED,
  signedDelivery,
} from '../helpers/fake-runtime.js';
import {
  SECRET,
  batchesOf,
  createHarness,
  deliver,
  dispatchesOf,
  eventsOf,
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

describe('receive → match → dedupe → batch → run', () => {
  it('a webhook event fires one process once through redeliveries', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, { batching: { debounceSeconds: 30 } });

    // The same delivery three times, and the same change under a new delivery id.
    expect(await deliver(h, src.id, [{ id: '482', version: 'v1' }], { deliveryId: 'd-1' })).toBe(
      200,
    );
    expect(await deliver(h, src.id, [{ id: '482', version: 'v1' }], { deliveryId: 'd-1' })).toBe(
      200,
    );
    await h.advance(5);
    expect(await deliver(h, src.id, [{ id: '482', version: 'v1' }], { deliveryId: 'd-1' })).toBe(
      200,
    );
    expect(await deliver(h, src.id, [{ id: '482', version: 'v1' }], { deliveryId: 'd-2' })).toBe(
      200,
    );
    await h.drain();
    await h.advance(31);

    const runs = await runsOf(h.db, pid);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('ok');
    expect(ex.state.invocations).toHaveLength(1);
    // The exact redelivery is stored once; the new delivery id is deduped at dispatch.
    expect(await eventsOf(h.db, src.id)).toHaveLength(2);
    expect(await dispatchesOf(h.db, pid, 'deduped')).toHaveLength(1);

    // A new version of the artifact is a new change and runs again.
    await deliver(h, src.id, [{ id: '482', version: 'v2' }]);
    await h.drain();
    await h.advance(31);
    expect(await runsOf(h.db, pid)).toHaveLength(2);
  });

  it('two processes on one event each run once', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const a = await seedProcess(h, ex.id, src.id);
    const b = await seedProcess(h, ex.id, src.id);
    await deliver(h, src.id, [{ id: '1', version: 'v1' }]);
    await deliver(h, src.id, [{ id: '1', version: 'v1' }]);
    await h.drain();
    await h.advance(31);
    expect(await runsOf(h.db, a)).toHaveLength(1);
    expect(await runsOf(h.db, b)).toHaveLength(1);
  });

  it('a batch key splits a burst by repository', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      batching: { groupBy: 'attributes.repository' },
    });
    await deliver(h, src.id, [
      { id: '1', version: 'a', repository: 'acme/api' },
      { id: '2', version: 'a', repository: 'acme/web' },
      { id: '3', version: 'a', repository: 'acme/api' },
    ]);
    await h.drain();
    await h.advance(31);
    const runs = await runsOf(h.db, pid);
    expect(runs).toHaveLength(2);
    const byKey = (await batchesOf(h.db, pid)).map((b) => [b.batchKey, b.size]).sort();
    expect(byKey).toEqual([
      ['acme/api', 2],
      ['acme/web', 1],
    ]);
    const inputs = runs.map((r) => (r.input as { artifacts: string[] }).artifacts.length).sort();
    expect(inputs).toEqual([1, 2]);
  });

  it('500 events in a minute produce one run per key', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, {
      batching: {
        debounceSeconds: 30,
        maxSize: 1000,
        maxAgeSeconds: 600,
        groupBy: 'attributes.repository',
      },
    });
    const repos = ['acme/api', 'acme/web', 'acme/cli'];
    for (let i = 0; i < 500; i++) {
      expect(
        await deliver(h, src.id, [{ id: String(i), version: 'v1', repository: repos[i % 3] }]),
      ).toBe(200);
      h.clock.advance(100);
      if (i % 50 === 49) await h.drain();
    }
    await h.drain();
    expect(await runsOf(h.db, pid)).toHaveLength(0);
    await h.advance(31);
    const runs = await runsOf(h.db, pid);
    expect(runs).toHaveLength(3);
    expect(ex.state.invocations).toHaveLength(3);
    const sizes = (await batchesOf(h.db, pid)).map((b) => b.size).sort((x, y) => x - y);
    expect(sizes).toEqual([166, 167, 167]);
  }, 120_000);

  it('closes a batch at maxSize without waiting for the debounce', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, { batching: { maxSize: 2 } });
    await deliver(h, src.id, [
      { id: '1', version: 'a' },
      { id: '2', version: 'a' },
      { id: '3', version: 'a' },
    ]);
    await h.drain();
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    await h.advance(31);
    expect(await runsOf(h.db, pid)).toHaveLength(2);
  });

  it('a filter decides, a failing filter is false and recorded', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const ok = await seedProcess(h, ex.id, src.id, {
      triggers: [
        {
          id: 't1',
          sourceId: src.id,
          eventTypes: ['fake-hook.pr.*'],
          filter: "attributes.label = 'auto:fix'",
          describe: '',
          enabled: true,
        },
      ],
    });
    const broken = await seedProcess(h, ex.id, src.id, {
      triggers: [
        {
          id: 't1',
          sourceId: src.id,
          eventTypes: ['*'],
          filter: 'attributes.label =',
          describe: '',
          enabled: true,
        },
      ],
    });
    await deliver(h, src.id, [
      { id: '1', version: 'a' },
      { id: '2', version: 'a', label: 'other' },
    ]);
    await h.drain();
    await h.advance(31);
    const runs = await runsOf(h.db, ok);
    expect(runs).toHaveLength(1);
    expect((runs[0]?.input as { artifacts: string[] }).artifacts).toEqual(['1']);
    expect(await runsOf(h.db, broken)).toHaveLength(0);
    expect(await dispatchesOf(h.db, broken, 'filter_error')).toHaveLength(2);
    const evs = await eventsOf(h.db, src.id);
    expect(evs.map((e) => e.stage).sort()).toEqual(['matched', 'unmatched']);
    const unmatched = evs.find((e) => e.stage === 'unmatched');
    expect(unmatched?.matchDecisions.some((d) => !d.result && d.error === undefined)).toBe(true);
  });

  it('$resolve reads live state through the event source', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    src.state.resolved.set('fake.pr:7', {
      ref: { kind: 'fake.pr', id: '7' },
      labels: ['complexity:simple'],
    });
    const pid = await seedProcess(h, ex.id, src.id, {
      triggers: [
        {
          id: 't1',
          sourceId: src.id,
          eventTypes: ['*'],
          filter: "'complexity:simple' in $resolve(artifact).labels",
          describe: '',
          enabled: true,
        },
      ],
    });
    await deliver(h, src.id, [
      { id: '7', version: 'a' },
      { id: '8', version: 'a' },
    ]);
    await h.drain();
    await h.advance(31);
    const runs = await runsOf(h.db, pid);
    expect(runs).toHaveLength(1);
    expect(src.state.resolveCalls.map((r) => r.id).sort()).toEqual(['7', '8']);
  });
});

describe('the door', () => {
  it('events for a disabled source are stored with source_disabled and return 200', async () => {
    const src = await seedSource(h, { enabled: false });
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    expect(await deliver(h, src.id, [{ id: '1', version: 'a' }])).toBe(200);
    await h.drain();
    await h.advance(31);
    const evs = await eventsOf(h.db, src.id);
    expect(evs.map((e) => e.stage)).toEqual(['source_disabled']);
    expect(await runsOf(h.db, pid)).toHaveLength(0);
  });

  it('a disabled source with no live instance still answers 200; an enabled one answers 503', async () => {
    const off = await seedSource(h, { enabled: false });
    const on = await seedSource(h);
    h.runtime.instanceErrors.set(off.id, 'secret_error: missing');
    h.runtime.instanceErrors.set(on.id, 'secret_error: missing');
    expect(await deliver(h, off.id, [{ id: '1', version: 'a' }])).toBe(200);
    expect(await deliver(h, on.id, [{ id: '1', version: 'a' }])).toBe(503);
    expect(await eventsOf(h.db, off.id)).toHaveLength(0);
  });

  it('invalid events are rejected, stored as event_invalid and counted against the plugin', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    const body = {
      deliveryId: 'bad',
      events: [
        {
          type: 'fake-hook.pr.labeled',
          id: '1',
          attributes: { label: 5 },
          occurredAt: h.clock.now().toISOString(),
        },
        {
          type: 'fake-hook.undeclared',
          id: '2',
          attributes: {},
          occurredAt: h.clock.now().toISOString(),
        },
        {
          type: 'fake-hook.pr.labeled',
          id: '3',
          attributes: { label: `leak ${SECRET}`, repository: 'x' },
          occurredAt: h.clock.now().toISOString(),
        },
      ],
    };
    const res = await h.pipeline.ingestPush(src.id, signedDelivery(SECRET, body, h.clock.now()));
    expect(res.status).toBe(200);
    await h.drain();
    await h.advance(31);
    const evs = await eventsOf(h.db, src.id);
    expect(evs.map((e) => e.stage)).toEqual(['event_invalid', 'event_invalid', 'event_invalid']);
    expect(evs[2]?.stageReason).toMatch(/secret/);
    expect(
      h.runtime.errors.filter((e) => e.kind === 'invalid_event' && e.plugin === HOOK_PLUGIN),
    ).toHaveLength(3);
    expect(await runsOf(h.db, pid)).toHaveLength(0);
    expect(
      h.telemetry.signals.filter(
        (s) => s.name === 'switchboard.events' && s.attributes.stage === 'event_invalid',
      ),
    ).toHaveLength(3);
  });

  it('rejects a bad signature with 401 and keeps no body; unknown sources are 404', async () => {
    const src = await seedSource(h);
    expect(await deliver(h, src.id, [{ id: '1' }], { secret: 'wrong-secret' })).toBe(401);
    expect(
      (
        await h.pipeline.ingestPush(
          '00000000-0000-4000-8000-000000000099',
          rawRequest({ body: '{}' }),
        )
      ).status,
    ).toBe(404);
    expect((await h.pipeline.ingestPush('not-a-uuid', rawRequest({ body: '{}' }))).status).toBe(
      404,
    );
    const raws = await h.db.select().from(eventRaw).where(eq(eventRaw.sourceId, src.id));
    expect(raws).toHaveLength(1);
    expect(raws[0]?.verify).toMatch(/^rejected/);
    expect(raws[0]?.body.length).toBe(0);
    const [row] = await h.db.select().from(sources).where(eq(sources.id, src.id));
    expect(row?.lastVerifyFailureAt).not.toBeNull();
    expect(await eventsOf(h.db, src.id)).toHaveLength(0);
  });

  it('applies muted types and the hourly event cap', async () => {
    const src = await seedSource(h, {
      caps: { eventCapPerHour: 2, eventTypesEnabled: ['fake-hook.pr.labeled'] },
    });
    await deliver(h, src.id, [
      { id: '1', version: 'a' },
      { id: '2', version: 'a', type: ISSUE_UPDATED, attributes: { state: 'open' } },
      { id: '3', version: 'a' },
      { id: '4', version: 'a' },
    ]);
    const stages = (await eventsOf(h.db, src.id)).map((e) => e.stage);
    expect(stages.sort()).toEqual(
      ['received', 'received', 'source_throttled', 'type_muted'].sort(),
    );
    h.clock.advanceMinutes(61);
    await deliver(h, src.id, [{ id: '5', version: 'a' }]);
    const after = await h.db.select().from(events).where(eq(events.artifactKey, 'fake.pr:5'));
    expect(after[0]?.stage).toBe('received');
  });

  it('answers 503 when Postgres is unavailable', async () => {
    const broken = connect('postgres://nobody:nothing@127.0.0.1:1/none', { max: 1 });
    const pipeline = createPipeline({
      ...h.deps,
      db: broken.db,
      heartbeatIntervalMs: 0,
      secrets: { resolve: () => Promise.resolve('') },
    });
    const src = await seedSource(h);
    const res = await pipeline.ingestPush(
      src.id,
      signedDelivery(SECRET, { events: [] }, h.clock.now()),
    );
    expect(res.status).toBe(503);
    await broken.close();
  });

  it('replays a stored body through the same parse; the replay dedupes onto the same run', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    await deliver(h, src.id, [{ id: '9', version: 'a' }]);
    await h.drain();
    await h.advance(31);
    const [original] = await eventsOf(h.db, src.id);
    const out = await h.pipeline.replay(original!.id, 'op@example.com', 'check the trace');
    expect(out.eventIds).toHaveLength(1);
    await h.drain();
    await h.advance(31);
    const [replayed] = await h.db.select().from(events).where(eq(events.id, out.eventIds[0]!));
    expect(replayed?.replayOf).toBe(original!.id);
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    expect(await dispatchesOf(h.db, pid, 'deduped')).toHaveLength(1);
  });

  it('injects a test event from the first example', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    const out = await h.pipeline.injectTestEvent(src.id, undefined, 'op@example.com', 'smoke test');
    expect(out.eventIds).toHaveLength(1);
    await h.drain();
    await h.advance(31);
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    const [ev] = await eventsOf(h.db, src.id);
    expect(ev?.attributes).toEqual({ label: 'auto:fix', repository: 'acme/api' });
    expect(h.runtime.errors.filter((e) => e.plugin === EXEC_PLUGIN)).toHaveLength(0);
  });
});
