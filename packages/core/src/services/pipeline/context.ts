import { sql } from 'drizzle-orm';

import type { ArtifactRef, Event } from '@ai-switchboard/sdk';

import type { Db, DbOrTx, Tx } from '../../db/client.js';
import type { events, processes } from '../../db/schema.js';
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

export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === '23505';
}

/** A connection-level failure (Postgres down), as opposed to a query error. */
export function isConnectionError(err: unknown): boolean {
  const code = pgCode(err);
  if (code === undefined) {
    const msg = err instanceof Error ? err.message : String(err);
    return /ECONNREFUSED|ENOTFOUND|terminat|Connection|timeout/i.test(msg);
  }
  return code.startsWith('08') || code === '57P01' || code === '57P03' || code.startsWith('ECONN');
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function addSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}
