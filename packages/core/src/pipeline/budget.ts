import type { UsageDimension } from '@ai-switchboard/sdk';

import type { MeterCeiling } from '../domain/process.js';
import type { BatchKind, BindingLimit } from '../domain/status.js';

import { isFresh } from './meters.js';

/**
 * Stage 6, budget. Checks, in order: per-process hourly and daily run caps; per-executor-instance
 * caps; meter ceilings (event batches against `events`, sweeps and manual runs against `sweeps`,
 * on the latest reading while fresh, otherwise counters only and `meter_stale`); usage caps on
 * budgetable dimensions from reported usage; the executor's soft-hold. The first failing check is
 * the binding limit. Counters are rolling windows (last 60 minutes, last 24 hours).
 */

export interface BudgetCounters {
  processRunsHour: number;
  processRunsDay: number;
  executorRunsHour: number;
  executorRunsDay: number;
  processUsageDay: Record<string, number>;
  executorUsageDay: Record<string, number>;
}

export interface MeterSnapshot {
  utilization: number;
  observedAt: Date;
  estimated: boolean;
  resetsAt: Date | null;
}

export interface BudgetInput {
  kind: BatchKind;
  process: {
    runsPerHour?: number | undefined;
    runsPerDay?: number | undefined;
    usagePerDay?: Record<string, number> | undefined;
    meterCeilings: Record<string, MeterCeiling>;
  };
  executor: {
    runsPerHour?: number | undefined;
    runsPerDay?: number | undefined;
    usagePerDay?: Record<string, number> | undefined;
    softHoldUntil: Date | null;
    stalenessMinutes: number;
  };
  counters: BudgetCounters;
  dimensions: readonly UsageDimension[];
  /** Latest reading per meter id. */
  meters: Record<string, MeterSnapshot | undefined>;
}

export interface BudgetCheck {
  check: string;
  pass: boolean;
  used?: number;
  limit?: number;
  detail?: string;
}

export interface BudgetResult {
  ok: boolean;
  binding: BindingLimit | null;
  detail: string | null;
  checks: BudgetCheck[];
  /** Meters whose ceiling could not be enforced because the reading is missing or stale. */
  meterStale: string[];
}

function capCheck(
  checks: BudgetCheck[],
  check: string,
  used: number,
  limit: number | undefined,
): boolean {
  if (limit === undefined) return true;
  // The reservation adds one run, so a cap of N admits the Nth run and throttles the next.
  const pass = used < limit;
  checks.push({ check, pass, used, limit });
  return pass;
}

export function budget(input: BudgetInput, now: Date): BudgetResult {
  const checks: BudgetCheck[] = [];
  const failures: { binding: BindingLimit; detail: string }[] = [];
  const meterStale: string[] = [];
  const fail = (binding: BindingLimit, detail: string): void => {
    failures.push({ binding, detail });
  };
  const c = input.counters;

  if (!capCheck(checks, 'runs_per_hour', c.processRunsHour, input.process.runsPerHour)) {
    fail(
      'runs_per_hour',
      `${c.processRunsHour}/${input.process.runsPerHour} runs in the last hour`,
    );
  }
  if (!capCheck(checks, 'runs_per_day', c.processRunsDay, input.process.runsPerDay)) {
    fail('runs_per_day', `${c.processRunsDay}/${input.process.runsPerDay} runs in the last 24 h`);
  }
  if (!capCheck(checks, 'executor_runs_per_hour', c.executorRunsHour, input.executor.runsPerHour)) {
    fail(
      'executor_runs_per_hour',
      `${c.executorRunsHour}/${input.executor.runsPerHour} executor runs in the last hour`,
    );
  }
  if (!capCheck(checks, 'executor_runs_per_day', c.executorRunsDay, input.executor.runsPerDay)) {
    fail(
      'executor_runs_per_day',
      `${c.executorRunsDay}/${input.executor.runsPerDay} executor runs in the last 24 h`,
    );
  }

  const ceilingKind = input.kind === 'event' ? 'events' : 'sweeps';
  for (const [meterId, ceiling] of Object.entries(input.process.meterCeilings)) {
    const limit = ceiling[ceilingKind];
    const reading = input.meters[meterId];
    const check = `meter:${meterId}`;
    if (!reading || !isFresh(reading.observedAt, now, input.executor.stalenessMinutes)) {
      meterStale.push(meterId);
      checks.push({
        check,
        pass: true,
        limit,
        ...(reading ? { used: reading.utilization } : {}),
        detail: reading
          ? `meter_stale: last read ${reading.observedAt.toISOString()}`
          : 'meter_stale: no reading',
      });
      continue;
    }
    const pass = reading.utilization < limit;
    checks.push({
      check,
      pass,
      used: reading.utilization,
      limit,
      detail: `${ceilingKind} ceiling${reading.estimated ? ' (estimated)' : ''}`,
    });
    if (!pass) {
      fail(
        `meter:${meterId}`,
        `${meterId} at ${reading.utilization}% ≥ ${ceilingKind} ceiling ${limit}%` +
          (reading.resetsAt ? `, resets ${reading.resetsAt.toISOString()}` : ''),
      );
    }
  }

  const budgetable = new Map(input.dimensions.map((d) => [d.id, d]));
  const usageCaps = (
    caps: Record<string, number> | undefined,
    used: Record<string, number>,
    scope: 'usage_per_day' | 'executor_usage_per_day',
  ): void => {
    for (const [dim, cap] of Object.entries(caps ?? {})) {
      const spec = budgetable.get(dim);
      const check = `${scope}:${dim}`;
      if (!spec?.budgetable) {
        checks.push({
          check,
          pass: true,
          limit: cap,
          detail: 'not a budgetable dimension; ignored',
        });
        continue;
      }
      const value = used[dim] ?? 0;
      const pass = value < cap;
      checks.push({ check, pass, used: value, limit: cap, detail: spec.unit });
      if (!pass) fail(`${scope}:${dim}`, `${value}/${cap} ${spec.unit} in the last 24 h`);
    }
  };
  usageCaps(input.process.usagePerDay, c.processUsageDay, 'usage_per_day');
  usageCaps(input.executor.usagePerDay, c.executorUsageDay, 'executor_usage_per_day');

  const hold = input.executor.softHoldUntil;
  const held = hold !== null && hold.getTime() > now.getTime();
  checks.push({
    check: 'soft_hold',
    pass: !held,
    ...(hold !== null ? { detail: `until ${hold.toISOString()}` } : {}),
  });
  if (held) fail('soft_hold', `executor soft-held until ${hold.toISOString()}`);

  const first = failures[0];
  return {
    ok: first === undefined,
    binding: first?.binding ?? null,
    detail: first?.detail ?? null,
    checks,
    meterStale,
  };
}
