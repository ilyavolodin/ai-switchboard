import type { GateDecisionRecord } from '../db/schema.js';

import type { BudgetCounters, BudgetResult, MeterSnapshot } from './budget.js';
import type { GateCheck } from './gate.js';

const DETAIL_LIMIT = 1000;

function withDetail(detail: string | null | undefined): { detail?: string } {
  return detail !== undefined && detail !== null ? { detail } : {};
}

/** A batch lifecycle step (`open`, `close`, `merged`, `sweep`, `manual`, …): never a refusal. */
export function batchRecord(check: string, at: Date, detail?: string): GateDecisionRecord {
  return { stage: 'batch', check, pass: true, ...withDetail(detail), at: at.toISOString() };
}

export function processDeletedRecord(detail: string, at: Date): GateDecisionRecord {
  return { stage: 'batch', check: 'process_deleted', pass: false, detail, at: at.toISOString() };
}

export function gateRecord(c: GateCheck, at: Date): GateDecisionRecord {
  return {
    stage: 'gate',
    check: c.check,
    pass: c.pass,
    ...withDetail(c.detail),
    at: at.toISOString(),
  };
}

export function approvalRecord(
  decision: 'approved' | 'rejected',
  detail: string,
  at: Date,
): GateDecisionRecord {
  return {
    stage: 'approval',
    check: decision,
    pass: decision === 'approved',
    detail,
    at: at.toISOString(),
  };
}

/** The input mapping failed validation: recorded at the budget stage, before anything is spent. */
export function inputInvalidRecord(errors: readonly string[], at: Date): GateDecisionRecord {
  return {
    stage: 'budget',
    check: 'input',
    pass: false,
    detail: `input_invalid: ${errors.join('; ')}`.slice(0, DETAIL_LIMIT),
    at: at.toISOString(),
  };
}

export function dryRunBudgetRecord(at: Date): GateDecisionRecord {
  return {
    stage: 'budget',
    check: 'budget',
    pass: true,
    detail: 'dry run: not counted',
    at: at.toISOString(),
  };
}

/** The budget check with the counters and meter readings it saw. */
export function budgetRecord(
  result: BudgetResult,
  counters: BudgetCounters,
  meters: Record<string, MeterSnapshot>,
  at: Date,
): GateDecisionRecord {
  return {
    stage: 'budget',
    check: 'budget',
    pass: result.ok,
    ...withDetail(result.detail),
    at: at.toISOString(),
    data: {
      binding: result.binding,
      checks: result.checks,
      counters,
      meters: Object.fromEntries(
        Object.entries(meters).map(([id, m]) => [
          id,
          {
            utilization: m.utilization,
            observedAt: m.observedAt.toISOString(),
            estimated: m.estimated,
            resetsAt: m.resetsAt?.toISOString() ?? null,
          },
        ]),
      ),
      meterStale: result.meterStale,
    },
  };
}
