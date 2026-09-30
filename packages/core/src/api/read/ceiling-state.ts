import type { MeterCeiling } from '../../domain/process.js';
import { budget, type MeterSnapshot } from '../../pipeline/budget.js';
import type { CeilingState } from '../../contract/index.js';

const NO_COUNTERS = {
  processRunsHour: 0,
  processRunsDay: 0,
  destinationRunsHour: 0,
  destinationRunsDay: 0,
  processUsageDay: {},
  destinationUsageDay: {},
};

/**
 * Asks the budget stage about an event batch against each process's ceiling on this meter alone,
 * so the gauge says exactly what dispatch would decide now.
 */
export function ceilingState(
  meterId: string,
  ceilings: readonly MeterCeiling[],
  reading: MeterSnapshot | undefined,
  stalenessMinutes: number,
  now: Date,
): CeilingState {
  let throttling = false;
  for (const ceiling of ceilings) {
    const result = budget(
      {
        kind: 'event',
        process: { meterCeilings: { [meterId]: ceiling } },
        destination: { softHoldUntil: null, stalenessMinutes },
        counters: NO_COUNTERS,
        dimensions: [],
        meters: { [meterId]: reading },
      },
      now,
    );
    if (result.meterStale.includes(meterId)) return 'stale';
    if (!result.ok) throttling = true;
  }
  return throttling ? 'throttling' : 'below';
}
