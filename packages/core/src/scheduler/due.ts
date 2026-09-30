import type { ProcessDocument, Schedule } from '../domain/process.js';

import { addDays, addMinutes } from '../util/time.js';

import { nextTicks, parseCron, ticksBetween } from './cron.js';

/** A tick this old still counts as on time: the scheduler job itself may run late. */
export const ON_TIME_GRACE_MINUTES = 2;
export const MAX_CATCH_UP_DAYS = 7;

export interface ScheduleHistory {
  lastTickAt: Date | null;
  /** Lower bound when there is no history (the process's last save). */
  since: Date;
}

export interface DueSweep {
  tickAt: Date;
  catchUp: boolean;
}

/** At most one sweep per schedule; `catchUp: 'once'` makes up only the latest missed tick. */
export function dueSweep(schedule: Schedule, history: ScheduleHistory, now: Date): DueSweep | null {
  if (!schedule.enabled) return null;
  const parsed = parseCron(schedule.cron);
  if (!parsed.ok) return null;
  const floor = addDays(now, -MAX_CATCH_UP_DAYS).getTime();
  const from = new Date(Math.max((history.lastTickAt ?? history.since).getTime(), floor));
  const ticks = ticksBetween(parsed.cron, schedule.timezone, from, now);
  const latest = ticks.at(-1);
  if (!latest) return null;
  const onTimeFrom = addMinutes(now, -ON_TIME_GRACE_MINUTES).getTime();
  if (latest.getTime() >= onTimeFrom) return { tickAt: latest, catchUp: false };
  return schedule.catchUp === 'once' ? { tickAt: latest, catchUp: true } : null;
}

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
