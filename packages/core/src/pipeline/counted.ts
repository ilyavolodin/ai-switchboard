import type { RunStatusValue } from '../domain/status.js';

export interface CountableRun {
  status: RunStatusValue;
  attempts: number;
  dryRun: boolean;
}

/**
 * Failed with no attempt: input mapping or a `before` step failed it, so nothing reached the
 * backend. Such a run has no `after` phase and does not count toward budgets.
 */
export function neverInvoked(run: Pick<CountableRun, 'status' | 'attempts'>): boolean {
  return run.status === 'failed' && run.attempts === 0;
}

/** `countedRun()` in `services/pipeline/counters.ts` is the SQL form of this rule. */
export function countsTowardBudget(run: CountableRun): boolean {
  return !run.dryRun && run.status !== 'held' && !neverInvoked(run);
}
