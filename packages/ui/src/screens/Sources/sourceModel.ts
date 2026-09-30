import type {
  EventStage,
  PluginTypeDTO,
  SourceStatsResponse,
  SourceSummary,
  StatsWindow,
} from '@ai-switchboard/core/contract';

import type { BarSeries } from '../../components/BarChart.js';
import type { ReasonPromptOptions } from '../../hooks/reason.js';
import { seriesColor } from '../../lib/colors.js';
import { formatClock, plural, toMs } from '../../lib/format.js';
import { STAGE_SERIES } from '../../lib/stages.js';

interface Bucket {
  label: string;
  byType: Record<string, number>;
  byStage: Partial<Record<EventStage, number>>;
}

/** One bucket per day for 7 d and 30 d: hourly bars would be noise. */
export function statBuckets(stats: SourceStatsResponse, window: StatsWindow): Bucket[] {
  if (window === '24h') {
    return stats.buckets.map((b) => ({
      label: formatClock(toMs(b.hour) ?? 0),
      byType: b.byType,
      byStage: b.byStage,
    }));
  }
  const days = new Map<string, Bucket>();
  for (const b of stats.buckets) {
    const d = new Date(toMs(b.hour) ?? 0);
    const key = d.toDateString();
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const into = days.get(key) ?? { label, byType: {}, byStage: {} };
    for (const [t, v] of Object.entries(b.byType)) into.byType[t] = (into.byType[t] ?? 0) + v;
    for (const [s, v] of Object.entries(b.byStage) as [EventStage, number][]) {
      into.byStage[s] = (into.byStage[s] ?? 0) + v;
    }
    days.set(key, into);
  }
  return [...days.values()];
}

export function typeSeries(buckets: Bucket[]): BarSeries[] {
  const totals = new Map<string, number>();
  for (const b of buckets) {
    for (const [t, v] of Object.entries(b.byType)) totals.set(t, (totals.get(t) ?? 0) + v);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type], i) => ({
      id: type,
      label: type,
      color: seriesColor(i),
      values: buckets.map((b) => b.byType[type] ?? 0),
    }));
}

export function stageSeries(buckets: Bucket[]): BarSeries[] {
  return STAGE_SERIES.map((s) => ({
    ...s,
    values: buckets.map((b) => b.byStage[s.id] ?? 0),
  })).filter((s) => s.values.some((v) => v > 0));
}

export function typeSplit(source: Pick<SourceSummary, 'eventsByType24h'>) {
  const total = source.eventsByType24h.reduce((s, t) => s + t.count, 0);
  const parts = [...source.eventsByType24h]
    .sort((a, b) => b.count - a.count)
    .map((t, i) => ({ ...t, color: seriesColor(i), share: total ? t.count / total : 0 }));
  return { total, parts };
}

export function enableSourcePrompt(
  source: Pick<SourceSummary, 'name' | 'processCount'>,
  enabled: boolean,
): ReasonPromptOptions {
  const processes = plural(source.processCount, 'process', 'processes');
  return enabled
    ? {
        title: `Enable ${source.name}?`,
        consequence: `Events from ${source.name} flow to its ${processes} again.`,
        confirmLabel: 'Enable source',
      }
    : {
        title: `Disable ${source.name}?`,
        consequence: `Deliveries are answered but not dispatched, so its ${processes} stop receiving its events. They are kept and can be replayed.`,
        confirmLabel: 'Disable source',
        danger: true,
      };
}

export function modeLabel(mode: SourceSummary['mode']): string {
  return mode === 'push' ? 'push · webhook' : mode === 'pull' ? 'pull · polls' : 'push and pull';
}

export function describeSourceType(t: PluginTypeDTO): string {
  const n = t.eventTypes?.length ?? 0;
  return [
    t.mode === 'both' ? 'push and pull' : (t.mode ?? 'push'),
    t.dynamicEventTypes ? 'dynamic event types' : plural(n, 'event type'),
    t.provisionSupported ? 'registers its webhook' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
