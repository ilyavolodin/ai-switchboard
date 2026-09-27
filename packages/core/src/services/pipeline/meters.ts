import { and, eq, sql } from 'drizzle-orm';

import type { MeterSpec } from '@ai-switchboard/sdk';

import type { DbOrTx } from '../../db/client.js';
import { executors, meterReadings, processes, type ExecutorCaps } from '../../db/schema.js';
import type { MeterSnapshot } from '../../pipeline/budget.js';
import {
  ceilingCrossed,
  estimatedLimit,
  estimateReading,
  isEstimatedMeter,
  periodBounds,
  readingFromReport,
  type StoredReading,
} from '../../pipeline/meters.js';

import { callPlugin, type Ctx } from './context.js';
import { executorRunsSince } from './counters.js';
import { sendSystemAlert } from './notify.js';

/** The latest stored reading per meter id for an executor instance. */
export async function latestReadings(
  db: DbOrTx,
  executorId: string,
): Promise<Map<string, StoredReading>> {
  const rows = await db.execute<{
    meter_id: string;
    utilization: number;
    used: number | null;
    limit: number | null;
    observed_at: Date | string;
    resets_at: Date | string | null;
    estimated: boolean;
  }>(sql`
    SELECT DISTINCT ON (${meterReadings.meterId})
      ${meterReadings.meterId} AS meter_id, ${meterReadings.utilization} AS utilization,
      ${meterReadings.used} AS used, ${meterReadings.limit} AS "limit",
      ${meterReadings.observedAt} AS observed_at, ${meterReadings.resetsAt} AS resets_at,
      ${meterReadings.estimated} AS estimated
    FROM ${meterReadings}
    WHERE ${meterReadings.executorId} = ${executorId}
    ORDER BY ${meterReadings.meterId}, ${meterReadings.observedAt} DESC`);
  const out = new Map<string, StoredReading>();
  for (const r of rows.rows) {
    out.set(r.meter_id, {
      meterId: r.meter_id,
      utilization: r.utilization,
      used: r.used,
      limit: r.limit,
      observedAt: new Date(r.observed_at),
      resetsAt: r.resets_at === null ? null : new Date(r.resets_at),
      estimated: r.estimated,
    });
  }
  return out;
}

/** Compute the estimated reading for a meter the core estimates, from run counts right now. */
async function estimateNow(
  db: DbOrTx,
  executorId: string,
  spec: MeterSpec,
  caps: ExecutorCaps,
  now: Date,
): Promise<StoredReading | null> {
  const limit = estimatedLimit(spec, caps.estimatedLimits);
  if (limit === undefined) return null;
  const period = spec.estimate?.period ?? 'day';
  const count = await executorRunsSince(db, executorId, periodBounds(period, now).start);
  return estimateReading(spec.id, limit, count, period, now);
}

/**
 * The meter snapshots the budget stage checks: estimated meters are recomputed from the run
 * counts at this moment; reported meters use their latest stored reading.
 */
export async function meterSnapshots(
  db: DbOrTx,
  executorId: string,
  specs: readonly MeterSpec[],
  caps: ExecutorCaps,
  now: Date,
): Promise<Record<string, MeterSnapshot>> {
  const latest = await latestReadings(db, executorId);
  const out: Record<string, MeterSnapshot> = {};
  for (const [id, r] of latest) {
    out[id] = {
      utilization: r.utilization,
      observedAt: r.observedAt,
      estimated: r.estimated,
      resetsAt: r.resetsAt,
    };
  }
  for (const spec of specs) {
    if (!isEstimatedMeter(spec, caps.estimatedLimits)) continue;
    if (latest.get(spec.id)?.estimated === false) continue; // the backend reports it after all
    const est = await estimateNow(db, executorId, spec, caps, now);
    if (est) {
      out[spec.id] = {
        utilization: est.utilization,
        observedAt: est.observedAt,
        estimated: true,
        resetsAt: est.resetsAt,
      };
    }
  }
  return out;
}

/**
 * Read an executor's meters now: store every declared reading, plus estimated readings for
 * meters the backend does not report. Alerts when a reading crosses a process's events ceiling.
 */
export async function readMeters(ctx: Ctx, executorId: string): Promise<void> {
  const now = ctx.clock.now();
  const [row] = await ctx.db.select().from(executors).where(eq(executors.id, executorId));
  if (!row) return;
  const live = ctx.runtime.executor(executorId);
  if (!live) return;
  const specs = live.meters;
  const declared = new Set(specs.map((s) => s.id));
  let reported: unknown[] = [];
  if (live.executor.readMeters) {
    const read = live.executor.readMeters.bind(live.executor);
    const out = await callPlugin(ctx, live.pluginName, 'readMeters', read);
    if (out.ok) reported = Array.isArray(out.value) ? out.value : [];
    else ctx.log.warn({ err: out.error, executor_id: executorId }, 'readMeters failed');
  }
  const previous = await latestReadings(ctx.db, executorId);
  const readings: StoredReading[] = [];
  for (const item of reported) {
    const reading = readingFromReport(item, declared, now);
    if (reading) readings.push(reading);
  }
  for (const spec of specs) {
    if (readings.some((r) => r.meterId === spec.id)) continue;
    if (!isEstimatedMeter(spec, row.caps.estimatedLimits)) continue;
    const est = await estimateNow(ctx.db, executorId, spec, row.caps, now);
    if (est) readings.push(est);
  }
  if (readings.length > 0) {
    await ctx.db.insert(meterReadings).values(
      readings.map((r) => ({
        executorId,
        meterId: r.meterId,
        observedAt: r.observedAt,
        used: r.used,
        limit: r.limit,
        utilization: r.utilization,
        resetsAt: r.resetsAt,
        estimated: r.estimated,
      })),
    );
  }
  await ctx.db.update(executors).set({ metersReadAt: now }).where(eq(executors.id, executorId));

  for (const r of readings) {
    ctx.telemetry.gauge('switchboard.meter.utilization', r.utilization, {
      executor: executorId,
      meter: r.meterId,
      estimated: r.estimated,
    });
    if (r.resetsAt) {
      ctx.telemetry.gauge(
        'switchboard.meter.resets_in',
        Math.max(0, (r.resetsAt.getTime() - now.getTime()) / 1000),
        { executor: executorId, meter: r.meterId, estimated: r.estimated },
      );
    }
  }

  // Ceiling crossings for the processes bound to this executor.
  const bound = await ctx.db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes)
    .where(
      and(
        eq(processes.enabled, true),
        sql`${processes.document}->'executor'->>'instanceId' = ${executorId}`,
      ),
    );
  for (const r of readings) {
    for (const p of bound) {
      const ceiling = p.document.budgets.meterCeilings[r.meterId];
      if (!ceiling) continue;
      if (ceilingCrossed(previous.get(r.meterId)?.utilization, r.utilization, ceiling.events)) {
        await sendSystemAlert(ctx, {
          key: `meter_ceiling:${executorId}:${r.meterId}:${p.id}`,
          title: `Meter ceiling crossed: ${row.name} ${r.meterId}`,
          text: `${r.meterId} on ${row.name} is at ${r.utilization}%, above the events ceiling ${ceiling.events}% of process ${p.name}; event-driven runs are throttled.`,
          severity: 'warning',
        });
      }
    }
  }
}
