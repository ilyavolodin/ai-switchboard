import type { MeterReading } from './types/destination.js';

export type MeterReadingInput =
  | { id: string; used: number; limit: number; resetsAt?: string; observedAt: string }
  | { id: string; utilization: number; resetsAt?: string; observedAt: string };

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/** A reading with `utilization` clamped to 0–100, computed from `used / limit` when given. */
export function meterReading(input: MeterReadingInput): MeterReading {
  const resetsAt = input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {};
  if ('used' in input) {
    return {
      id: input.id,
      used: input.used,
      limit: input.limit,
      utilization: clampPercent(input.limit > 0 ? (input.used / input.limit) * 100 : 100),
      ...resetsAt,
      observedAt: input.observedAt,
    };
  }
  return {
    id: input.id,
    utilization: clampPercent(input.utilization),
    ...resetsAt,
    observedAt: input.observedAt,
  };
}
