import type { ProcessSummary } from '@ai-switchboard/core/contract';

import { toMs } from '../../lib/format.js';
import { shortInstanceName } from '../../lib/instanceNames.js';
import { toneRank } from '../../lib/tone.js';

export const PROCESS_SORTS = ['activity', 'status', 'name'] as const;
export type ProcessSort = (typeof PROCESS_SORTS)[number];

export const PROCESS_FILTERS = ['all', 'healthy', 'attention', 'off'] as const;
export type ProcessFilter = (typeof PROCESS_FILTERS)[number];

export function matchesFilter(p: ProcessSummary, filter: ProcessFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'healthy':
      return p.status.tone === 'ok';
    case 'attention':
      return p.status.tone === 'warn' || p.status.tone === 'error';
    case 'off':
      return p.status.tone === 'off';
  }
}

export function matchesQuery(p: ProcessSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    p.name,
    p.description,
    p.destination?.name ?? '',
    ...p.triggers.flatMap((t) => [t.sourceName, t.describe, ...t.eventTypes]),
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(q);
}

export function weeklyRuns(p: ProcessSummary): number {
  return p.sparkline.reduce((a, b) => a + b, 0);
}

/**
 * `activity`: most runs in 7 days first (then most recent run); `status`: errors, attention,
 * healthy, off.
 */
export function sortProcesses(list: ProcessSummary[], sort: ProcessSort): ProcessSummary[] {
  const byName = (a: ProcessSummary, b: ProcessSummary) => a.name.localeCompare(b.name);
  const copy = [...list];
  switch (sort) {
    case 'name':
      return copy.sort(byName);
    case 'status':
      return copy.sort((a, b) => toneRank(a.status.tone) - toneRank(b.status.tone) || byName(a, b));
    case 'activity':
      return copy.sort(
        (a, b) =>
          weeklyRuns(b) - weeklyRuns(a) ||
          (toMs(b.lastRunAt) ?? 0) - (toMs(a.lastRunAt) ?? 0) ||
          byName(a, b),
      );
  }
}

export function flowLine(p: ProcessSummary): string {
  const sources = [...new Set(p.triggers.map((t) => shortInstanceName(t.sourceName)))];
  const from = sources.length > 0 ? sources.join(', ') : 'schedule only';
  const to = p.destination ? shortInstanceName(p.destination.name) : 'no destination';
  return `${from} → ${to}`;
}

export function filterCounts(list: ProcessSummary[]): Record<ProcessFilter, number> {
  return {
    all: list.length,
    healthy: list.filter((p) => matchesFilter(p, 'healthy')).length,
    attention: list.filter((p) => matchesFilter(p, 'attention')).length,
    off: list.filter((p) => matchesFilter(p, 'off')).length,
  };
}

export function asProcessSort(v: string): ProcessSort {
  return PROCESS_SORTS.find((s) => s === v) ?? 'activity';
}

export function asProcessFilter(v: string): ProcessFilter {
  return PROCESS_FILTERS.find((f) => f === v) ?? 'all';
}
