import { isOneOf } from '@ai-switchboard/sdk';

import {
  BREAKER_RUN_STATUSES,
  type BreakerStateValue,
  type RunStatusValue,
} from '../domain/status.js';

/**
 * Opens after `threshold` consecutive `error` or `unknown` runs; closes by hand or after
 * `cooldownMinutes` (`0` means only by hand). Runs finished before the last reset don't count.
 */

export interface BreakerState {
  state: BreakerStateValue;
  openedAt: Date | null;
}

/** `ok` ends the streak; `failed` (a refused invoke) and `held` neither count nor end it. */
export function consecutiveFailures(newestFirst: readonly RunStatusValue[]): number {
  let n = 0;
  for (const status of newestFirst) {
    if (isOneOf(BREAKER_RUN_STATUSES, status)) n++;
    else if (status === 'ok') break;
  }
  return n;
}

export type BreakerTransition = 'opened' | 'closed_cooldown' | null;

/** Evaluated only while the breaker is closed; an open one stays open until reset or cooldown. */
export function breakerOpensAfterRun(
  newestFirst: readonly RunStatusValue[],
  threshold: number,
): { opens: boolean; failures: number } {
  const failures = consecutiveFailures(newestFirst);
  return { opens: threshold > 0 && failures >= threshold, failures };
}

/** How many recent settled runs to read so a streak of `threshold` is always visible. */
export function breakerHistoryLimit(threshold: number): number {
  return Math.max(threshold * 4, 50);
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
