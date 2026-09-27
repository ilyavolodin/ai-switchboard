import type { RunStatus } from '@ai-switchboard/sdk';

import type { RunStatusValue } from '../domain/status.js';

/**
 * Stage 7b, tracking. Poll on backoff (30 s, 1 min, 2 min, 5 min, then every 5 min) until a
 * terminal state or the deadline; the deadline moves an open run to `unknown`. After a restart,
 * an `invoking` run whose attempt started more than 60 s ago is `uncertain`.
 */

export const POLL_BACKOFF_SECONDS = [30, 60, 120, 300] as const;
export const INVOKING_STALE_SECONDS = 60;

/** Delay before poll number `pollCount + 1`. */
export function pollDelaySeconds(pollCount: number): number {
  return POLL_BACKOFF_SECONDS[Math.max(0, pollCount)] ?? 300;
}

/** When to poll next; never after the deadline (the deadline check runs then instead). */
export function nextPollAt(
  from: Date,
  pollCount: number,
  deadline: Date,
): { at: Date; atDeadline: boolean } {
  const at = from.getTime() + pollDelaySeconds(pollCount) * 1000;
  if (at >= deadline.getTime()) return { at: deadline, atDeadline: true };
  return { at: new Date(at), atDeadline: false };
}

export function trackingDeadline(invokedAt: Date, deadlineMinutes: number): Date {
  return new Date(invokedAt.getTime() + Math.max(1, deadlineMinutes) * 60_000);
}

export function deadlinePassed(deadline: Date | null, now: Date): boolean {
  return deadline !== null && now.getTime() >= deadline.getTime();
}

/** Map a tracking report to a run status. */
export function statusFromTracking(state: RunStatus['state']): RunStatusValue {
  switch (state) {
    case 'running':
      return 'running';
    case 'ok':
      return 'ok';
    case 'error':
      return 'error';
    case 'unknown':
      return 'unknown';
    default:
      return 'running';
  }
}

export interface InvokingRun {
  status: RunStatusValue;
  invokeStartedAt: Date | null;
  createdAt: Date;
  /** When a waiting retry is due (stored in `next_poll_at` while invoking). */
  retryAt: Date | null;
}

export type RecoveryAction = 'uncertain' | 'reinvoke' | 'resume' | null;

/**
 * What to do with an `invoking` run found by recovery:
 * - an attempt in flight for more than 60 s: `uncertain` (non-idempotent) or `reinvoke`
 *   (idempotent: retry with the same run id);
 * - a run whose attempt never started (or whose retry is overdue) for more than 60 s, because its
 *   job was lost: `resume`.
 */
export function recoverInvoking(run: InvokingRun, idempotent: boolean, now: Date): RecoveryAction {
  if (run.status !== 'invoking') return null;
  const cutoff = now.getTime() - INVOKING_STALE_SECONDS * 1000;
  if (run.invokeStartedAt !== null) {
    if (run.invokeStartedAt.getTime() > cutoff) return null;
    return idempotent ? 'reinvoke' : 'uncertain';
  }
  return (run.retryAt ?? run.createdAt).getTime() <= cutoff ? 'resume' : null;
}
