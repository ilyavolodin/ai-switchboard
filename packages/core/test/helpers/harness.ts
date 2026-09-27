import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';

import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import {
  batches,
  dispatches,
  events,
  executors,
  processes,
  runs,
  sources,
  type ExecutorCaps,
  type SourceCaps,
} from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { defaultProcessDocument, type ProcessDocument } from '../../src/domain/process.js';
import { silentLogger } from '../../src/logger.js';
import { MemoryQueue } from '../../src/queue/queue.js';
import { putSettings, DEFAULT_SETTINGS } from '../../src/services/settings.js';
import { createPipeline, type Pipeline } from '../../src/services/pipeline/index.js';
import { createRecordingTelemetry } from '../../src/telemetry/telemetry.js';

import {
  EXEC_TYPE,
  FakeRuntime,
  HOOK_TYPE,
  PR_LABELED,
  signedDelivery,
  type FakeExecutorState,
  type FakeSourceState,
  type HookBody,
} from './fake-runtime.js';

export const SECRET = 'fixture-secret';

/** One "replica": its own queue and pipeline over the shared database, clock and runtime. */
export interface Replica {
  queue: MemoryQueue;
  pipeline: Pipeline;
  deps: Deps;
}

export interface Harness extends Replica {
  db: Db;
  clock: FakeClock;
  runtime: FakeRuntime;
  telemetry: ReturnType<typeof createRecordingTelemetry>;
  secrets: Map<string, string>;
  replica(): Promise<Replica>;
  /** Drain the queue, advancing nothing. */
  drain(): Promise<number>;
  /** Advance the clock by `seconds` and drain. */
  advance(seconds: number): Promise<void>;
}

export async function createHarness(db: Db, start = '2026-01-05T09:00:00Z'): Promise<Harness> {
  const clock = new FakeClock(start);
  const runtime = new FakeRuntime();
  const telemetry = createRecordingTelemetry();
  const secrets = new Map<string, string>();
  const make = async (): Promise<Replica> => {
    const queue = new MemoryQueue(clock);
    const deps: Deps = {
      db,
      clock,
      runtime,
      queue,
      logger: silentLogger(),
      telemetry,
      config: testConfig(),
    };
    const pipeline = createPipeline({
      ...deps,
      heartbeatIntervalMs: 0,
      env: { SWITCHBOARD_VAR_REGION: 'eu' },
      secrets: {
        resolve: (ref) => {
          const v = secrets.get(ref);
          return v === undefined
            ? Promise.reject(new Error(`no secret ${ref}`))
            : Promise.resolve(v);
        },
      },
    });
    await pipeline.registerWorkers();
    return { queue, pipeline, deps };
  };
  const main = await make();
  return {
    ...main,
    db,
    clock,
    runtime,
    telemetry,
    secrets,
    replica: make,
    drain: () => main.queue.drain(),
    advance: async (seconds) => {
      clock.advanceSeconds(seconds);
      await main.queue.drain();
    },
  };
}

/** Wipe every pipeline table between tests (the schema stays). */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(
    sql.raw(`TRUNCATE sources, executors, processes, events, event_raw, dispatches,
      batches, runs, run_updates, steps, approvals, meter_readings, stats_hourly, schedule_ticks,
      notification_log, system_alerts, audit_log, settings, replicas, notifiers RESTART IDENTITY`),
  );
}

/** What the seed helpers need: a database, the clock and the fake runtime. */
export type SeedTarget = Pick<Harness, 'db' | 'clock' | 'runtime'>;

export async function seedSource(
  h: SeedTarget,
  options: { enabled?: boolean; caps?: SourceCaps; name?: string } = {},
): Promise<{ id: string; state: FakeSourceState }> {
  const id = randomUUID();
  const name = options.name ?? 'Hook';
  await h.db.insert(sources).values({
    id,
    typeId: HOOK_TYPE,
    name,
    enabled: options.enabled ?? true,
    caps: options.caps ?? {},
    createdAt: h.clock.now(),
  });
  const state = h.runtime.addSource(id, name, SECRET);
  return { id, state };
}

export async function seedExecutor(
  h: SeedTarget,
  options: {
    tracking?: FakeExecutorState['tracking'];
    idempotent?: boolean;
    caps?: ExecutorCaps;
    enabled?: boolean;
  } = {},
): Promise<{ id: string; state: FakeExecutorState }> {
  const id = randomUUID();
  await h.db.insert(executors).values({
    id,
    typeId: EXEC_TYPE,
    name: 'Exec',
    enabled: options.enabled ?? true,
    caps: options.caps ?? {},
  });
  const state = h.runtime.addExecutor(id, 'Exec', {
    ...(options.tracking ? { tracking: options.tracking } : {}),
    ...(options.idempotent !== undefined ? { idempotent: options.idempotent } : {}),
  });
  return { id, state };
}

export type DocPatch = Partial<Omit<ProcessDocument, 'batching' | 'gates' | 'budgets'>> & {
  batching?: Partial<ProcessDocument['batching']>;
  gates?: Partial<ProcessDocument['gates']>;
  budgets?: Partial<ProcessDocument['budgets']>;
};

export const DEFAULT_INPUT = '{ "runId": run.id, "mode": mode, "artifacts": [events.artifact.id] }';

export async function seedProcess(
  h: SeedTarget,
  executorId: string,
  sourceId: string | null,
  patch: DocPatch = {},
  enabled = true,
): Promise<string> {
  const base = defaultProcessDocument('Autofix', executorId);
  const { batching, gates, budgets, ...rest } = patch;
  const doc: ProcessDocument = {
    ...base,
    enabled,
    input: DEFAULT_INPUT,
    triggers:
      sourceId === null
        ? []
        : [{ id: 't1', sourceId, eventTypes: [PR_LABELED], describe: 'PR labeled', enabled: true }],
    ...rest,
    batching: {
      ...base.batching,
      debounceSeconds: 30,
      maxSize: 20,
      maxAgeSeconds: 600,
      ...batching,
    },
    gates: { ...base.gates, ...gates },
    budgets: { ...budgets, meterCeilings: budgets?.meterCeilings ?? {} },
  };
  const [row] = await h.db
    .insert(processes)
    .values({
      name: doc.name,
      document: doc,
      enabled,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    })
    .returning({ id: processes.id });
  if (!row) throw new Error('no process row');
  return row.id;
}

let delivery = 0;

/** POST a signed delivery with one PR-labeled event per artifact id. */
export async function deliver(
  h: { pipeline: Pipeline; clock?: FakeClock },
  sourceId: string,
  items: {
    id: string;
    version?: string;
    repository?: string;
    label?: string;
    type?: string;
    attributes?: Record<string, unknown>;
  }[],
  options: { deliveryId?: string; secret?: string; clock?: FakeClock } = {},
): Promise<number> {
  const clock = h.clock ?? options.clock;
  if (!clock) throw new Error('clock required');
  const body: HookBody = {
    deliveryId: options.deliveryId ?? `auto-${++delivery}`,
    events: items.map((i) => ({
      type: i.type ?? PR_LABELED,
      id: i.id,
      ...(i.version !== undefined ? { version: i.version } : {}),
      attributes: i.attributes ?? {
        label: i.label ?? 'auto:fix',
        repository: i.repository ?? 'acme/api',
      },
      occurredAt: clock.now().toISOString(),
    })),
  };
  const res = await h.pipeline.ingestPush(
    sourceId,
    signedDelivery(options.secret ?? SECRET, body, clock.now()),
  );
  return res.status;
}

export async function runsOf(db: Db, processId: string) {
  return db.select().from(runs).where(eq(runs.processId, processId)).orderBy(asc(runs.createdAt));
}

export async function batchesOf(db: Db, processId: string) {
  return db
    .select()
    .from(batches)
    .where(eq(batches.processId, processId))
    .orderBy(asc(batches.openedAt));
}

export async function eventsOf(db: Db, sourceId: string) {
  return db
    .select()
    .from(events)
    .where(eq(events.sourceId, sourceId))
    .orderBy(asc(events.receivedAt));
}

export async function dispatchesOf(
  db: Db,
  processId: string,
  outcome?: 'batched' | 'deduped' | 'filter_error',
) {
  return db
    .select()
    .from(dispatches)
    .where(
      outcome
        ? and(eq(dispatches.processId, processId), eq(dispatches.outcome, outcome))
        : eq(dispatches.processId, processId),
    );
}

export async function setSystemNotifier(db: Db, notifierId: string, now: Date): Promise<void> {
  await putSettings(db, { ...DEFAULT_SETTINGS, systemNotifierId: notifierId }, now);
}
