import { and, count, eq, gte, inArray, isNotNull, ne, sql, type AnyColumn } from 'drizzle-orm';

import type {
  FunnelResponse,
  MeterHistoryResponse,
  ProcessStatsResponse,
  SourceStatsResponse,
  StatsWindow,
  UsageHistoryResponse,
} from '../../contract/index.js';
import {
  batches,
  destinations,
  dispatches,
  eventRaw,
  events,
  meterReadings,
  processes,
  runs,
} from '../../db/schema.js';
import { HELD_BATCH_OUTCOMES } from '../../domain/status.js';
import { destinationSpecs } from '../../services/destination-specs.js';
import { msAgo } from '../../util/time.js';
import { isUuid } from '../../util/uuid.js';
import { notFound } from '../errors.js';
import type { ReadDeps } from './deps.js';
import { meterGauges } from './meters.js';
import { namesById } from './names.js';
import {
  dailyWindow,
  shapeFunnel,
  shapeMeterHistory,
  shapeProcessStats,
  shapeSourceStats,
  shapeUsageHistory,
  timeBuckets,
  windowMs,
} from './stats.shape.js';

/** The UTC hour a timestamp falls in, formatted like `timeBuckets(…, 'hour')`. */
export const hourOf = (col: AnyColumn) =>
  sql<string>`to_char(date_trunc('hour', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`;

/** The UTC day a timestamp falls in, formatted like `timeBuckets(…, 'day')`. */
export const dayOf = (col: AnyColumn) =>
  sql<string>`to_char(date_trunc('day', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"00:00:00"Z"')`;

async function destinationOr404(deps: ReadDeps, id: string) {
  const [row] = isUuid(id)
    ? await deps.db.select().from(destinations).where(eq(destinations.id, id))
    : [];
  if (!row) throw notFound('Destination');
  return row;
}

export async function sourceStats(
  deps: ReadDeps,
  sourceId: string,
  window: StatsWindow = '24h',
): Promise<SourceStatsResponse> {
  const now = deps.clock.now();
  const from = msAgo(now, windowMs(window));
  const [rows, failures] = await Promise.all([
    deps.db
      .select({
        hour: hourOf(events.receivedAt),
        type: events.type,
        stage: events.stage,
        n: count(),
      })
      .from(events)
      .where(and(eq(events.sourceId, sourceId), gte(events.receivedAt, from)))
      .groupBy(sql`1`, events.type, events.stage),
    deps.db
      .select({ hour: hourOf(eventRaw.receivedAt), n: count() })
      .from(eventRaw)
      .where(
        and(
          eq(eventRaw.sourceId, sourceId),
          gte(eventRaw.receivedAt, from),
          ne(eventRaw.verify, 'ok'),
        ),
      )
      .groupBy(sql`1`),
  ]);
  return shapeSourceStats(window, timeBuckets(from, now, 'hour'), rows, failures);
}

export async function meterHistory(
  deps: ReadDeps,
  destinationId: string,
  window: StatsWindow = '7d',
): Promise<MeterHistoryResponse> {
  const ex = await destinationOr404(deps, destinationId);
  const from = msAgo(deps.clock.now(), windowMs(window));
  const [readings, runRows, gauges] = await Promise.all([
    deps.db
      .select()
      .from(meterReadings)
      .where(and(eq(meterReadings.destinationId, ex.id), gte(meterReadings.observedAt, from)))
      .orderBy(meterReadings.observedAt),
    deps.db
      .select({ id: runs.id, t: runs.invokedAt, processId: runs.processId, status: runs.status })
      .from(runs)
      .where(
        and(eq(runs.destinationId, ex.id), gte(runs.createdAt, from), isNotNull(runs.invokedAt)),
      )
      .orderBy(runs.invokedAt)
      .limit(2000),
    meterGauges(deps, [ex.id]),
  ]);
  const names = await namesById(
    deps.db,
    'process',
    runRows.map((r) => r.processId),
  );
  return shapeMeterHistory(
    window,
    destinationSpecs(deps.runtime, ex).meters,
    readings,
    runRows.map((r) => ({ ...r, processName: names.of(r.processId) })),
    gauges,
  );
}

export async function usageHistory(
  deps: ReadDeps,
  destinationId: string,
  window: StatsWindow = '7d',
): Promise<UsageHistoryResponse> {
  const ex = await destinationOr404(deps, destinationId);
  const effective = dailyWindow(window);
  const now = deps.clock.now();
  const from = msAgo(now, windowMs(effective));
  const rows = await deps.db
    .select({ day: dayOf(runs.createdAt), status: runs.status, usage: runs.usage })
    .from(runs)
    .where(and(eq(runs.destinationId, ex.id), gte(runs.createdAt, from)));
  return shapeUsageHistory(
    effective,
    timeBuckets(from, now, 'day'),
    destinationSpecs(deps.runtime, ex).usage,
    rows,
  );
}

export async function processFunnel(
  deps: ReadDeps,
  processId: string,
  window: StatsWindow = '24h',
): Promise<FunnelResponse> {
  const from = msAgo(deps.clock.now(), windowMs(window));
  const [d, b, r, received] = await Promise.all([
    deps.db
      .select({ outcome: dispatches.outcome, n: count() })
      .from(dispatches)
      .where(and(eq(dispatches.processId, processId), gte(dispatches.createdAt, from)))
      .groupBy(dispatches.outcome),
    deps.db
      .select({ kind: batches.kind, outcome: batches.outcome, n: count() })
      .from(batches)
      .where(and(eq(batches.processId, processId), gte(batches.openedAt, from)))
      .groupBy(batches.kind, batches.outcome),
    deps.db
      .select({ kind: runs.kind, status: runs.status, n: count() })
      .from(runs)
      .where(and(eq(runs.processId, processId), gte(runs.createdAt, from)))
      .groupBy(runs.kind, runs.status),
    deps.db.execute<{ n: string }>(sql`
      select count(*)::text as n from ${events} e
      where e.received_at >= ${from}
        and e.source_id::text in (
          select t->>'sourceId' from ${processes} p, jsonb_array_elements(p.document->'triggers') t where p.id = ${processId}
        )`),
  ]);
  return shapeFunnel(window, Number(received.rows[0]?.n ?? 0), d, b, r);
}

export async function processStats(
  deps: ReadDeps,
  processId: string,
  window: StatsWindow = '7d',
): Promise<ProcessStatsResponse> {
  const [proc] = await deps.db.select().from(processes).where(eq(processes.id, processId));
  if (!proc) throw notFound('Process');
  const effective = dailyWindow(window);
  const now = deps.clock.now();
  const from = msAgo(now, windowMs(effective));
  const boundId = proc.document.destination.instanceId;
  const [runRows, batchRows, [bound]] = await Promise.all([
    deps.db
      .select({
        day: dayOf(runs.createdAt),
        status: runs.status,
        invokedAt: runs.invokedAt,
        finishedAt: runs.finishedAt,
        firstEventAt: runs.firstEventAt,
        usage: runs.usage,
      })
      .from(runs)
      .where(and(eq(runs.processId, processId), gte(runs.createdAt, from), eq(runs.dryRun, false))),
    deps.db
      .select({ day: dayOf(batches.openedAt), outcome: batches.outcome, n: count() })
      .from(batches)
      .where(
        and(
          eq(batches.processId, processId),
          gte(batches.openedAt, from),
          inArray(batches.outcome, [...HELD_BATCH_OUTCOMES, 'throttled']),
        ),
      )
      .groupBy(sql`1`, batches.outcome),
    isUuid(boundId)
      ? deps.db
          .select({
            id: destinations.id,
            typeId: destinations.typeId,
            settings: destinations.settings,
          })
          .from(destinations)
          .where(eq(destinations.id, boundId))
      : Promise.resolve([]),
  ]);
  return shapeProcessStats(
    effective,
    timeBuckets(from, now, 'day'),
    runRows,
    batchRows,
    bound ? destinationSpecs(deps.runtime, bound).usage : [],
  );
}
