import type {
  DestinationSummary,
  MeterGaugeDTO,
  MeterSpec,
  PluginTypeDTO,
  RunStatusValue,
  UsageHistoryResponse,
} from '@ai-switchboard/core/contract';

import type { BarSeries } from '../../components/BarChart.js';
import type { ReasonPromptOptions } from '../../hooks/reason.js';
import { toMs } from '../../lib/format.js';

export const DEFAULT_METER_POLL_SECONDS = 300;
export const MIN_METER_POLL_SECONDS = 30;

export const DEFAULT_INVOKE_TIMEOUT_SECONDS = 300;
export const MAX_INVOKE_TIMEOUT_SECONDS = 3600;

export function describeDestinationType(t: PluginTypeDTO): string {
  const meters = t.meters?.length ?? 0;
  return [
    t.tracking ? `${t.tracking} tracking` : null,
    meters ? `${meters} meter${meters === 1 ? '' : 's'}` : 'no meters',
    t.idempotentInvoke ? 'idempotent' : 'not idempotent',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function enableDestinationPrompt(
  x: Pick<DestinationSummary, 'name' | 'processCount'>,
  enabled: boolean,
): ReasonPromptOptions {
  const processes = `${x.processCount} process${x.processCount === 1 ? '' : 'es'}`;
  return enabled
    ? {
        title: `Enable ${x.name}?`,
        consequence: `Its ${processes} can start runs on it again.`,
        confirmLabel: 'Enable destination',
      }
    : {
        title: `Disable ${x.name}?`,
        consequence: `No new runs start on it: batches for its ${processes} are held until it is enabled. Runs already started keep being tracked.`,
        confirmLabel: 'Disable destination',
        danger: true,
      };
}

export const RUN_STATUS_SERIES: { status: RunStatusValue; label: string; color: string }[] = [
  { status: 'ok', label: 'ok', color: 'var(--st-ok)' },
  { status: 'error', label: 'error', color: 'var(--st-err)' },
  { status: 'failed', label: 'failed', color: 'var(--coral-ink)' },
  { status: 'unknown', label: 'unknown · deadline passed', color: 'var(--st-warn)' },
  { status: 'uncertain', label: 'uncertain · never retried', color: 'var(--sun)' },
  { status: 'held', label: 'held', color: 'var(--tangerine-soft)' },
  { status: 'running', label: 'running', color: 'var(--sky)' },
  { status: 'invoking', label: 'invoking', color: 'var(--border-4)' },
];

export function dayLabel(iso: string): string {
  return new Date(toMs(iso) ?? 0).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function runStatusSeries(usage: UsageHistoryResponse): BarSeries[] {
  return RUN_STATUS_SERIES.map((s) => ({
    id: s.status,
    label: s.label,
    color: s.color,
    values: usage.runsByStatus.map((d) => d.counts[s.status] ?? 0),
  })).filter((s) => s.values.some((v) => v > 0));
}

/** Meters whose limit the core estimates from its own run counts; the person types the limit. */
export function estimatedMeters(
  specs: MeterSpec[],
  gauges: Pick<MeterGaugeDTO, 'meterId' | 'estimated'>[] = [],
): MeterSpec[] {
  return specs.filter(
    (m) => m.estimate != null || gauges.some((g) => g.meterId === m.id && g.estimated),
  );
}

export function runProcesses(runs: { processId: string; processName: string }[]) {
  const seen = new Map<string, string>();
  for (const r of runs) seen.set(r.processId, r.processName);
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}
