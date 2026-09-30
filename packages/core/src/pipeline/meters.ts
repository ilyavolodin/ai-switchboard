import type { MeterReading, MeterSpec } from '@ai-switchboard/sdk';

import { addDays, addMs, HOUR_MS, MINUTE_MS } from '../util/time.js';

export interface StoredReading {
  meterId: string;
  utilization: number;
  used: number | null;
  limit: number | null;
  observedAt: Date;
  resetsAt: Date | null;
  estimated: boolean;
}

export function isFresh(observedAt: Date, now: Date, stalenessMinutes: number): boolean {
  return now.getTime() - observedAt.getTime() <= stalenessMinutes * MINUTE_MS;
}

export type EstimatePeriod = 'day' | 'hour' | 'week';

/** UTC calendar periods; an estimated allowance resets at the period's end. */
export function periodBounds(period: EstimatePeriod, now: Date): { start: Date; end: Date } {
  const d = new Date(now.getTime());
  if (period === 'hour') {
    d.setUTCMinutes(0, 0, 0);
    return { start: d, end: addMs(d, HOUR_MS) };
  }
  d.setUTCHours(0, 0, 0, 0);
  if (period === 'day') return { start: d, end: addDays(d, 1) };
  // ISO week: Monday 00:00 UTC.
  const start = addDays(d, -((d.getUTCDay() + 6) % 7));
  return { start, end: addDays(start, 7) };
}

export function estimatedLimit(
  spec: MeterSpec,
  typedIn: Record<string, number> | undefined,
): number | undefined {
  const own = typedIn?.[spec.id];
  if (own !== undefined && own > 0) return own;
  const fallback = spec.estimate?.defaultLimit;
  return fallback !== undefined && fallback > 0 ? fallback : undefined;
}

export function isEstimatedMeter(
  spec: MeterSpec,
  typedIn: Record<string, number> | undefined,
): boolean {
  return spec.estimate !== undefined || typedIn?.[spec.id] !== undefined;
}

export function estimateReading(
  meterId: string,
  limit: number,
  runsInPeriod: number,
  period: EstimatePeriod,
  now: Date,
): StoredReading {
  const { end } = periodBounds(period, now);
  const utilization = limit > 0 ? Math.min(100, (runsInPeriod / limit) * 100) : 100;
  return {
    meterId,
    utilization: Math.round(utilization * 100) / 100,
    used: runsInPeriod,
    limit,
    observedAt: now,
    resetsAt: end,
    estimated: true,
  };
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A missing, unparseable or future `observedAt` becomes `now`: a reading from the future would
 * stay the latest one, and fresh, until that time came.
 */
export function readingFromReport(
  item: unknown,
  declared: ReadonlySet<string>,
  now: Date,
): StoredReading | null {
  if (item === null || typeof item !== 'object') return null;
  const r = item as Partial<Record<keyof MeterReading, unknown>>;
  if (typeof r.id !== 'string' || !declared.has(r.id)) return null;
  const utilization = normaliseUtilization(r.utilization);
  if (utilization === null) return null;
  const observed = parseTime(r.observedAt);
  return {
    meterId: r.id,
    utilization,
    used: typeof r.used === 'number' ? r.used : null,
    limit: typeof r.limit === 'number' ? r.limit : null,
    observedAt: observed && observed.getTime() <= now.getTime() ? observed : now,
    resetsAt: parseTime(r.resetsAt),
    estimated: false,
  };
}

export function normaliseUtilization(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

export function ceilingCrossed(
  previous: number | undefined,
  next: number,
  ceiling: number,
): boolean {
  return next >= ceiling && (previous === undefined || previous < ceiling);
}
