import { inArray } from 'drizzle-orm';

import { destinations } from '../../db/schema.js';
import { isFresh } from '../../pipeline/meters.js';
import { destinationSpecs } from '../../services/destination-specs.js';
import { latestReadings } from '../../services/pipeline/meters.js';
import { loadProcessRefs, type ProcessRef } from '../../services/process-refs.js';
import { getSettings } from '../../services/settings.js';
import type { ApiContext } from '../context.js';
import type { MeterGaugeDTO } from '../../contract/index.js';
import { ceilingState } from './ceiling-state.js';

/** Gauges for the given destinations, with process ceilings as marks and staleness applied. */
export async function meterGauges(
  ctx: ApiContext,
  destinationIds?: string[],
  processList?: ProcessRef[],
): Promise<MeterGaugeDTO[]> {
  if (destinationIds?.length === 0) return [];
  const rows = await ctx.db
    .select({
      id: destinations.id,
      name: destinations.name,
      typeId: destinations.typeId,
      settings: destinations.settings,
      caps: destinations.caps,
    })
    .from(destinations)
    .where(destinationIds ? inArray(destinations.id, destinationIds) : undefined);
  if (rows.length === 0) return [];
  const [settings, readings, procs] = await Promise.all([
    getSettings(ctx.db),
    latestReadings(
      ctx.db,
      rows.map((r) => r.id),
    ),
    processList ?? loadProcessRefs(ctx.db),
  ]);
  const now = ctx.clock.now();
  const out: MeterGaugeDTO[] = [];
  for (const ex of rows) {
    const specs = destinationSpecs(ctx.runtime, ex).meters;
    const stalenessMinutes = ex.caps.meterStalenessMinutes ?? settings.meterStalenessMinutes;
    const bound = procs.filter((p) => p.document.destination.instanceId === ex.id);
    specs.forEach((spec, index) => {
      const r = readings.get(ex.id)?.get(spec.id);
      const ceilings = bound.flatMap((p) => {
        const c = p.document.budgets.meterCeilings[spec.id];
        return c
          ? [{ processId: p.id, processName: p.name, events: c.events, sweeps: c.sweeps }]
          : [];
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
        stale: r ? !isFresh(r.observedAt, now, stalenessMinutes) : true,
        ceilings,
        ceilingState: ceilingState(spec.id, ceilings, r, stalenessMinutes, now),
        primary: spec.primary === true || (index === 0 && !specs.some((s) => s.primary === true)),
      });
    });
  }
  return out;
}
