import { DAY_MS, SECOND_MS, msAgo } from '../util/time.js';

/** `(process, dedupeKey)` is unique for 7 days, so redeliveries and replays converge on one run. */

export const DEDUPE_WINDOW_DAYS = 7;
export const DEDUPE_WINDOW_SECONDS = (DEDUPE_WINDOW_DAYS * DAY_MS) / SECOND_MS;

export interface PriorDispatch {
  id: string;
  createdAt: Date;
}

export type DedupeDecision = { outcome: 'batched' } | { outcome: 'deduped'; duplicateOf: string };

export function dedupeWindowStart(now: Date): Date {
  return msAgo(now, DEDUPE_WINDOW_DAYS * DAY_MS);
}

/**
 * No upper bound on the window: a dispatch stamped a little after `now` was written by a replica
 * whose clock runs ahead.
 */
export function dedupe(prior: readonly PriorDispatch[], now: Date): DedupeDecision {
  const start = dedupeWindowStart(now).getTime();
  const hit = prior
    .filter((p) => p.createdAt.getTime() > start)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  return hit ? { outcome: 'deduped', duplicateOf: hit.id } : { outcome: 'batched' };
}
