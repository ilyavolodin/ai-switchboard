import { BREAKER_RUN_STATUSES, type RunStatusValue } from '../domain/status.js';

/**
 * Opens after `threshold` consecutive `error` or `unknown` runs; closes by hand or after
 * `cooldownMinutes` (`0` means only by hand). Runs finished before the last reset don't count.
 */

export interface BreakerState {
  state: 'open' | 'closed';
  openedAt: Date | null;
}

/** `ok` ends the streak; `failed` (a refused invoke) and `held` neither count nor end it. */
export function consecutiveFailures(newestFirst: readonly RunStatusValue[]): number {
  let n = 0;
  for (const status of newestFirst) {
    if (BREAKER_RUN_STATUSES.includes(status)) n++;
    else if (status === 'ok') break;
  }
  return n;
}

export type BreakerTransition = 'opened' | 'closed_cooldown' | null;

export function breakerAfterRun(
  current: BreakerState,
  newestFirst: readonly RunStatusValue[],
  threshold: number,
  now: Date,
): { next: BreakerState; transition: BreakerTransition; failures: number } {
  const failures = consecutiveFailures(newestFirst);
  if (current.state === 'closed' && threshold > 0 && failures >= threshold) {
    return { next: { state: 'open', openedAt: now }, transition: 'opened', failures };
  }
  return { next: current, transition: null, failures };
}

export function breakerAtGate(
  current: BreakerState,
  cooldownMinutes: number,
  now: Date,
): { next: BreakerState; transition: BreakerTransition } {
  if (current.state !== 'open') return { next: current, transition: null };
  if (cooldownMinutes <= 0 || current.openedAt === null) return { next: current, transition: null };
  if (now.getTime() >= current.openedAt.getTime() + cooldownMinutes * 60_000) {
    return { next: { state: 'closed', openedAt: null }, transition: 'closed_cooldown' };
  }
  return { next: current, transition: null };
}

export function breakerClosesAt(current: BreakerState, cooldownMinutes: number): Date | null {
  if (current.state !== 'open' || current.openedAt === null || cooldownMinutes <= 0) return null;
  return new Date(current.openedAt.getTime() + cooldownMinutes * 60_000);
}
