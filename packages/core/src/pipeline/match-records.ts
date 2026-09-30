import type { MatchDecisionRecord } from '../db/schema.js';
import type { KeyOutcome } from '../expr/index.js';

import type { FilterEvaluation, SkippedTrigger } from './match.js';

/**
 * What the event records about every trigger on its source: each evaluated filter (with the
 * batch key a match produced), then each trigger that was not evaluated and why.
 */
export function matchRecords(
  evaluations: readonly FilterEvaluation[],
  keys: ReadonlyMap<string, KeyOutcome>,
  skipped: readonly SkippedTrigger[],
  now: Date,
): MatchDecisionRecord[] {
  const at = now.toISOString();
  const records: MatchDecisionRecord[] = evaluations.map((e) => {
    const key = e.result ? keys.get(e.processId) : undefined;
    return {
      processId: e.processId,
      triggerId: e.triggerId,
      ...(e.filter !== undefined ? { expr: e.filter } : {}),
      result: e.result,
      ...(e.error !== undefined
        ? { error: e.error }
        : key?.error !== undefined
          ? { error: `groupBy: ${key.error}` }
          : {}),
      ...(key ? { batchKey: key.key } : {}),
      at,
    };
  });
  for (const k of skipped) {
    records.push({
      processId: k.processId,
      triggerId: k.triggerId,
      result: false,
      skip: k.skip,
      at,
    });
  }
  return records;
}
