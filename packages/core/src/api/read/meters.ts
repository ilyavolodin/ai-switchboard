import type { MeterSpec } from '@ai-switchboard/sdk';
import { desc, inArray } from 'drizzle-orm';

import type { DbOrTx } from '../../db/client.js';
import { destinations, meterReadings, processes } from '../../db/schema.js';
import type { ApiContext } from '../context.js';
import type { MeterGaugeDTO } from '../contract.js';
import { getSettings } from '../../services/settings.js';

interface LatestReading {
  destinationId: string;
  meterId: string;
  observedAt: Date;
  used: number | null;
  limit: number | null;
  utilization: number;
  resetsAt: Date | null;
  estimated: boolean;
}

/** The newest reading per (destination, meter). */
export async function latestReadings(
  db: DbOrTx,
  destinationIds: string[],
): Promise<LatestReading[]> {
  if (destinationIds.length === 0) return [];
  return db
    .selectDistinctOn([meterReadings.destinationId, meterReadings.meterId], {
      destinationId: meterReadings.destinationId,
      meterId: meterReadings.meterId,
      observedAt: meterReadings.observedAt,
      used: meterReadings.used,
      limit: meterReadings.limit,
      utilization: meterReadings.utilization,
      resetsAt: meterReadings.resetsAt,
      estimated: meterReadings.estimated,
    })
    .from(meterReadings)
    .where(inArray(meterReadings.destinationId, destinationIds))
    .orderBy(meterReadings.destinationId, meterReadings.meterId, desc(meterReadings.observedAt));
}

/** Meter specs for a destination: from its live object, else from the stored type manifest. */
export function meterSpecsFor(ctx: ApiContext, destinationId: string, typeId: string): MeterSpec[] {
  const live = ctx.runtime.destination(destinationId);
  if (live) return live.meters;
  return ctx.runtime.destinationType(typeId)?.type.meters ?? [];
}

/** Gauges for the given destinations, with process ceilings as marks and staleness applied. */
export async function meterGauges(
  ctx: ApiContext,
  destinationIds?: string[],
  processList?: Pick<typeof processes.$inferSelect, 'id' | 'name' | 'document'>[],
): Promise<MeterGaugeDTO[]> {
  if (destinationIds?.length === 0) return [];
  const rows = await ctx.db
    .select({
      id: destinations.id,
      name: destinations.name,
      typeId: destinations.typeId,
      caps: destinations.caps,
    })
    .from(destinations)
    .where(destinationIds ? inArray(destinations.id, destinationIds) : undefined);
  if (rows.length === 0) return [];
  const settings = await getSettings(ctx.db);
  const readings = await latestReadings(
    ctx.db,
    rows.map((r) => r.id),
  );
  const procs =
    processList ??
    (await ctx.db
      .select({ id: processes.id, name: processes.name, document: processes.document })
      .from(processes));
  const now = ctx.clock.now().getTime();
  const out: MeterGaugeDTO[] = [];
  for (const ex of rows) {
    const specs = meterSpecsFor(ctx, ex.id, ex.typeId);
    const stalenessMs = (ex.caps.meterStalenessMinutes ?? settings.meterStalenessMinutes) * 60_000;
    specs.forEach((spec, index) => {
      const r = readings.find((x) => x.destinationId === ex.id && x.meterId === spec.id);
      const ceilings = procs
        .filter(
          (p) =>
            p.document.destination.instanceId === ex.id &&
            p.document.budgets.meterCeilings[spec.id],
        )
        .map((p) => {
          const c = p.document.budgets.meterCeilings[spec.id] ?? { events: 100, sweeps: 100 };
          return { processId: p.id, processName: p.name, events: c.events, sweeps: c.sweeps };
        });
      out.push({
        destinationId: ex.id,
        destinationName: ex.name,
        meterId: spec.id,
        title: spec.title,
        kind: spec.kind,
        unit: spec.unit,
        utilization: r ? Math.round(r.utilization * 10) / 10 : null,
        used: r?.used ?? null,
        limit: r?.limit ?? null,
        resetsAt: r?.resetsAt?.toISOString() ?? null,
        observedAt: r?.observedAt.toISOString() ?? null,
        estimated: r?.estimated ?? spec.estimate !== undefined,
        stale: r ? now - r.observedAt.getTime() > stalenessMs : true,
        ceilings,
        primary: spec.primary === true || (index === 0 && !specs.some((s) => s.primary === true)),
      });
    });
  }
  return out;
}
