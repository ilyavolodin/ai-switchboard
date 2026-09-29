import { and, eq, gt, sql, type SQL } from 'drizzle-orm';

import type { UsageDimension } from '@ai-switchboard/sdk';

import type { DbOrTx } from '../../db/client.js';
import { runs } from '../../db/schema.js';
import type { BudgetCounters } from '../../pipeline/budget.js';

/**
 * Counters are computed from `runs`, never stored, so a corrected run corrects the budget. A run
 * counts from its reservation (`invoked_at`) unless it is a dry run, `held`, or failed before any
 * invoke attempt (a before-step failure).
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function countedRun(): SQL {
  return sql`(${runs.dryRun} = false AND ${runs.status} <> 'held' AND NOT (${runs.status} = 'failed' AND ${runs.attempts} = 0))`;
}

async function runCounts(
  db: DbOrTx,
  scope: SQL,
  now: Date,
): Promise<{ hour: number; day: number }> {
  const [row] = await db
    .select({
      hour: sql<number>`count(*) filter (where ${runs.invokedAt} > ${new Date(now.getTime() - HOUR)})`.mapWith(
        Number,
      ),
      day: sql<number>`count(*)`.mapWith(Number),
    })
    .from(runs)
    .where(and(scope, gt(runs.invokedAt, new Date(now.getTime() - DAY)), countedRun()));
  return { hour: row?.hour ?? 0, day: row?.day ?? 0 };
}

async function usageLastDay(
  db: DbOrTx,
  scope: SQL,
  dimensions: readonly UsageDimension[],
  now: Date,
): Promise<Record<string, number>> {
  const rows = await db.execute<{ key: string; total: string | number; peak: string | number }>(sql`
    SELECT u.key AS key, sum(u.value::float8) AS total, max(u.value::float8) AS peak
    FROM ${runs}, jsonb_each_text(${runs.usage}) AS u(key, value)
    WHERE ${scope}
      AND ${runs.invokedAt} > ${new Date(now.getTime() - DAY)}
      AND ${runs.usage} IS NOT NULL
      AND ${countedRun()}
      AND u.value ~ '^-?[0-9.eE+-]+$'
    GROUP BY u.key`);
  const out: Record<string, number> = {};
  for (const r of rows.rows) {
    const dim = dimensions.find((d) => d.id === r.key);
    out[r.key] = Number(dim?.aggregate === 'max' ? r.peak : r.total);
  }
  return out;
}

export async function countersFor(
  db: DbOrTx,
  scope: { processId: string; destinationId: string; dimensions: readonly UsageDimension[] },
  now: Date,
): Promise<BudgetCounters> {
  const byProcess = eq(runs.processId, scope.processId);
  const byDestination = eq(runs.destinationId, scope.destinationId);
  // Sequential: inside a transaction the queries share one connection.
  const p = await runCounts(db, byProcess, now);
  const e = await runCounts(db, byDestination, now);
  const pu = await usageLastDay(db, byProcess, scope.dimensions, now);
  const eu = await usageLastDay(db, byDestination, scope.dimensions, now);
  return {
    processRunsHour: p.hour,
    processRunsDay: p.day,
    destinationRunsHour: e.hour,
    destinationRunsDay: e.day,
    processUsageDay: pu,
    destinationUsageDay: eu,
  };
}

export async function destinationRunsSince(
  db: DbOrTx,
  destinationId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(runs)
    .where(and(eq(runs.destinationId, destinationId), gt(runs.invokedAt, since), countedRun()));
  return row?.n ?? 0;
}
