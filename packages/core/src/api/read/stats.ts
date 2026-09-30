import { and, count, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { isOneOf } from '@ai-switchboard/sdk';

import {
  batches,
  dispatches,
  eventRaw,
  events,
  destinations,
  meterReadings,
  processes,
  runs,
} from '../../db/schema.js';
import { runStatusLabel } from '../../domain/labels.js';
import {
  BATCH_OUTCOMES,
  HELD_BATCH_OUTCOMES,
  RUN_STATUSES,
  STATS_WINDOWS,
  STOPPED_BATCH_OUTCOMES,
  type EventStage,
  type RunStatusValue,
} from '../../domain/status.js';
import { destinationSpecs } from '../../services/destination-specs.js';
import { isUuid } from '../../util/uuid.js';
import type { ApiContext } from '../context.js';
import type {
  FunnelResponse,
  MeterHistoryResponse,
  ProcessStatsResponse,
  SourceStatsResponse,
  StatsWindow,
  UsageHistoryResponse,
} from '../../contract/index.js';
import { notFound } from '../errors.js';
import { meterGauges } from './meters.js';

export function windowMs(window: StatsWindow | undefined): number {
  if (window === '7d') return 7 * 86_400_000;
  if (window === '30d') return 30 * 86_400_000;
  return 86_400_000;
}

export function parseWindow(value: unknown, fallback: StatsWindow = '24h'): StatsWindow {
  return isOneOf(STATS_WINDOWS, value) ? value : fallback;
}

const hourExpr = (col: unknown) =>
  sql<string>`to_char(date_trunc('hour', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`;
const dayExpr = (col: unknown) =>
  sql<string>`to_char(date_trunc('day', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"00:00:00"Z"')`;

function hoursBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const start = new Date(from);
  start.setUTCMinutes(0, 0, 0);
  for (let t = start.getTime(); t <= to.getTime(); t += 3_600_000)
    out.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  return out;
}

function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  for (let t = start.getTime(); t <= to.getTime(); t += 86_400_000)
    out.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  return out;
}

export async function sourceStats(
  ctx: ApiContext,
  sourceId: string,
  window: StatsWindow,
): Promise<SourceStatsResponse> {
  const now = ctx.clock.now();
  const from = new Date(now.getTime() - windowMs(window));
  const rows = await ctx.db
    .select({
      hour: hourExpr(events.receivedAt),
      type: events.type,
      stage: events.stage,
      n: count(),
    })
    .from(events)
    .where(and(eq(events.sourceId, sourceId), gte(events.receivedAt, from)))
    .groupBy(sql`1`, events.type, events.stage);
  const failures = await ctx.db
    .select({ hour: hourExpr(eventRaw.receivedAt), n: count() })
    .from(eventRaw)
    .where(
      and(
        eq(eventRaw.sourceId, sourceId),
        gte(eventRaw.receivedAt, from),
        ne(eventRaw.verify, 'ok'),
      ),
    )
    .groupBy(sql`1`);
  const hours = hoursBetween(from, now);
  return {
    window,
    buckets: hours.map((hour) => {
      const byType: Record<string, number> = {};
      const byStage: Partial<Record<EventStage, number>> = {};
      for (const r of rows.filter((x) => x.hour === hour)) {
        byType[r.type] = (byType[r.type] ?? 0) + r.n;
        byStage[r.stage] = (byStage[r.stage] ?? 0) + r.n;
      }
      return { hour, byType, byStage };
    }),
    verifyFailures: hours.map((hour) => ({
      hour,
      count: failures.find((f) => f.hour === hour)?.n ?? 0,
    })),
  };
}

export async function meterHistory(
  ctx: ApiContext,
  destinationId: string,
  window: StatsWindow,
): Promise<MeterHistoryResponse> {
  const [ex] = await ctx.db.select().from(destinations).where(eq(destinations.id, destinationId));
  if (!ex) throw notFound('Destination');
  const now = ctx.clock.now();
  const from = new Date(now.getTime() - windowMs(window));
  const specs = destinationSpecs(ctx.runtime, ex).meters;
  const [readings, runRows, gauges] = await Promise.all([
    ctx.db
      .select()
      .from(meterReadings)
      .where(and(eq(meterReadings.destinationId, ex.id), gte(meterReadings.observedAt, from)))
      .orderBy(meterReadings.observedAt),
    ctx.db
      .select({
        id: runs.id,
        t: runs.invokedAt,
        processId: runs.processId,
        processName: processes.name,
        status: runs.status,
      })
      .from(runs)
      .leftJoin(processes, eq(processes.id, runs.processId))
      .where(
        and(eq(runs.destinationId, ex.id), gte(runs.createdAt, from), isNotNull(runs.invokedAt)),
      )
      .orderBy(runs.invokedAt)
      .limit(2000),
    meterGauges(ctx, [ex.id]),
  ]);
  return {
    window,
    meters: specs.map((spec) => ({
      id: spec.id,
      title: spec.title,
      estimated:
        readings.some((r) => r.meterId === spec.id && r.estimated) || spec.estimate !== undefined,
      readings: readings
        .filter((r) => r.meterId === spec.id)
        .map((r) => ({
          t: r.observedAt.toISOString(),
          utilization: r.utilization,
          resetsAt: r.resetsAt?.toISOString() ?? null,
        })),
      ceilings: gauges.find((g) => g.meterId === spec.id)?.ceilings ?? [],
    })),
    runs: runRows.map((r) => ({
      t: r.t?.toISOString() ?? '',
      runId: r.id,
      processId: r.processId,
      processName: r.processName ?? '(deleted process)',
      status: r.status,
      statusLabel: runStatusLabel(r.status),
    })),
  };
}

export async function usageHistory(
  ctx: ApiContext,
  destinationId: string,
  window: StatsWindow,
): Promise<UsageHistoryResponse> {
  const [ex] = await ctx.db.select().from(destinations).where(eq(destinations.id, destinationId));
  if (!ex) throw notFound('Destination');
  const now = ctx.clock.now();
  const from = new Date(now.getTime() - windowMs(window === '24h' ? '7d' : window));
  const dims = destinationSpecs(ctx.runtime, ex).usage;
  const rows = await ctx.db
    .select({ day: dayExpr(runs.createdAt), status: runs.status, usage: runs.usage })
    .from(runs)
    .where(and(eq(runs.destinationId, ex.id), gte(runs.createdAt, from)));
  const days = daysBetween(from, now);
  return {
    window,
    dimensions: dims.map((d) => ({
      id: d.id,
      title: d.title,
      unit: d.unit,
      days: days.map((day) => {
        const vals = rows
          .filter((r) => r.day === day)
          .map((r) => r.usage?.[d.id])
          .filter((v): v is number => typeof v === 'number');
        return {
          day,
          value: d.aggregate === 'max' ? Math.max(0, ...vals) : vals.reduce((a, b) => a + b, 0),
        };
      }),
    })),
    runsByStatus: days.map((day) => {
      const counts: Partial<Record<RunStatusValue, number>> = {};
      for (const r of rows.filter((x) => x.day === day))
        counts[r.status] = (counts[r.status] ?? 0) + 1;
      return { day, counts };
    }),
  };
}

export async function processFunnel(
  ctx: ApiContext,
  processId: string,
  window: StatsWindow,
): Promise<FunnelResponse> {
  const now = ctx.clock.now();
  const from = new Date(now.getTime() - windowMs(window));
  const [d, b, r, received] = await Promise.all([
    ctx.db
      .select({ outcome: dispatches.outcome, n: count() })
      .from(dispatches)
      .where(and(eq(dispatches.processId, processId), gte(dispatches.createdAt, from)))
      .groupBy(dispatches.outcome),
    ctx.db
      .select({ kind: batches.kind, outcome: batches.outcome, n: count() })
      .from(batches)
      .where(and(eq(batches.processId, processId), gte(batches.openedAt, from)))
      .groupBy(batches.kind, batches.outcome),
    ctx.db
      .select({ kind: runs.kind, status: runs.status, n: count() })
      .from(runs)
      .where(and(eq(runs.processId, processId), gte(runs.createdAt, from)))
      .groupBy(runs.kind, runs.status),
    ctx.db.execute<{ n: string }>(sql`
      select count(*)::text as n from ${events} e
      where e.received_at >= ${from}
        and e.source_id::text in (
          select t->>'sourceId' from ${processes} p, jsonb_array_elements(p.document->'triggers') t where p.id = ${processId}
        )`),
  ]);
  const dn = (o: string) => d.filter((x) => x.outcome === o).reduce((a, x) => a + x.n, 0);
  const bn = (kind: readonly string[], o: readonly string[]) =>
    b.filter((x) => kind.includes(x.kind) && o.includes(x.outcome)).reduce((a, x) => a + x.n, 0);
  const rn = (kind: readonly string[], s: readonly string[]) =>
    r.filter((x) => kind.includes(x.kind) && s.includes(x.status)).reduce((a, x) => a + x.n, 0);
  const ev = ['event', 'manual'];
  return {
    window,
    event: {
      received: Number(received.rows[0]?.n ?? 0),
      matched: d.reduce((a, x) => a + x.n, 0),
      deduped: dn('deduped'),
      batched: dn('batched'),
      batches: bn(ev, BATCH_OUTCOMES),
      held: bn(ev, HELD_BATCH_OUTCOMES),
      throttled: bn(ev, ['throttled']),
      invoked: rn(ev, RUN_STATUSES),
      ok: rn(ev, ['ok']),
      error: rn(ev, ['error']),
      failed: rn(ev, ['failed']),
      unknown: rn(ev, ['unknown', 'uncertain']),
      running: rn(ev, ['invoking', 'running']),
    },
    sweep: {
      fired: bn(['sweep'], BATCH_OUTCOMES),
      held: bn(['sweep'], HELD_BATCH_OUTCOMES),
      throttled: bn(['sweep'], ['throttled']),
      invoked: rn(['sweep'], RUN_STATUSES),
      ok: rn(['sweep'], ['ok']),
      error: rn(['sweep'], ['error', 'failed', 'unknown']),
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export async function processStats(
  ctx: ApiContext,
  processId: string,
  window: StatsWindow,
): Promise<ProcessStatsResponse> {
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, processId));
  if (!proc) throw notFound('Process');
  const now = ctx.clock.now();
  const from = new Date(now.getTime() - windowMs(window === '24h' ? '7d' : window));
  const [runRows, batchRows] = await Promise.all([
    ctx.db
      .select({
        day: dayExpr(runs.createdAt),
        status: runs.status,
        invokedAt: runs.invokedAt,
        finishedAt: runs.finishedAt,
        firstEventAt: runs.firstEventAt,
        usage: runs.usage,
      })
      .from(runs)
      .where(and(eq(runs.processId, processId), gte(runs.createdAt, from), eq(runs.dryRun, false))),
    ctx.db
      .select({ day: dayExpr(batches.openedAt), outcome: batches.outcome, n: count() })
      .from(batches)
      .where(
        and(
          eq(batches.processId, processId),
          gte(batches.openedAt, from),
          inArray(batches.outcome, STOPPED_BATCH_OUTCOMES),
        ),
      )
      .groupBy(sql`1`, batches.outcome),
  ]);
  const days = daysBetween(from, now);
  const boundId = proc.document.destination.instanceId;
  const [bound] = isUuid(boundId)
    ? await ctx.db
        .select({
          id: destinations.id,
          typeId: destinations.typeId,
          settings: destinations.settings,
        })
        .from(destinations)
        .where(eq(destinations.id, boundId))
    : [];
  const dims = bound ? destinationSpecs(ctx.runtime, bound).usage : [];
  return {
    window,
    days: days.map((day) => {
      const rs = runRows.filter((r) => r.day === day);
      const counts: Partial<Record<RunStatusValue, number>> = {};
      for (const r of rs) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return {
        day,
        runs: counts,
        throttled: batchRows
          .filter((b) => b.day === day && b.outcome === 'throttled')
          .reduce((a, b) => a + b.n, 0),
        held: batchRows
          .filter((b) => b.day === day && b.outcome !== 'throttled')
          .reduce((a, b) => a + b.n, 0),
        latencyP50Seconds: median(
          rs
            .filter((r) => r.invokedAt && r.firstEventAt)
            .map((r) => ((r.invokedAt?.getTime() ?? 0) - (r.firstEventAt?.getTime() ?? 0)) / 1000),
        ),
        durationP50Seconds: median(
          rs
            .filter((r) => r.invokedAt && r.finishedAt)
            .map((r) => ((r.finishedAt?.getTime() ?? 0) - (r.invokedAt?.getTime() ?? 0)) / 1000),
        ),
      };
    }),
    usagePerRun: dims.map((d) => {
      const vals = runRows
        .map((r) => r.usage?.[d.id])
        .filter((v): v is number => typeof v === 'number');
      const total = vals.reduce((a, b) => a + b, 0);
      return {
        dimension: d.id,
        title: d.title,
        unit: d.unit,
        average: vals.length > 0 ? total / vals.length : null,
        total,
      };
    }),
  };
}
