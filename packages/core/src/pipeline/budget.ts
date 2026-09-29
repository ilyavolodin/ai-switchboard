import type { UsageDimension } from '@ai-switchboard/sdk';

import type { MeterCeiling } from '../domain/process.js';
import type { BatchKind, BindingLimit } from '../domain/status.js';

import { isFresh } from './meters.js';

/**
 * Check order: process run caps, destination caps, meter ceilings (event batches against
 * `events`, sweeps and manual runs against `sweeps`; a missing or stale reading skips the ceiling and
 * reports `meter_stale`), usage caps, the destination's soft-hold. The first failing check is
 * the binding limit. Counters are rolling windows (last 60 minutes, last 24 hours).
 */

export interface BudgetCounters {
  processRunsHour: number;
  processRunsDay: number;
  destinationRunsHour: number;
  destinationRunsDay: number;
  processUsageDay: Record<string, number>;
  destinationUsageDay: Record<string, number>;
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
  destination: {
    runsPerHour?: number | undefined;
    runsPerDay?: number | undefined;
    usagePerDay?: Record<string, number> | undefined;
    softHoldUntil: Date | null;
    stalenessMinutes: number;
  };
  counters: BudgetCounters;
  dimensions: readonly UsageDimension[];
  meters: Record<string, MeterSnapshot | undefined>;
}

export type BudgetWindow = 'hour' | 'day' | 'meter';

export interface BudgetCheck {
  check: string;
  pass: boolean;
  used?: number;
  limit?: number;
  detail?: string;
  window?: BudgetWindow;
}

export interface BudgetResult {
  ok: boolean;
  binding: BindingLimit | null;
  detail: string | null;
  checks: BudgetCheck[];
  meterStale: string[];
}

interface RunCap {
  check: BindingLimit;
  used: number;
  limit: number | undefined;
  noun: string;
  window: 'hour' | 'day';
}

const WINDOW_TEXT: Record<RunCap['window'], string> = {
  hour: 'the last hour',
  day: 'the last 24 h',
};

export function budget(input: BudgetInput, now: Date): BudgetResult {
  const checks: BudgetCheck[] = [];
  const failures: { binding: BindingLimit; detail: string }[] = [];
  const meterStale: string[] = [];
  const fail = (binding: BindingLimit, detail: string): void => {
    failures.push({ binding, detail });
  };
  const c = input.counters;

  const runCaps: RunCap[] = [
    {
      check: 'runs_per_hour',
      used: c.processRunsHour,
      limit: input.process.runsPerHour,
      noun: 'runs',
      window: 'hour',
    },
    {
      check: 'runs_per_day',
      used: c.processRunsDay,
      limit: input.process.runsPerDay,
      noun: 'runs',
      window: 'day',
    },
    {
      check: 'destination_runs_per_hour',
      used: c.destinationRunsHour,
      limit: input.destination.runsPerHour,
      noun: 'destination runs',
      window: 'hour',
    },
    {
      check: 'destination_runs_per_day',
      used: c.destinationRunsDay,
      limit: input.destination.runsPerDay,
      noun: 'destination runs',
      window: 'day',
    },
  ];
  for (const cap of runCaps) {
    if (cap.limit === undefined) continue;
    // The reservation adds one run, so a cap of N admits the Nth run and throttles the next.
    const pass = cap.used < cap.limit;
    checks.push({ check: cap.check, pass, used: cap.used, limit: cap.limit, window: cap.window });
    if (!pass)
      fail(cap.check, `${cap.used}/${cap.limit} ${cap.noun} in ${WINDOW_TEXT[cap.window]}`);
  }

  const ceilingKind = input.kind === 'event' ? 'events' : 'sweeps';
  for (const [meterId, ceiling] of Object.entries(input.process.meterCeilings)) {
    const limit = ceiling[ceilingKind];
    const reading = input.meters[meterId];
    const check = `meter:${meterId}`;
    if (!reading || !isFresh(reading.observedAt, now, input.destination.stalenessMinutes)) {
      meterStale.push(meterId);
      checks.push({
        check,
        pass: true,
        limit,
        window: 'meter',
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
      window: 'meter',
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
    scope: 'usage_per_day' | 'destination_usage_per_day',
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
      checks.push({ check, pass, used: value, limit: cap, detail: spec.unit, window: 'day' });
      if (!pass) fail(`${scope}:${dim}`, `${value}/${cap} ${spec.unit} in the last 24 h`);
    }
  };
  usageCaps(input.process.usagePerDay, c.processUsageDay, 'usage_per_day');
  usageCaps(input.destination.usagePerDay, c.destinationUsageDay, 'destination_usage_per_day');

  const hold = input.destination.softHoldUntil;
  const held = hold !== null && hold.getTime() > now.getTime();
  checks.push({
    check: 'soft_hold',
    pass: !held,
    ...(hold !== null ? { detail: `until ${hold.toISOString()}` } : {}),
  });
  if (held) fail('soft_hold', `destination soft-held until ${hold.toISOString()}`);

  const first = failures[0];
  return {
    ok: first === undefined,
    binding: first?.binding ?? null,
    detail: first?.detail ?? null,
    checks,
    meterStale,
  };
}
