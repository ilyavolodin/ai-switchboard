import { sql, type SQL } from 'drizzle-orm';

import type { ArtifactRef, Event } from '@ai-switchboard/sdk';

import type { Db, DbOrTx, Tx } from '../../db/client.js';
import { batches, type GateDecisionRecord, type events, type processes } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import type { EvalFunctions, ExpressionEngine } from '../../expr/index.js';
import type { CoreLogger } from '../../logger.js';

/** Resolves a full `secret://<provider>/<name>` reference to its value. Supplied by the server. */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export interface PipelineDeps extends Deps {
  secrets: SecretResolver;
  /** Heartbeat period; 0 disables the timer (tests). Default 30 000. */
  heartbeatIntervalMs?: number;
  /** Non-secret deployment values for `$env`; defaults to `process.env` (filtered by prefix). */
  env?: Record<string, string | undefined>;
  /** Time limit for a plugin call the pipeline waits on; default `PLUGIN_CALL_TIMEOUT_MS`. */
  pluginCallTimeoutMs?: number;
}

/** What every pipeline service function receives. */
export interface Ctx extends PipelineDeps {
  engine: ExpressionEngine;
  log: CoreLogger;
}

/** Queue job names. Jobs carry ids only. */
export const JOBS = {
  match: 'pipeline.match',
  fire: 'pipeline.fire',
  dispatch: 'pipeline.dispatch',
  invoke: 'pipeline.invoke',
  poll: 'pipeline.poll',
  deadline: 'pipeline.deadline',
  finish: 'pipeline.finish',
  sourcePoll: 'source.poll',
  metersRead: 'meters.read',
  schedulerTick: 'scheduler.tick',
  maintenance: 'pipeline.maintenance',
  stats: 'stats.materialise',
  statsDeep: 'stats.materialise.deep',
  prune: 'retention.prune',
} as const;

/**
 * Jobs whose handlers run in a span even with no trace to continue (a sweep's dispatch, a poll).
 * The periodic housekeeping jobs (tick, maintenance, stats, prune) do not start traces.
 */
export const TRACED_JOBS: ReadonlySet<string> = new Set([
  JOBS.match,
  JOBS.fire,
  JOBS.dispatch,
  JOBS.invoke,
  JOBS.poll,
  JOBS.deadline,
  JOBS.finish,
  JOBS.sourcePoll,
  JOBS.metersRead,
]);

const RETRYABLE_PG_CODES = new Set(['23505', '40001', '40P01']);

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 3 && e !== null && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Run `fn` in a transaction, retrying on unique violations, serialization failures and
 * deadlocks (a racing replica won; the retry re-reads and usually no-ops).
 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await db.transaction(fn);
    } catch (err) {
      const code = pgCode(err);
      if (i >= attempts || code === undefined || !RETRYABLE_PG_CODES.has(code)) throw err;
    }
  }
}

/** A transaction-scoped advisory lock on an arbitrary key. */
export async function lockKey(tx: DbOrTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** `batches.decisions || records`: append decision records to a batch in an update. */
export function appendDecisions(records: readonly GateDecisionRecord[]): SQL {
  return sql`${batches.decisions} || ${JSON.stringify(records)}::jsonb`;
}

export type EventRow = typeof events.$inferSelect;
export type ProcessRow = typeof processes.$inferSelect;

export function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    artifact: row.artifact,
    attributes: row.attributes,
    dedupeKey: row.dedupeKey,
    ...(row.deliveryId !== null ? { deliveryId: row.deliveryId } : {}),
    rawRef: row.rawRef,
    ...(row.replayOf !== null ? { replayOf: row.replayOf } : {}),
  };
}

/** The `process` value expressions see. */
export function processView(row: ProcessRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.document.description,
    enabled: row.enabled,
    version: row.version,
  };
}

function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * `$resolve` / `$linked` for an evaluation over `events`: a reference is resolved through the
 * source of the event it belongs to, else through the first event's source, else through the
 * first of `fallbackSources` that can resolve.
 */
export function evalFunctions(
  ctx: Pick<Deps, 'runtime'>,
  events: readonly Event[],
  now: Date,
  fallbackSources: readonly string[] = [],
): EvalFunctions {
  const sourceFor = (ref: ArtifactRef, method: 'resolve' | 'linked') => {
    const candidates = [
      ...events.filter((e) => sameArtifact(e.artifact, ref)).map((e) => e.sourceId),
      ...events.map((e) => e.sourceId),
      ...fallbackSources,
    ];
    for (const id of candidates) {
      const live = ctx.runtime.source(id);
      if (live?.source[method]) return live;
    }
    return undefined;
  };
  return {
    now,
    resolve: async (ref) => {
      const live = sourceFor(ref, 'resolve');
      if (!live?.source.resolve) throw new Error(`no source can resolve ${ref.kind}:${ref.id}`);
      return live.source.resolve(ref);
    },
    linked: async (ref) => {
      const live = sourceFor(ref, 'linked');
      if (!live?.source.linked) throw new Error(`no source can link ${ref.kind}:${ref.id}`);
      return live.source.linked(ref);
    },
  };
}

/**
 * Default time limit for a plugin call (poll, readMeters, a notifier send, an action). An invoke
 * has its own, per-destination limit (`effectiveInvokeTimeoutSeconds`); an attempt's recovery
 * deadline budgets this limit for each `before` step.
 */
export const PLUGIN_CALL_TIMEOUT_MS = 45_000;

/** Evaluation slack budgeted per `before` step on top of its action's time limit (`when`, args). */
export const STEP_EVAL_BUDGET_SECONDS = 10;

/** The time the `before` steps of one attempt may take, in seconds, for the recovery deadline. */
export function beforeStepBudgetSeconds(
  ctx: Pick<Ctx, 'pluginCallTimeoutMs'>,
  stepCount: number,
): number {
  const perStep = (ctx.pluginCallTimeoutMs ?? PLUGIN_CALL_TIMEOUT_MS) / 1000;
  return stepCount * (perStep + STEP_EVAL_BUDGET_SECONDS);
}

/**
 * Await `call` for at most `ms`. A sync throw or a rejection propagates; a call that has not
 * settled in time yields `{ timedOut: true }` (the call itself keeps running and is ignored).
 */
export async function withTimeout<T>(
  ms: number,
  call: () => Promise<T> | T,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref();
  });
  try {
    // `then(call)`: a plugin that returns a plain value or throws synchronously is handled too.
    const settled = Promise.resolve()
      .then(call)
      .then((value) => ({ value }));
    // A late rejection after a timeout must not become an unhandled rejection.
    settled.catch(() => undefined);
    const out = await Promise.race([settled, timeout]);
    return out === 'timeout' ? { timedOut: true } : { timedOut: false, value: out.value };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Await a plugin call with a time limit, so a plugin that never settles cannot hold a worker.
 * A timeout is counted against the plugin here; a throw was already counted by the runtime's
 * attribution wrapper. Either way the failure comes back as a value, never a rejection.
 */
export async function callPlugin<T>(
  ctx: Pick<Ctx, 'runtime' | 'pluginCallTimeoutMs'>,
  pluginName: string,
  method: string,
  call: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const ms = ctx.pluginCallTimeoutMs ?? PLUGIN_CALL_TIMEOUT_MS;
  try {
    const out = await withTimeout(ms, call);
    if (!out.timedOut) return { ok: true, value: out.value };
    const error = `${method}: timed out after ${ms} ms`;
    ctx.runtime.recordPluginError(pluginName, 'exception', error);
    return { ok: false, error };
  } catch (err) {
    return { ok: false, error: `${method}: ${errorMessage(err)}` };
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function addSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}
