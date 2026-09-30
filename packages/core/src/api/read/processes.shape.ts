import type { PipelineDots } from '../../contract/index.js';
import type { BatchOutcome, RunStatusValue, StatusTone } from '../../domain/status.js';
import { groupBy } from '../../util/collections.js';
import { DAY_MS } from '../../util/time.js';
import { classifyBatches, classifyRuns } from './outcomes.js';
import { timeBuckets } from './stats.shape.js';

export interface HourCounts {
  matched: number;
  batched: number;
  passed: number;
  stopped: number;
  invoked: number;
  ok: number;
  bad: number;
}

export const NO_HOUR_COUNTS: HourCounts = {
  matched: 0,
  batched: 0,
  passed: 0,
  stopped: 0,
  invoked: 0,
  ok: 0,
  bad: 0,
};

/** The last hour of one process's dispatches, batches and runs, as counted rows. */
export function hourCountsFrom(
  dispatchRows: readonly { outcome: string; n: number }[],
  batchRows: readonly { outcome: BatchOutcome; n: number }[],
  runRows: readonly { status: RunStatusValue; n: number }[],
): HourCounts {
  const b = classifyBatches(batchRows);
  const r = classifyRuns(runRows);
  return {
    matched: dispatchRows.reduce((a, d) => a + d.n, 0),
    batched: dispatchRows.filter((d) => d.outcome === 'batched').reduce((a, d) => a + d.n, 0),
    passed: b.passed,
    stopped: b.stopped,
    invoked: r.total,
    ok: r.ok,
    bad: r.problem,
  };
}

/** The same, per process: every id gets an entry, zero when it had nothing. */
export function hourCountsByProcess(
  ids: readonly string[],
  dispatchRows: readonly { processId: string; outcome: string; n: number }[],
  batchRows: readonly { processId: string; outcome: BatchOutcome; n: number }[],
  runRows: readonly { processId: string; status: RunStatusValue; n: number }[],
): Map<string, HourCounts> {
  const d = groupBy(dispatchRows, (x) => x.processId);
  const b = groupBy(batchRows, (x) => x.processId);
  const r = groupBy(runRows, (x) => x.processId);
  return new Map(
    ids.map((id) => [id, hourCountsFrom(d.get(id) ?? [], b.get(id) ?? [], r.get(id) ?? [])]),
  );
}

function tone(n: number): StatusTone {
  return n > 0 ? 'ok' : 'off';
}

export function dotsFrom(c: HourCounts): PipelineDots {
  return {
    matched: c.matched,
    batched: c.batched,
    gated: c.passed,
    invoked: c.invoked,
    ok: c.ok,
    tones: [
      tone(c.matched),
      tone(c.batched),
      c.stopped > 0 ? 'warn' : tone(c.passed),
      tone(c.invoked),
      c.bad > 0 ? 'error' : tone(c.ok),
    ],
  };
}

/** Runs per UTC day for the last seven days, oldest first, from `{ day, n }` rows. */
export function sparklineFrom(rows: readonly { day: string; n: number }[], now: Date): number[] {
  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  return timeBuckets(new Date(now.getTime() - 6 * DAY_MS), now, 'day').map(
    (day) => byDay.get(day) ?? 0,
  );
}
