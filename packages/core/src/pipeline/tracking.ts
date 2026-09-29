import type { RunStatus } from '@ai-switchboard/sdk';

import type { RunStatusValue } from '../domain/status.js';

export const POLL_BACKOFF_SECONDS = [30, 60, 120, 300] as const;
/**
 * How long a run may wait in `invoking` with no attempt in flight before recovery resumes it;
 * also the staleness of an attempt with no recorded deadline (rows from before invoke deadlines).
 */
export const INVOKING_STALE_SECONDS = 60;

export function pollDelaySeconds(pollCount: number): number {
  return POLL_BACKOFF_SECONDS[Math.max(0, pollCount)] ?? 300;
}

/** Never after the deadline: the deadline check runs then instead. */
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
  invokeDeadlineAt: Date | null;
  createdAt: Date;
  /** Stored in `next_poll_at` while invoking. */
  retryAt: Date | null;
}

export type RecoveryAction = 'uncertain' | 'reinvoke' | 'resume' | null;

/**
 * An attempt still inside its deadline may be waiting on a slow backend, so it is left alone. A
 * run whose attempt never started (or whose retry is overdue) lost its job and is resumed.
 */
export function recoverInvoking(run: InvokingRun, idempotent: boolean, now: Date): RecoveryAction {
  if (run.status !== 'invoking') return null;
  const cutoff = now.getTime() - INVOKING_STALE_SECONDS * 1000;
  if (run.invokeStartedAt !== null) {
    const stale =
      run.invokeDeadlineAt !== null
        ? now.getTime() >= run.invokeDeadlineAt.getTime()
        : run.invokeStartedAt.getTime() <= cutoff;
    if (!stale) return null;
    return idempotent ? 'reinvoke' : 'uncertain';
  }
  return (run.retryAt ?? run.createdAt).getTime() <= cutoff ? 'resume' : null;
}
