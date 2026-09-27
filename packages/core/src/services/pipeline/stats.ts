import { sql } from 'drizzle-orm';

import { statsHourly } from '../../db/schema.js';

import type { Deps } from '../../deps.js';
import { countedRun } from './counters.js';

/**
 * Hourly statistics materialised into `stats_hourly (dimension, key, hour, counters)` so the UI
 * renders from one small table. Recomputing an hour replaces its rows (idempotent), so the job
 * re-materialises a trailing window to pick up runs that closed later.
 *
 * Dimensions and counter names:
 * - `source` (key: source id): `total`, `stage:<stage>`, `verify_failed`
 * - `event_type` (key: `<sourceId>|<type>`): `total`, `stage:<stage>`
 * - `process` (key: process id): `dispatch:<outcome>`, `batches:<kind>:<outcome>`,
 *   `runs:<status>`, `runs_kind:<kind>:<status>`, `budget:runs` (runs counted toward budgets),
 *   `latency_p50|p90|count`, `duration_p50|p90|count` (seconds), `usage:<dim>`, `usage_runs:<dim>`
 * - `executor` (key: executor id): `runs:<status>`, `budget:runs`, `usage:<dim>`, `duration_p50`
 * - `meter` (key: `<executorId>|<meterId>`): `utilization_max`, `utilization_last`, `readings`,
 *   `estimated` (1 when any reading was estimated)
 */

type Counters = Record<string, number>;

class Buckets {
  readonly rows = new Map<
    string,
    { dimension: string; key: string; hour: Date; counters: Counters }
  >();

  add(dimension: string, key: string, hour: Date | string, name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const h = new Date(hour);
    const id = `${dimension}\u0000${key}\u0000${h.toISOString()}`;
    let row = this.rows.get(id);
    if (!row) {
      row = { dimension, key, hour: h, counters: {} };
      this.rows.set(id, row);
    }
    row.counters[name] = (row.counters[name] ?? 0) + value;
  }

  set(
    dimension: string,
    key: string,
    hour: Date | string,
    name: string,
    value: number | null,
  ): void {
    if (value === null || !Number.isFinite(value)) return;
    this.add(dimension, key, hour, name, 0);
    const h = new Date(hour);
    const row = this.rows.get(`${dimension}\u0000${key}\u0000${h.toISOString()}`);
    if (row) row.counters[name] = Math.round(value * 1000) / 1000;
  }
}

function hourFloor(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCMinutes(0, 0, 0);
  return out;
}

type Row = Record<string, unknown>;

async function rows(ctx: Pick<Deps, 'db'>, query: ReturnType<typeof sql>): Promise<Row[]> {
  const out = await ctx.db.execute<Row>(query);
  return out.rows;
}

const n = (v: unknown): number => (v === null || v === undefined ? Number.NaN : Number(v));
const s = (v: unknown): string => (typeof v === 'string' ? v : String(v));
const h = (v: unknown): Date => new Date(v as string);

/** Materialise every hour in `[from, to)` (both floored to the hour). Returns rows written. */
export async function materialiseStats(
  ctx: Pick<Deps, 'db'>,
  from: Date,
  to: Date,
): Promise<number> {
  const start = hourFloor(from);
  const end = new Date(hourFloor(to).getTime() + 3_600_000);
  const b = new Buckets();

  for (const r of await rows(
    ctx,
    sql`SELECT source_id, type, stage, date_trunc('hour', received_at) AS h, count(*) AS n
        FROM events WHERE received_at >= ${start} AND received_at < ${end}
        GROUP BY 1, 2, 3, 4`,
  )) {
    const source = s(r.source_id);
    b.add('source', source, h(r.h), 'total', n(r.n));
    b.add('source', source, h(r.h), `stage:${s(r.stage)}`, n(r.n));
    b.add('event_type', `${source}|${s(r.type)}`, h(r.h), 'total', n(r.n));
    b.add('event_type', `${source}|${s(r.type)}`, h(r.h), `stage:${s(r.stage)}`, n(r.n));
  }
  for (const r of await rows(
    ctx,
    sql`SELECT source_id, date_trunc('hour', received_at) AS h, count(*) AS n
        FROM event_raw WHERE verify LIKE 'rejected%' AND received_at >= ${start} AND received_at < ${end}
        GROUP BY 1, 2`,
  )) {
    b.add('source', s(r.source_id), h(r.h), 'verify_failed', n(r.n));
  }
  for (const r of await rows(
    ctx,
    sql`SELECT process_id, outcome, date_trunc('hour', created_at) AS h, count(*) AS n
        FROM dispatches WHERE created_at >= ${start} AND created_at < ${end}
        GROUP BY 1, 2, 3`,
  )) {
    b.add('process', s(r.process_id), h(r.h), `dispatch:${s(r.outcome)}`, n(r.n));
  }
  for (const r of await rows(
    ctx,
    sql`SELECT process_id, kind, outcome, date_trunc('hour', opened_at) AS h, count(*) AS n
        FROM batches WHERE opened_at >= ${start} AND opened_at < ${end}
        GROUP BY 1, 2, 3, 4`,
  )) {
    b.add('process', s(r.process_id), h(r.h), `batches:${s(r.kind)}:${s(r.outcome)}`, n(r.n));
  }
  for (const r of await rows(
    ctx,
    sql`SELECT process_id, executor_id, kind, status, date_trunc('hour', created_at) AS h,
               count(*) AS n, count(*) FILTER (WHERE ${countedRun()}) AS counted
        FROM runs WHERE created_at >= ${start} AND created_at < ${end}
        GROUP BY 1, 2, 3, 4, 5`,
  )) {
    const p = s(r.process_id);
    const e = s(r.executor_id);
    b.add('process', p, h(r.h), `runs:${s(r.status)}`, n(r.n));
    b.add('process', p, h(r.h), `runs_kind:${s(r.kind)}:${s(r.status)}`, n(r.n));
    b.add('process', p, h(r.h), 'budget:runs', n(r.counted));
    b.add('executor', e, h(r.h), `runs:${s(r.status)}`, n(r.n));
    b.add('executor', e, h(r.h), 'budget:runs', n(r.counted));
  }
  for (const r of await rows(
    ctx,
    sql`SELECT process_id, date_trunc('hour', created_at) AS h,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM invoked_at - first_event_at))
            FILTER (WHERE invoked_at IS NOT NULL AND first_event_at IS NOT NULL) AS lat50,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM invoked_at - first_event_at))
            FILTER (WHERE invoked_at IS NOT NULL AND first_event_at IS NOT NULL) AS lat90,
          count(*) FILTER (WHERE invoked_at IS NOT NULL AND first_event_at IS NOT NULL) AS latn,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - invoked_at))
            FILTER (WHERE invoked_at IS NOT NULL AND finished_at IS NOT NULL) AS dur50,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - invoked_at))
            FILTER (WHERE invoked_at IS NOT NULL AND finished_at IS NOT NULL) AS dur90,
          count(*) FILTER (WHERE invoked_at IS NOT NULL AND finished_at IS NOT NULL) AS durn
        FROM runs WHERE created_at >= ${start} AND created_at < ${end}
        GROUP BY 1, 2`,
  )) {
    const p = s(r.process_id);
    b.set('process', p, h(r.h), 'latency_p50', r.lat50 === null ? null : n(r.lat50));
    b.set('process', p, h(r.h), 'latency_p90', r.lat90 === null ? null : n(r.lat90));
    b.set('process', p, h(r.h), 'latency_count', n(r.latn));
    b.set('process', p, h(r.h), 'duration_p50', r.dur50 === null ? null : n(r.dur50));
    b.set('process', p, h(r.h), 'duration_p90', r.dur90 === null ? null : n(r.dur90));
    b.set('process', p, h(r.h), 'duration_count', n(r.durn));
  }
  for (const r of await rows(
    ctx,
    sql`SELECT executor_id, date_trunc('hour', created_at) AS h,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - invoked_at))
            FILTER (WHERE invoked_at IS NOT NULL AND finished_at IS NOT NULL) AS dur50
        FROM runs WHERE created_at >= ${start} AND created_at < ${end}
        GROUP BY 1, 2`,
  )) {
    b.set(
      'executor',
      s(r.executor_id),
      h(r.h),
      'duration_p50',
      r.dur50 === null ? null : n(r.dur50),
    );
  }
  for (const r of await rows(
    ctx,
    sql`SELECT process_id, executor_id, date_trunc('hour', created_at) AS h, u.key AS dim,
               sum(u.value::float8) AS total, count(*) AS n
        FROM runs, jsonb_each_text(usage) AS u(key, value)
        WHERE usage IS NOT NULL AND created_at >= ${start} AND created_at < ${end}
          AND u.value ~ '^-?[0-9.eE+-]+$'
        GROUP BY 1, 2, 3, 4`,
  )) {
    b.add('process', s(r.process_id), h(r.h), `usage:${s(r.dim)}`, n(r.total));
    b.add('process', s(r.process_id), h(r.h), `usage_runs:${s(r.dim)}`, n(r.n));
    b.add('executor', s(r.executor_id), h(r.h), `usage:${s(r.dim)}`, n(r.total));
  }
  for (const r of await rows(
    ctx,
    sql`SELECT executor_id, meter_id, date_trunc('hour', observed_at) AS h,
               max(utilization) AS umax, count(*) AS n, bool_or(estimated) AS est,
               (array_agg(utilization ORDER BY observed_at DESC))[1] AS ulast
        FROM meter_readings WHERE observed_at >= ${start} AND observed_at < ${end}
        GROUP BY 1, 2, 3`,
  )) {
    const key = `${s(r.executor_id)}|${s(r.meter_id)}`;
    b.set('meter', key, h(r.h), 'utilization_max', n(r.umax));
    b.set('meter', key, h(r.h), 'utilization_last', n(r.ulast));
    b.set('meter', key, h(r.h), 'readings', n(r.n));
    b.set('meter', key, h(r.h), 'estimated', r.est === true ? 1 : 0);
  }

  const list = [...b.rows.values()];
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM ${statsHourly} WHERE hour >= ${start} AND hour < ${end}`);
    for (let i = 0; i < list.length; i += 500) {
      await tx.insert(statsHourly).values(list.slice(i, i + 500));
    }
  });
  return list.length;
}
