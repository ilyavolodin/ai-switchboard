/**
 * Stage 3, dedupe: `(process, dedupeKey)` is unique for 7 days. Redeliveries, replays and
 * overlapping triggers converge on one dispatch, and so on one run.
 */

export const DEDUPE_WINDOW_SECONDS = 7 * 24 * 3600;

export interface PriorDispatch {
  id: string;
  createdAt: Date;
}

export type DedupeDecision = { outcome: 'batched' } | { outcome: 'deduped'; duplicateOf: string };

/** Start of the dedupe window at `now`; the service queries prior dispatches after it. */
export function dedupeWindowStart(now: Date): Date {
  return new Date(now.getTime() - DEDUPE_WINDOW_SECONDS * 1000);
}

/**
 * `prior` are earlier batched dispatches with the same process and key. A key seen inside the
 * window is a duplicate; one seen before it is new again. There is no upper bound: a dispatch
 * stamped a little after `now` was written by a replica whose clock runs ahead.
 */
export function dedupe(prior: readonly PriorDispatch[], now: Date): DedupeDecision {
  const start = dedupeWindowStart(now).getTime();
  const hit = prior
    .filter((p) => p.createdAt.getTime() > start)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  return hit ? { outcome: 'deduped', duplicateOf: hit.id } : { outcome: 'batched' };
}
