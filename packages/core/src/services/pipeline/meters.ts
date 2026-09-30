import { desc, eq, inArray } from 'drizzle-orm';

import type { MeterSpec } from '@ai-switchboard/sdk';

import type { DbOrTx, Tx } from '../../db/client.js';
import { destinations, meterReadings, type DestinationCaps } from '../../db/schema.js';
import { withTx } from '../../db/tx.js';
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

import { processesBoundTo } from '../process-refs.js';

import type { Ctx } from './context.js';
import { destinationRunsSince } from './counters.js';
import { sendSystemAlert } from './notify.js';
import { callPlugin } from './plugin-call.js';

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

/**
 * Readings estimated from counted runs, for the estimated meters `covered` does not already
 * answer for.
 */
async function estimatedReadings(
  db: DbOrTx,
  destinationId: string,
  specs: readonly MeterSpec[],
  caps: DestinationCaps,
  now: Date,
  covered: (meterId: string) => boolean,
): Promise<StoredReading[]> {
  const out: StoredReading[] = [];
  for (const spec of specs) {
    if (!isEstimatedMeter(spec, caps.estimatedLimits) || covered(spec.id)) continue;
    const limit = estimatedLimit(spec, caps.estimatedLimits);
    if (limit === undefined) continue;
    const period = spec.estimate?.period ?? 'day';
    const count = await destinationRunsSince(db, destinationId, periodBounds(period, now).start);
    out.push(estimateReading(spec.id, limit, count, period, now));
  }
  return out;
}

function toSnapshot(r: StoredReading): MeterSnapshot {
  return {
    utilization: r.utilization,
    observedAt: r.observedAt,
    estimated: r.estimated,
    resetsAt: r.resetsAt,
  };
}

export async function meterSnapshots(
  db: DbOrTx,
  destinationId: string,
  specs: readonly MeterSpec[],
  caps: DestinationCaps,
  now: Date,
): Promise<Record<string, MeterSnapshot>> {
  const latest = await latestReadingsOf(db, destinationId);
  // An estimate stands in unless the backend has reported the meter after all.
  const estimates = await estimatedReadings(
    db,
    destinationId,
    specs,
    caps,
    now,
    (id) => latest.get(id)?.estimated === false,
  );
  return Object.fromEntries(
    [...latest.values(), ...estimates].map((r) => [r.meterId, toSnapshot(r)]),
  );
}

/**
 * Also stores estimated readings for meters the backend does not report. `inTx` writes in the
 * same transaction as the readings (the audit row of a manual read).
 */
export async function readMeters(
  ctx: Ctx,
  destinationId: string,
  inTx?: (tx: Tx) => Promise<void>,
): Promise<void> {
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
  const readings = reported.flatMap((item) => readingFromReport(item, declared, now) ?? []);
  readings.push(
    ...(await estimatedReadings(ctx.db, destinationId, specs, row.caps, now, (id) =>
      readings.some((r) => r.meterId === id),
    )),
  );
  await withTx(ctx.db, async (tx) => {
    if (readings.length > 0) {
      await tx.insert(meterReadings).values(readings.map((r) => ({ destinationId, ...r })));
    }
    await tx
      .update(destinations)
      .set({ metersReadAt: now })
      .where(eq(destinations.id, destinationId));
    await inTx?.(tx);
  });

  emitMeterGauges(ctx, destinationId, readings, now);
  await alertCrossedCeilings(ctx, row.name, destinationId, previous, readings);
}

function emitMeterGauges(
  ctx: Ctx,
  destinationId: string,
  readings: readonly StoredReading[],
  now: Date,
): void {
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
}

/** One alert per enabled process whose events ceiling a reading just crossed. */
async function alertCrossedCeilings(
  ctx: Ctx,
  destinationName: string,
  destinationId: string,
  previous: ReadonlyMap<string, StoredReading>,
  readings: readonly StoredReading[],
): Promise<void> {
  if (readings.length === 0) return;
  const bound = await processesBoundTo(ctx.db, destinationId, { enabledOnly: true });
  for (const r of readings) {
    for (const p of bound) {
      const ceiling = p.document.budgets.meterCeilings[r.meterId];
      if (!ceiling) continue;
      if (!ceilingCrossed(previous.get(r.meterId)?.utilization, r.utilization, ceiling.events))
        continue;
      await sendSystemAlert(ctx, {
        key: `meter_ceiling:${destinationId}:${r.meterId}:${p.id}`,
        title: `Meter ceiling crossed: ${destinationName} ${r.meterId}`,
        text: `${r.meterId} on ${destinationName} is at ${r.utilization}%, above the events ceiling ${ceiling.events}% of process ${p.name}; event-driven runs are throttled.`,
        severity: 'warning',
      });
    }
  }
}
