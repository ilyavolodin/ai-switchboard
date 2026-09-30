import { isOneOf } from '@ai-switchboard/sdk';

import {
  FAILED_RUN_STATUSES,
  HELD_BATCH_OUTCOMES,
  STOPPED_BATCH_OUTCOMES,
  type BatchOutcome,
  type RunStatusValue,
} from '../../domain/status.js';

/** Runs that ended badly: the backend failed or refused them, or they settled as unknown. */
export const PROBLEM_RUN_STATUSES = [
  ...FAILED_RUN_STATUSES,
  'unknown',
] as const satisfies readonly RunStatusValue[];

/** Batches that got past the gates: invoked, or merged into a sweep that was. */
export const PASSED_BATCH_OUTCOMES = [
  'invoked',
  'merged',
] as const satisfies readonly BatchOutcome[];

const IN_FLIGHT_RUN_STATUSES = ['invoking', 'running'] as const satisfies readonly RunStatusValue[];

const UNSETTLED_RUN_STATUSES = [
  'unknown',
  'uncertain',
] as const satisfies readonly RunStatusValue[];

export interface BatchCounts {
  total: number;
  /** A gate stopped it or a person rejected it (`HELD_BATCH_OUTCOMES`). */
  held: number;
  throttled: number;
  /** Waiting for the next sweep (`STOPPED_BATCH_OUTCOMES`). */
  stopped: number;
  passed: number;
}

export interface RunCounts {
  total: number;
  ok: number;
  error: number;
  failed: number;
  /** Settled as unknown, or still uncertain. */
  unknown: number;
  running: number;
  /** `PROBLEM_RUN_STATUSES`. */
  problem: number;
}

function sumWhere<T extends { n: number }>(rows: readonly T[], keep: (row: T) => boolean): number {
  let total = 0;
  for (const row of rows) if (keep(row)) total += row.n;
  return total;
}

/** Counted batch rows (`{ outcome, n }`) folded into the numbers every view shows. */
export function classifyBatches(
  rows: readonly { outcome: BatchOutcome; n: number }[],
): BatchCounts {
  return {
    total: sumWhere(rows, () => true),
    held: sumWhere(rows, (r) => isOneOf(HELD_BATCH_OUTCOMES, r.outcome)),
    throttled: sumWhere(rows, (r) => r.outcome === 'throttled'),
    stopped: sumWhere(rows, (r) => isOneOf(STOPPED_BATCH_OUTCOMES, r.outcome)),
    passed: sumWhere(rows, (r) => isOneOf(PASSED_BATCH_OUTCOMES, r.outcome)),
  };
}

/** Counted run rows (`{ status, n }`) folded into the numbers every view shows. */
export function classifyRuns(rows: readonly { status: RunStatusValue; n: number }[]): RunCounts {
  return {
    total: sumWhere(rows, () => true),
    ok: sumWhere(rows, (r) => r.status === 'ok'),
    error: sumWhere(rows, (r) => r.status === 'error'),
    failed: sumWhere(rows, (r) => r.status === 'failed'),
    unknown: sumWhere(rows, (r) => isOneOf(UNSETTLED_RUN_STATUSES, r.status)),
    running: sumWhere(rows, (r) => isOneOf(IN_FLIGHT_RUN_STATUSES, r.status)),
    problem: sumWhere(rows, (r) => isOneOf(PROBLEM_RUN_STATUSES, r.status)),
  };
}
