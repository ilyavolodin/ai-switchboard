import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { events, eventRaw, replicas, sources, statsHourly } from '../../src/db/schema.js';
import { defaultProcessDocument } from '../../src/domain/process.js';
import { createExpressionEngine } from '../../src/expr/index.js';
import { pollSource } from '../../src/services/pipeline/ingest.js';
import { DEFAULT_SETTINGS, putSettings } from '../../src/services/settings.js';
import { createPipeline, materialiseStats, prune } from '../../src/services/pipeline/index.js';
import { cronPreview, filterPreview, inputPreview } from '../../src/services/preview.js';
import { traceForArtifact, traceForEvent } from '../../src/services/trace.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { PR_LABELED, callbackRequest } from '../helpers/fake-runtime.js';
import {
  batchesOf,
  createHarness,
  deliver,
  resetDb,
  runsOf,
  seedExecutor,
  seedProcess,
  seedSource,
  setSystemNotifier,
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

describe('trace', () => {
  it('the trace for an artifact contains every stage in time order', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h, { tracking: 'callback' });
    h.runtime.addNotifier('n1', 'Slack');
    const pid = await seedProcess(h, ex.id, src.id, {
      triggers: [
        {
          id: 't1',
          sourceId: src.id,
          eventTypes: [PR_LABELED],
          filter: "attributes.label = 'auto:fix'",
          describe: '',
          enabled: true,
        },
      ],
      gates: { approval: 'always' },
      after: [{ provider: src.id, action: 'comment', args: '{ "text": "done" }' }],
      notify: [{ notifierId: 'n1', template: "'done'", on: ['ok'] }],
    });
    await deliver(h, src.id, [{ id: 'acme/api#482', version: 'v1' }]);
    await deliver(h, src.id, [{ id: 'acme/api#482', version: 'v1' }]);
    await h.drain();
    await h.advance(31);
    const [batch] = await batchesOf(h.db, pid);
    await h.pipeline.approve(batch!.id, 'op@example.com', 'ship it');
    const [run] = await runsOf(h.db, pid);
    h.clock.advanceMinutes(3);
    await h.pipeline.handleCallback(
      ex.id,
      callbackRequest('callback-token', { runId: run!.id, state: 'ok', usage: { tokens: 10 } }),
    );
    await h.drain();

    for (const q of ['#482', 'acme/api#482', 'fake.pr:acme/api#482', '482']) {
      const trace = await traceForArtifact(h.deps, q);
      const kinds = new Set(trace.entries.map((e) => e.kind));
      for (const k of [
        'event',
        'filter',
        'dedupe',
        'batch_open',
        'batch_close',
        'gate',
        'approval',
        'budget',
        'invoke',
        'tracking',
        'terminal',
        'step',
        'notification',
      ]) {
        expect(kinds, `${q}: ${k}`).toContain(k);
      }
      expect(trace.artifacts).toEqual([{ kind: 'fake.pr', id: 'acme/api#482', version: 'v1' }]);
      const times = trace.entries.map((e) => Date.parse(e.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(trace.text).toContain("filter: attributes.label = 'auto:fix'");
      expect(trace.entries.find((e) => e.kind === 'invoke')?.externalUrl).toBe(
        `https://backend.test/runs/${run!.id}`,
      );
      expect(trace.entries.find((e) => e.kind === 'budget')?.data).toHaveProperty('counters');
    }
    const [ev] = await h.db.select().from(events).limit(1);
    const one = await traceForEvent(h.deps, ev!.id);
    expect(one.entries.some((e) => e.kind === 'terminal')).toBe(true);
    expect((await traceForArtifact(h.deps, 'nothing-here')).entries).toEqual([]);
  });
});

describe('previews', () => {
  it('evaluates a filter against the last real events and an input mapping against a batch', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id);
    await deliver(h, src.id, [
      { id: '1', version: 'a' },
      { id: '2', version: 'a', label: 'other' },
    ]);
    await h.drain();
    await h.advance(31);
    const filter = await filterPreview(h.deps, {
      sourceId: src.id,
      eventTypes: [PR_LABELED],
      filter: "attributes.label = 'auto:fix'",
    });
    expect(filter.rows.map((r) => [r.artifact.id, r.result]).sort()).toEqual([
      ['1', true],
      ['2', false],
    ]);
    const broken = await filterPreview(h.deps, {
      sourceId: src.id,
      eventTypes: [PR_LABELED],
      filter: 'x =',
    });
    expect(broken.rows.every((r) => !r.result && r.error !== undefined)).toBe(true);

    const [batch] = await batchesOf(h.db, pid);
    const doc = {
      ...defaultProcessDocument('p', ex.id),
      input: '{ "runId": run.id, "mode": mode, "artifacts": [events.artifact.id] }',
    };
    const good = await inputPreview(h.deps, { document: doc, batchId: batch!.id });
    expect(good).toMatchObject({ valid: true, input: { mode: 'event', artifacts: ['1', '2'] } });
    const bad = await inputPreview(h.deps, { document: { ...doc, input: '{ "mode": 3 }' } });
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);

    const cron = cronPreview({ cron: '0 7 * * *', timezone: 'UTC' }, h.clock);
    expect(cron.next[0]).toBe('2026-01-06T07:00:00.000Z');
  });
});

describe('stats, retention and maintenance', () => {
  it('materialises hourly statistics', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    ex.state.usageOnComplete = { tokens: 100 };
    const pid = await seedProcess(h, ex.id, src.id);
    await deliver(h, src.id, [
      { id: '1', version: 'a' },
      { id: '2', version: 'a' },
    ]);
    await h.drain();
    await h.advance(31);
    ex.state.readings = [
      { id: 'five_hour', utilization: 42, observedAt: h.clock.now().toISOString() },
    ];
    await h.pipeline.readMetersNow(ex.id);
    const written = await materialiseStats(h.deps, new Date('2026-01-05T08:00:00Z'), h.clock.now());
    expect(written).toBeGreaterThan(0);
    const rows = await h.db.select().from(statsHourly);
    const proc = rows.find((r) => r.dimension === 'process' && r.key === pid);
    expect(proc?.counters).toMatchObject({
      'dispatch:batched': 2,
      'runs:ok': 1,
      'budget:runs': 1,
      'usage:tokens': 100,
    });
    expect(proc?.counters.latency_p50).toBeCloseTo(31, 0);
    const source = rows.find((r) => r.dimension === 'source' && r.key === src.id);
    expect(source?.counters).toMatchObject({ total: 2, 'stage:matched': 2 });
    const meter = rows.find((r) => r.dimension === 'meter' && r.key === `${ex.id}|five_hour`);
    expect(meter?.counters).toMatchObject({ utilization_max: 42 });
    // Idempotent: a second pass writes the same rows.
    await materialiseStats(h.deps, new Date('2026-01-05T08:00:00Z'), h.clock.now());
    expect(await h.db.select().from(statsHourly)).toHaveLength(rows.length);
  });

  it('prunes per the retention settings', async () => {
    const src = await seedSource(h);
    await deliver(h, src.id, [{ id: '1', version: 'a' }]);
    await h.drain();
    h.clock.advance(91 * 86_400_000);
    await deliver(h, src.id, [{ id: '2', version: 'a' }]);
    const counts = await prune(h.deps);
    expect(counts.events).toBe(1);
    expect(counts.event_raw).toBe(1);
    expect(await h.db.select().from(events)).toHaveLength(1);
    expect(await h.db.select().from(eventRaw)).toHaveLength(1);
  });

  it('a short dispatch retention never shortens the 7-day dedupe window', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, { batching: { debounceSeconds: 0 } });
    await putSettings(
      h.db,
      { ...DEFAULT_SETTINGS, retention: { ...DEFAULT_SETTINGS.retention, dispatchesDays: 1 } },
      h.clock.now(),
    );
    await deliver(h, src.id, [{ id: '1', version: 'a' }]);
    await h.drain();
    expect(await runsOf(h.db, pid)).toHaveLength(1);
    h.clock.advance(3 * 86_400_000);
    await prune(h.deps);
    // The sender redelivers the same change three days later.
    await deliver(h, src.id, [{ id: '1', version: 'a' }]);
    await h.drain();
    expect(await runsOf(h.db, pid)).toHaveLength(1);
  });

  it('recovers an event whose match job was lost, polls pull sources and alerts on silence', async () => {
    const src = await seedSource(h);
    const ex = await seedExecutor(h);
    const pid = await seedProcess(h, ex.id, src.id, { batching: { debounceSeconds: 0 } });
    await deliver(h, src.id, [{ id: '1', version: 'a' }]);
    h.queue.jobs.length = 0; // the match job is lost
    h.clock.advanceSeconds(61);
    await h.pipeline.maintenance();
    await h.drain();
    expect(await runsOf(h.db, pid)).toHaveLength(1);

    // A pull source is polled on its interval and its watermark advances.
    const pull = await seedSource(h, { caps: { pollIntervalSeconds: 60 } });
    const live = h.runtime.sources.get(pull.id)!;
    live.type = { ...live.type, mode: 'pull' };
    let calls = 0;
    live.source.poll = (watermark) => {
      calls++;
      return Promise.resolve({
        events: [
          {
            type: PR_LABELED,
            occurredAt: h.clock.now().toISOString(),
            artifact: { kind: 'fake.pr', id: `p${calls}` },
            attributes: { label: 'x', repository: 'r' },
            dedupeKey: `k${calls}`,
          },
        ],
        watermark: `${watermark ?? ''}w${calls}`,
      });
    };
    await h.pipeline.maintenance();
    await h.drain();
    await h.pipeline.maintenance();
    await h.drain();
    expect(calls).toBe(1);
    h.clock.advanceSeconds(61);
    await h.pipeline.maintenance();
    await h.drain();
    expect(calls).toBe(2);
    const [row] = await h.db.select().from(sources).where(eq(sources.id, pull.id));
    expect(row?.watermark).toBe('w1w2');
    expect(await h.db.select().from(events).where(eq(events.sourceId, pull.id))).toHaveLength(2);

    // Silence: no events for longer than sourceSilenceMinutes (default 1440).
    const notifier = h.runtime.addNotifier('sys', 'System');
    await setSystemNotifier(h.db, 'sys', h.clock.now());
    h.clock.advanceMinutes(1441);
    await h.pipeline.maintenance();
    await h.pipeline.maintenance();
    expect(notifier.messages.filter((m) => m.title.startsWith('Source silent'))).toHaveLength(2);
  });

  it('two overlapping polls of one source never emit the same page twice', async () => {
    const pull = await seedSource(h, { caps: { pollIntervalSeconds: 10 } });
    const live = h.runtime.sources.get(pull.id)!;
    live.type = { ...live.type, mode: 'pull' };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    live.source.poll = async (watermark) => {
      await gate;
      return {
        events: [
          {
            type: PR_LABELED,
            occurredAt: h.clock.now().toISOString(),
            artifact: { kind: 'fake.pr', id: `after-${watermark ?? 'start'}` },
            attributes: { label: 'x', repository: 'r' },
            dedupeKey: `after-${watermark ?? 'start'}`,
          },
        ],
        watermark: `${watermark ?? ''}+`,
      };
    };
    const ctx = {
      ...h.deps,
      secrets: { resolve: () => Promise.resolve('') },
      engine: createExpressionEngine(),
      log: h.deps.logger,
    };
    // A slow poll outlives its interval and the next claim starts a second one.
    const first = pollSource(ctx, pull.id);
    const second = pollSource(ctx, pull.id);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    const stored = await h.db.select().from(events).where(eq(events.sourceId, pull.id));
    expect(stored).toHaveLength(1);
    const [row] = await h.db.select().from(sources).where(eq(sources.id, pull.id));
    expect(row?.watermark).toBe('+');
  });

  it('heartbeats into the replicas table', async () => {
    const p = createPipeline({
      ...h.deps,
      heartbeatIntervalMs: 1000,
      secrets: { resolve: () => Promise.resolve('') },
    });
    await p.registerWorkers();
    await new Promise((r) => setTimeout(r, 50));
    await p.stop();
    const rows = await h.db
      .select()
      .from(replicas)
      .where(and(eq(replicas.id, 'test-replica')));
    expect(rows).toHaveLength(1);
  });
});
