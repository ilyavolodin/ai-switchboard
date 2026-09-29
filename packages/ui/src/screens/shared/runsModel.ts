import type { RunSummary } from '@ai-switchboard/core/contract';

import { formatUsage } from '../../lib/format.js';

export function usageText(usage: RunSummary['usage'], units?: Map<string, string>): string {
  if (!usage) return '—';
  const parts = Object.entries(usage).map(([k, v]) => formatUsage(v, units?.get(k) ?? k));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

export function runKindText(r: Pick<RunSummary, 'kind' | 'dryRun'>): string {
  return r.dryRun ? `${r.kind} · dry run` : r.kind;
}
