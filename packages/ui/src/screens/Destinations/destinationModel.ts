import type {
  DestinationSummary,
  MeterGaugeDTO,
  MeterSpec,
  PluginTypeDTO,
  UsageHistoryResponse,
} from '@ai-switchboard/core/contract';

import type { BarSeries } from '../../components/BarChart.js';
import type { ReasonPromptOptions } from '../../hooks/reason.js';
import { plural, toMs } from '../../lib/format.js';
import { RUN_STATUS_SERIES } from '../../lib/stages.js';

export function describeDestinationType(t: PluginTypeDTO): string {
  const meters = t.meters?.length ?? 0;
  return [
    t.tracking ? `${t.tracking} tracking` : null,
    meters ? plural(meters, 'meter') : 'no meters',
    t.idempotentInvoke ? 'idempotent' : 'not idempotent',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function enableDestinationPrompt(
  x: Pick<DestinationSummary, 'name' | 'processCount'>,
  enabled: boolean,
): ReasonPromptOptions {
  const processes = plural(x.processCount, 'process', 'processes');
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

export function dayLabel(iso: string): string {
  return new Date(toMs(iso) ?? 0).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function runStatusSeries(usage: UsageHistoryResponse): BarSeries[] {
  return RUN_STATUS_SERIES.map((s) => ({
    ...s,
    values: usage.runsByStatus.map((d) => d.counts[s.id] ?? 0),
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
