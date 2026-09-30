/** The filters live in the URL so a filtered view can be shared. */
import type { ActivityQuery, ActivityRow, StatusTone } from '@ai-switchboard/core/contract';
import { EVENT_STAGE_LABELS, EVENT_STAGES } from '@ai-switchboard/core/domain';

import { withParam } from '../../hooks/useSearchParamState.js';

export const FILTER_KEYS = [
  'source',
  'process',
  'destination',
  'stage',
  'artifact',
  'range',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type ActivityFilters = Partial<Record<FilterKey, string>>;

/** `all` sends no lower bound. */
export const RANGES = [
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '24h', label: 'Last 24 h', ms: 24 * 60 * 60_000 },
  { value: '7d', label: 'Last 7 d', ms: 7 * 24 * 60 * 60_000 },
  { value: '30d', label: 'Last 30 d', ms: 30 * 24 * 60 * 60_000 },
  { value: 'all', label: 'All time', ms: null },
] as const;
export const DEFAULT_RANGE = '24h';

export const STAGE_OPTIONS = EVENT_STAGES.map((stage) => ({
  value: stage,
  label: EVENT_STAGE_LABELS[stage].label,
}));

export function readFilters(params: URLSearchParams): ActivityFilters {
  const out: ActivityFilters = {};
  for (const key of FILTER_KEYS) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  return out;
}

export function withFilter(
  params: URLSearchParams,
  key: FilterKey,
  value: string,
): URLSearchParams {
  return withParam(params, key, value);
}

/** `anchorMs` is when the range was chosen. */
export function toActivityQuery(
  filters: ActivityFilters,
  anchorMs: number,
): Omit<ActivityQuery, 'cursor'> {
  const range = RANGES.find((r) => r.value === (filters.range ?? DEFAULT_RANGE)) ?? RANGES[1];
  const q: Omit<ActivityQuery, 'cursor'> = {};
  if (filters.source) q.source = filters.source;
  if (filters.process) q.process = filters.process;
  if (filters.destination) q.destination = filters.destination;
  if (filters.stage) q.stage = filters.stage;
  if (filters.artifact) q.artifact = filters.artifact;
  if (range.ms != null) {
    // Rounded to the minute so the key (and the cache) stays stable while the page is open.
    q.from = new Date(Math.floor((anchorMs - range.ms) / 60_000) * 60_000).toISOString();
  }
  return q;
}

export function toneCounts(rows: ActivityRow[]): Record<StatusTone, number> {
  const out: Record<StatusTone, number> = { ok: 0, warn: 0, error: 0, off: 0 };
  for (const r of rows) out[r.indicator.tone] += 1;
  return out;
}

export function hasFilters(filters: ActivityFilters): boolean {
  return FILTER_KEYS.some((k) => k !== 'range' && filters[k] != null);
}

/**
 * An id the list does not have (deleted, or a typo in a shared link) is kept as a "(not found)"
 * option, so the select shows the filter really applied rather than "All …".
 */
export function idFilterOptions(
  items: { id: string; name: string }[] | undefined,
  current: string | undefined,
): { value: string; label: string }[] {
  const options = (items ?? []).map((x) => ({ value: x.id, label: x.name }));
  if (current && items && !items.some((x) => x.id === current)) {
    options.push({ value: current, label: `${current} (not found)` });
  }
  return options;
}
