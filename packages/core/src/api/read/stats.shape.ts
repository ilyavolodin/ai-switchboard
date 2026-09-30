import type { MeterSpec, UsageDimension } from '@ai-switchboard/sdk';

import type {
  FunnelResponse,
  MeterGaugeDTO,
  MeterHistoryResponse,
  ProcessStatsResponse,
  SourceStatsResponse,
  SourceSummary,
  UsageHistoryResponse,
} from '../../contract/index.js';
import { runStatusLabel } from '../../domain/labels.js';
import type {
  BatchKind,
  BatchOutcome,
  EventStage,
  RunStatusValue,
  StatsWindow,
} from '../../domain/status.js';
import { groupBy } from '../../util/collections.js';
import { DAY_MS, HOUR_MS } from '../../util/time.js';
import { classifyBatches, classifyRuns } from './outcomes.js';

const WINDOW_DAYS: Record<StatsWindow, number> = { '24h': 1, '7d': 7, '30d': 30 };

export function windowMs(window: StatsWindow): number {
  return WINDOW_DAYS[window] * DAY_MS;
}

/** Views with one bucket per day cover at least a week. */
export function dailyWindow(window: StatsWindow): StatsWindow {
  return window === '24h' ? '7d' : window;
}

export type BucketUnit = 'hour' | 'day';

/** Every bucket start from the one holding `from` to the one holding `to`, as `…T09:00:00Z`. */
export function timeBuckets(from: Date, to: Date, unit: BucketUnit): string[] {
  const start = new Date(from);
  if (unit === 'hour') start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  const step = unit === 'hour' ? HOUR_MS : DAY_MS;
  const out: string[] = [];
  for (let t = start.getTime(); t <= to.getTime(); t += step)
    out.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  return out;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function addBy<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  weight: (row: T) => number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyOf(row);
    out[key] = (out[key] ?? 0) + weight(row);
  }
  return out;
}

/** How many rows have each key. */
export function countBy<T>(rows: readonly T[], keyOf: (row: T) => string): Record<string, number> {
  return addBy(rows, keyOf, () => 1);
}

/** The sum of the counted rows' `n` for each key. */
export function sumBy<T extends { n: number }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): Record<string, number> {
  return addBy(rows, keyOf, (r) => r.n);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function usageValues(rows: readonly { usage: Record<string, unknown> | null }[], id: string) {
  return rows.map((r) => r.usage?.[id]).filter((v): v is number => typeof v === 'number');
}

export function shapeSourceStats(
  window: StatsWindow,
  hours: readonly string[],
  rows: readonly { hour: string; type: string; stage: EventStage; n: number }[],
  failures: readonly { hour: string; n: number }[],
): SourceStatsResponse {
  const byHour = groupBy(rows, (r) => r.hour);
  const failed = new Map(failures.map((f) => [f.hour, f.n]));
  return {
    window,
    buckets: hours.map((hour) => {
      const inHour = byHour.get(hour) ?? [];
      return {
        hour,
        byType: sumBy(inHour, (r) => r.type),
        byStage: sumBy(inHour, (r) => r.stage),
      };
    }),
    verifyFailures: hours.map((hour) => ({ hour, count: failed.get(hour) ?? 0 })),
  };
}

export function shapeSourceActivity(
  hours: readonly string[],
  rows: readonly { hour: string; type: string; stage: EventStage; n: number }[],
): Pick<SourceSummary, 'eventsByType24h' | 'eventsByHour24h'> {
  const byHour = groupBy(rows, (r) => r.hour);
  return {
    eventsByType24h: Object.entries(sumBy(rows, (r) => r.type))
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    eventsByHour24h: hours.map((hour) => {
      const inHour = byHour.get(hour) ?? [];
      return {
        hour,
        count: sum(inHour.map((r) => r.n)),
        throttled: sum(inHour.filter((r) => r.stage === 'source_throttled').map((r) => r.n)),
      };
    }),
  };
}

export function shapeMeterHistory(
  window: StatsWindow,
  specs: readonly MeterSpec[],
  readings: readonly {
    meterId: string;
    observedAt: Date;
    utilization: number;
    resetsAt: Date | null;
    estimated: boolean;
  }[],
  runs: readonly {
    id: string;
    t: Date | null;
    processId: string;
    processName: string;
    status: RunStatusValue;
  }[],
  gauges: readonly MeterGaugeDTO[],
): MeterHistoryResponse {
  const byMeter = groupBy(readings, (r) => r.meterId);
  return {
    window,
    meters: specs.map((spec) => {
      const mine = byMeter.get(spec.id) ?? [];
      return {
        id: spec.id,
        title: spec.title,
        estimated: mine.some((r) => r.estimated) || spec.estimate !== undefined,
        readings: mine.map((r) => ({
          t: r.observedAt.toISOString(),
          utilization: r.utilization,
          resetsAt: r.resetsAt?.toISOString() ?? null,
        })),
        ceilings: gauges.find((g) => g.meterId === spec.id)?.ceilings ?? [],
      };
    }),
    runs: runs.map((r) => ({
      t: r.t?.toISOString() ?? '',
      runId: r.id,
      processId: r.processId,
      processName: r.processName,
      status: r.status,
      statusLabel: runStatusLabel(r.status),
    })),
  };
}

export function shapeUsageHistory(
  window: StatsWindow,
  days: readonly string[],
  dimensions: readonly UsageDimension[],
  rows: readonly { day: string; status: RunStatusValue; usage: Record<string, unknown> | null }[],
): UsageHistoryResponse {
  const byDay = groupBy(rows, (r) => r.day);
  return {
    window,
    dimensions: dimensions.map((d) => ({
      id: d.id,
      title: d.title,
      unit: d.unit,
      days: days.map((day) => {
        const values = usageValues(byDay.get(day) ?? [], d.id);
        return { day, value: d.aggregate === 'max' ? Math.max(0, ...values) : sum(values) };
      }),
    })),
    runsByStatus: days.map((day) => ({
      day,
      counts: countBy(byDay.get(day) ?? [], (r) => r.status),
    })),
  };
}

const EVENT_KINDS: readonly BatchKind[] = ['event', 'manual'];

export function shapeFunnel(
  window: StatsWindow,
  received: number,
  dispatchRows: readonly { outcome: string; n: number }[],
  batchRows: readonly { kind: BatchKind; outcome: BatchOutcome; n: number }[],
  runRows: readonly { kind: BatchKind; status: RunStatusValue; n: number }[],
): FunnelResponse {
  const dispatched = sumBy(dispatchRows, (r) => r.outcome);
  const isEvent = (r: { kind: BatchKind }) => EVENT_KINDS.includes(r.kind);
  const eventBatches = classifyBatches(batchRows.filter(isEvent));
  const eventRuns = classifyRuns(runRows.filter(isEvent));
  const sweepBatches = classifyBatches(batchRows.filter((r) => r.kind === 'sweep'));
  const sweepRuns = classifyRuns(runRows.filter((r) => r.kind === 'sweep'));
  return {
    window,
    event: {
      received,
      matched: sum(dispatchRows.map((r) => r.n)),
      deduped: dispatched.deduped ?? 0,
      batched: dispatched.batched ?? 0,
      batches: eventBatches.total,
      held: eventBatches.held,
      throttled: eventBatches.throttled,
      invoked: eventRuns.total,
      ok: eventRuns.ok,
      error: eventRuns.error,
      failed: eventRuns.failed,
      unknown: eventRuns.unknown,
      running: eventRuns.running,
    },
    sweep: {
      fired: sweepBatches.total,
      held: sweepBatches.held,
      throttled: sweepBatches.throttled,
      invoked: sweepRuns.total,
      ok: sweepRuns.ok,
      error: sweepRuns.problem,
    },
  };
}

const seconds = (from: Date | null, to: Date | null): number | null =>
  from && to ? (to.getTime() - from.getTime()) / 1000 : null;

export function shapeProcessStats(
  window: StatsWindow,
  days: readonly string[],
  runRows: readonly {
    day: string;
    status: RunStatusValue;
    invokedAt: Date | null;
    finishedAt: Date | null;
    firstEventAt: Date | null;
    usage: Record<string, unknown> | null;
  }[],
  batchRows: readonly { day: string; outcome: BatchOutcome; n: number }[],
  dimensions: readonly UsageDimension[],
): ProcessStatsResponse {
  const runsByDay = groupBy(runRows, (r) => r.day);
  const batchesByDay = groupBy(batchRows, (b) => b.day);
  const present = (v: number | null): v is number => v !== null;
  const medianOf = (values: (number | null)[]) => median(values.filter(present));
  return {
    window,
    days: days.map((day) => {
      const rs = runsByDay.get(day) ?? [];
      const bs = classifyBatches(batchesByDay.get(day) ?? []);
      return {
        day,
        runs: countBy(rs, (r) => r.status),
        throttled: bs.throttled,
        held: bs.held,
        latencyP50Seconds: medianOf(rs.map((r) => seconds(r.firstEventAt, r.invokedAt))),
        durationP50Seconds: medianOf(rs.map((r) => seconds(r.invokedAt, r.finishedAt))),
      };
    }),
    usagePerRun: dimensions.map((d) => {
      const values = usageValues(runRows, d.id);
      const total = sum(values);
      return {
        dimension: d.id,
        title: d.title,
        unit: d.unit,
        average: values.length > 0 ? total / values.length : null,
        total,
      };
    }),
  };
}
