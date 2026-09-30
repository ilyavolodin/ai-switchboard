import type { EventStage, RunStatusValue } from '@ai-switchboard/core/contract';
import { EVENT_STAGE_LABELS, EVENT_STAGES, RUN_STATUSES } from '@ai-switchboard/core/domain';

export interface Series<K extends string> {
  id: K;
  label: string;
  color: string;
}

const STAGE_COLOR: Record<EventStage, string> = {
  received: 'var(--primary)',
  matched: 'var(--st-ok)',
  unmatched: 'var(--border-4)',
  source_disabled: 'var(--accent-3)',
  source_throttled: 'var(--st-warn)',
  type_muted: 'var(--sun)',
  event_invalid: 'var(--st-err)',
};

/** Every event stage, in pipeline order, labelled as the core labels it. */
export const STAGE_SERIES: Series<EventStage>[] = EVENT_STAGES.map((stage) => ({
  id: stage,
  label: EVENT_STAGE_LABELS[stage].label,
  color: STAGE_COLOR[stage],
}));

const RUN_STATUS_SERIES_BY: Record<RunStatusValue, { label: string; color: string }> = {
  invoking: { label: 'invoking', color: 'var(--border-4)' },
  running: { label: 'running', color: 'var(--sky)' },
  uncertain: { label: 'uncertain · never retried', color: 'var(--sun)' },
  ok: { label: 'ok', color: 'var(--st-ok)' },
  error: { label: 'error', color: 'var(--st-err)' },
  failed: { label: 'failed', color: 'var(--coral-ink)' },
  unknown: { label: 'unknown · deadline passed', color: 'var(--st-warn)' },
  held: { label: 'held', color: 'var(--tangerine-soft)' },
};

const RUN_STATUS_ORDER: readonly RunStatusValue[] = [
  'ok',
  'error',
  'failed',
  'unknown',
  'uncertain',
  'held',
  'running',
  'invoking',
];

/** Outcomes first, then open runs; every run status appears once. */
export const RUN_STATUS_SERIES: Series<RunStatusValue>[] = [
  ...RUN_STATUS_ORDER,
  ...RUN_STATUSES.filter((s) => !RUN_STATUS_ORDER.includes(s)),
].map((status) => ({ id: status, ...RUN_STATUS_SERIES_BY[status] }));
