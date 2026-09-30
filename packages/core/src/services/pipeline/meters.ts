import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { MeterSpec } from '@ai-switchboard/sdk';

import type { DbOrTx } from '../../db/client.js';
import { destinations, meterReadings, processes, type DestinationCaps } from '../../db/schema.js';
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

import type { Ctx } from './context.js';
import { callPlugin } from './plugin-call.js';
import { destinationRunsSince } from './counters.js';
import { sendSystemAlert } from './notify.js';

/** The newest reading per meter of each destination, keyed by destination id then meter id. */
export async function latestReadings(
  db: DbOrTx,
  destinationIds: readonly string[],
): Promise<Map<string, Map<string, StoredReading>>> {
  const out = new Map<string, Map<string, StoredReading>>(
    destinationIds.map((id) => [id, new Map()]),
  );
  if (destinationIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([meterReadings.destinationId, meterReadings.meterId], {
      destinationId: meterReadings.destinationId,
      meterId: meterReadings.meterId,
      utilization: meterReadings.utilization,
      used: meterReadings.used,
      limit: meterReadings.limit,
      observedAt: meterReadings.observedAt,
      resetsAt: meterReadings.resetsAt,
      estimated: meterReadings.estimated,
    })
    .from(meterReadings)
    .where(inArray(meterReadings.destinationId, [...destinationIds]))
    .orderBy(meterReadings.destinationId, meterReadings.meterId, desc(meterReadings.observedAt));
  for (const { destinationId, ...reading } of rows) {
    out.get(destinationId)?.set(reading.meterId, reading);
  }
  return out;
}

async function latestReadingsOf(
  db: DbOrTx,
  destinationId: string,
): Promise<Map<string, StoredReading>> {
  return (await latestReadings(db, [destinationId])).get(destinationId) ?? new Map();
}

async function estimateNow(
  db: DbOrTx,
  destinationId: string,
  spec: MeterSpec,
  caps: DestinationCaps,
  now: Date,
): Promise<StoredReading | null> {
  const limit = estimatedLimit(spec, caps.estimatedLimits);
  if (limit === undefined) return null;
  const period = spec.estimate?.period ?? 'day';
  const count = await destinationRunsSince(db, destinationId, periodBounds(period, now).start);
  return estimateReading(spec.id, limit, count, period, now);
}

export async function meterSnapshots(
  db: DbOrTx,
  destinationId: string,
  specs: readonly MeterSpec[],
  caps: DestinationCaps,
  now: Date,
): Promise<Record<string, MeterSnapshot>> {
  const latest = await latestReadingsOf(db, destinationId);
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
    const est = await estimateNow(db, destinationId, spec, caps, now);
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

/** Also stores estimated readings for meters the backend does not report. */
export async function readMeters(ctx: Ctx, destinationId: string): Promise<void> {
  const now = ctx.clock.now();
  const [row] = await ctx.db.select().from(destinations).where(eq(destinations.id, destinationId));
  if (!row) return;
  const live = ctx.runtime.destination(destinationId);
  if (!live) return;
  const specs = live.meters;
  const declared = new Set(specs.map((s) => s.id));
  let reported: unknown[] = [];
  if (live.destination.readMeters) {
    const read = live.destination.readMeters.bind(live.destination);
    const out = await callPlugin('readMeters', read);
    if (out.ok) reported = Array.isArray(out.value) ? out.value : [];
    else ctx.log.warn({ err: out.error, destination_id: destinationId }, 'readMeters failed');
  }
  const previous = await latestReadingsOf(ctx.db, destinationId);
  const readings: StoredReading[] = [];
  for (const item of reported) {
    const reading = readingFromReport(item, declared, now);
    if (reading) readings.push(reading);
  }
  for (const spec of specs) {
    if (readings.some((r) => r.meterId === spec.id)) continue;
    if (!isEstimatedMeter(spec, row.caps.estimatedLimits)) continue;
    const est = await estimateNow(ctx.db, destinationId, spec, row.caps, now);
    if (est) readings.push(est);
  }
  if (readings.length > 0) {
    await ctx.db.insert(meterReadings).values(
      readings.map((r) => ({
        destinationId,
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
  await ctx.db
    .update(destinations)
    .set({ metersReadAt: now })
    .where(eq(destinations.id, destinationId));

  for (const r of readings) {
    ctx.telemetry.gauge('switchboard.meter.utilization', r.utilization, {
      destination: destinationId,
      meter: r.meterId,
      estimated: r.estimated,
    });
    if (r.resetsAt) {
      ctx.telemetry.gauge(
        'switchboard.meter.resets_in',
        Math.max(0, (r.resetsAt.getTime() - now.getTime()) / 1000),
        { destination: destinationId, meter: r.meterId, estimated: r.estimated },
      );
    }
  }

  const bound = await ctx.db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes)
    .where(
      and(
        eq(processes.enabled, true),
        sql`${processes.document}->'destination'->>'instanceId' = ${destinationId}`,
      ),
    );
  for (const r of readings) {
    for (const p of bound) {
      const ceiling = p.document.budgets.meterCeilings[r.meterId];
      if (!ceiling) continue;
      if (ceilingCrossed(previous.get(r.meterId)?.utilization, r.utilization, ceiling.events)) {
        await sendSystemAlert(ctx, {
          key: `meter_ceiling:${destinationId}:${r.meterId}:${p.id}`,
          title: `Meter ceiling crossed: ${row.name} ${r.meterId}`,
          text: `${r.meterId} on ${row.name} is at ${r.utilization}%, above the events ceiling ${ceiling.events}% of process ${p.name}; event-driven runs are throttled.`,
          severity: 'warning',
        });
      }
    }
  }
}
