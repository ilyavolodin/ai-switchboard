import { sql } from 'drizzle-orm';

import { DEDUPE_WINDOW_SECONDS } from '../../pipeline/dedupe.js';
import { getSettings } from '../settings.js';

import type { Deps } from '../../deps.js';

/**
 * The nightly prune, per `GlobalSettings.retention`. Runs, steps, approvals, audit and process
 * versions are kept indefinitely; unmatched events go after 30 days (or sooner, with events).
 * Batches waiting for approval are never pruned.
 */
export async function prune(
  ctx: Pick<Deps, 'db' | 'clock' | 'logger'>,
): Promise<Record<string, number>> {
  const now = ctx.clock.now();
  const r = (await getSettings(ctx.db)).retention;
  const ago = (days: number) => new Date(now.getTime() - Math.max(1, days) * 86_400_000);
  const counts: Record<string, number> = {};
  const run = async (name: string, query: ReturnType<typeof sql>) => {
    const out = await ctx.db.execute(query);
    counts[name] = out.rowCount ?? 0;
  };
  await run('events', sql`DELETE FROM events WHERE received_at < ${ago(r.eventsDays)}`);
  await run(
    'events_unmatched',
    sql`DELETE FROM events WHERE stage = 'unmatched' AND received_at < ${ago(Math.min(30, r.eventsDays))}`,
  );
  await run('event_raw', sql`DELETE FROM event_raw WHERE received_at < ${ago(r.rawBodiesDays)}`);
  // Dedupe reads batched dispatches of the last 7 days: never prune inside that window.
  const dispatchDays = Math.max(r.dispatchesDays, Math.ceil(DEDUPE_WINDOW_SECONDS / 86_400) + 1);
  await run('dispatches', sql`DELETE FROM dispatches WHERE created_at < ${ago(dispatchDays)}`);
  await run(
    'batches',
    sql`DELETE FROM batches WHERE opened_at < ${ago(r.dispatchesDays)}
        AND outcome NOT IN ('open', 'closed', 'awaiting_approval')`,
  );
  await run(
    'meter_readings',
    sql`DELETE FROM meter_readings WHERE observed_at < ${ago(r.meterReadingsDays)}`,
  );
  await run('stats_hourly', sql`DELETE FROM stats_hourly WHERE hour < ${ago(r.statsHourlyDays)}`);
  await run(
    'schedule_ticks',
    sql`DELETE FROM schedule_ticks WHERE tick_at < ${ago(Math.max(r.dispatchesDays, 8))}`,
  );
  await run(
    'notification_log',
    sql`DELETE FROM notification_log WHERE at < ${ago(r.dispatchesDays)}`,
  );
  ctx.logger.info({ pruned: counts }, 'retention prune');
  return counts;
}
