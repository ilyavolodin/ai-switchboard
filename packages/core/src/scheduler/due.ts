import type { ProcessDocument, Schedule } from '../domain/process.js';

import { nextTicks, parseCron, ticksBetween } from './cron.js';

/**
 * Which sweep a schedule owes at `now`. The scheduler ticks every minute; a tick that is at most
 * `ON_TIME_GRACE_MINUTES` old counts as on time (the scheduler job itself may run late). Older
 * ticks were missed (no replica was running):
 * - `catchUp: 'skip'` fires nothing for them;
 * - `catchUp: 'once'` fires one make-up sweep, for the latest missed tick.
 * Each evaluation fires at most one sweep per schedule.
 */

export const ON_TIME_GRACE_MINUTES = 2;
/** Missed ticks older than this are not considered. */
export const MAX_CATCH_UP_DAYS = 7;

export interface ScheduleHistory {
  /** The latest tick this schedule fired (from `schedule_ticks`). */
  lastTickAt: Date | null;
  /** Lower bound when there is no history (the process's last save). */
  since: Date;
}

export interface DueSweep {
  tickAt: Date;
  catchUp: boolean;
}

export function dueSweep(schedule: Schedule, history: ScheduleHistory, now: Date): DueSweep | null {
  if (!schedule.enabled) return null;
  const parsed = parseCron(schedule.cron);
  if (!parsed.ok) return null;
  const floor = now.getTime() - MAX_CATCH_UP_DAYS * 86_400_000;
  // Without history, only ticks after the process was saved count.
  const from = new Date(Math.max((history.lastTickAt ?? history.since).getTime(), floor));
  const ticks = ticksBetween(parsed.cron, schedule.timezone, from, now);
  const latest = ticks.at(-1);
  if (!latest) return null;
  const onTimeFrom = now.getTime() - ON_TIME_GRACE_MINUTES * 60_000;
  if (latest.getTime() >= onTimeFrom) return { tickAt: latest, catchUp: false };
  return schedule.catchUp === 'once' ? { tickAt: latest, catchUp: true } : null;
}

/** The earliest next sweep across a process's enabled schedules, for summaries. */
export function nextSweepAt(document: ProcessDocument, now: Date): Date | null {
  let best: Date | null = null;
  for (const s of document.schedules) {
    if (!s.enabled) continue;
    const parsed = parseCron(s.cron);
    if (!parsed.ok) continue;
    const [next] = nextTicks(parsed.cron, s.timezone, now, 1);
    if (next && (best === null || next.getTime() < best.getTime())) best = next;
  }
  return best;
}
