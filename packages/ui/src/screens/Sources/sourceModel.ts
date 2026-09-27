/** Pure helpers for the source screens: chart series from stats, enable-prompt copy. */
import type {
  EventStage,
  SourceStatsResponse,
  SourceSummary,
  StatsWindow,
} from '@ai-switchboard/core/contract';

import type { BarSeries } from '../../components/BarChart.js';
import type { ReasonPromptOptions } from '../../hooks/reason.js';
import { formatClock, toMs } from '../../lib/format.js';
import { seriesColor } from '../../lib/instances.js';

/** Per-hour totals and throttled counts for the card's 24-bar histogram. */
export function hourlyTotals(stats: SourceStatsResponse | undefined): {
  total: number;
  throttled: number;
}[] {
  return (stats?.buckets ?? []).map((b) => ({
    total: Object.values(b.byType).reduce((s, v) => s + v, 0),
    throttled: b.byStage.source_throttled ?? 0,
  }));
}

/** Stage colours: matched flows (mint), throttled/muted are amber, invalid coral, rest grey. */
export const STAGE_SERIES: { stage: EventStage; label: string; color: string }[] = [
  { stage: 'matched', label: 'matched', color: 'var(--st-ok)' },
  { stage: 'unmatched', label: 'no process matched', color: 'var(--border-4)' },
  { stage: 'source_throttled', label: 'source-throttled', color: 'var(--st-warn)' },
  { stage: 'type_muted', label: 'type muted', color: 'var(--sun)' },
  { stage: 'source_disabled', label: 'source disabled', color: 'var(--accent-3)' },
  { stage: 'event_invalid', label: 'invalid', color: 'var(--st-err)' },
  { stage: 'received', label: 'received', color: 'var(--primary)' },
];

interface Bucket {
  label: string;
  byType: Record<string, number>;
  byStage: Partial<Record<EventStage, number>>;
}

/** Hourly buckets for 24 h; one bucket per day for 7 d and 30 d (hourly bars would be noise). */
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

/** Bar series by event type, largest first. */
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

/** Bar series by pipeline stage, only the stages that occur. */
export function stageSeries(buckets: Bucket[]): BarSeries[] {
  return STAGE_SERIES.map((s) => ({
    id: s.stage,
    label: s.label,
    color: s.color,
    values: buckets.map((b) => b.byStage[s.stage] ?? 0),
  })).filter((s) => s.values.some((v) => v > 0));
}

/** Total events per type over 24 h for a card, largest first. */
export function typeSplit(source: Pick<SourceSummary, 'eventsByType24h'>) {
  const total = source.eventsByType24h.reduce((s, t) => s + t.count, 0);
  const parts = [...source.eventsByType24h]
    .sort((a, b) => b.count - a.count)
    .map((t, i) => ({ ...t, color: seriesColor(i), share: total ? t.count / total : 0 }));
  return { total, parts };
}

/** The reason prompt for enabling or disabling a source, naming the effect. */
export function enableSourcePrompt(
  source: Pick<SourceSummary, 'name' | 'processCount'>,
  enabled: boolean,
): ReasonPromptOptions {
  const processes = `${source.processCount} process${source.processCount === 1 ? '' : 'es'}`;
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

/** "push · webhook", "pull · every 5 min". */
export function modeLabel(mode: SourceSummary['mode']): string {
  return mode === 'push' ? 'push · webhook' : mode === 'pull' ? 'pull · polls' : 'push and pull';
}

/** "24 h", "7 d", "30 d". */
export const WINDOW_LABEL: Record<StatsWindow, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
};

/** The window picker's options. */
export const WINDOW_OPTIONS: { value: StatsWindow; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
];
