import type { MeterSpec } from '@ai-switchboard/sdk';

/**
 * Meter arithmetic: freshness, estimated readings from the core's own run counts, and ceiling
 * crossings for the system alert.
 */

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
  return now.getTime() - observedAt.getTime() <= stalenessMinutes * 60_000;
}

export type EstimatePeriod = 'day' | 'hour' | 'week';

/** The UTC calendar period containing `now` (an estimated allowance resets at its end). */
export function periodBounds(period: EstimatePeriod, now: Date): { start: Date; end: Date } {
  const d = new Date(now.getTime());
  if (period === 'hour') {
    d.setUTCMinutes(0, 0, 0);
    return { start: d, end: new Date(d.getTime() + 3_600_000) };
  }
  d.setUTCHours(0, 0, 0, 0);
  if (period === 'day') return { start: d, end: new Date(d.getTime() + 86_400_000) };
  // ISO week: Monday 00:00 UTC.
  const back = (d.getUTCDay() + 6) % 7;
  const start = new Date(d.getTime() - back * 86_400_000);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

/** The limit an estimated meter counts against: typed-in, or the spec's default. */
export function estimatedLimit(
  spec: MeterSpec,
  typedIn: Record<string, number> | undefined,
): number | undefined {
  const own = typedIn?.[spec.id];
  if (own !== undefined && own > 0) return own;
  const fallback = spec.estimate?.defaultLimit;
  return fallback !== undefined && fallback > 0 ? fallback : undefined;
}

/** Is this meter estimated by the core (declared `estimate`, or given a typed-in limit)? */
export function isEstimatedMeter(
  spec: MeterSpec,
  typedIn: Record<string, number> | undefined,
): boolean {
  return spec.estimate !== undefined || typedIn?.[spec.id] !== undefined;
}

/** An estimated reading: runs counted in the period against the limit. */
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

/** Clamp a plugin-reported utilization into 0–100; non-numbers are rejected. */
export function normaliseUtilization(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** True when a new reading crosses `ceiling` from below (or is the first reading above it). */
export function ceilingCrossed(
  previous: number | undefined,
  next: number,
  ceiling: number,
): boolean {
  return next >= ceiling && (previous === undefined || previous < ceiling);
}
