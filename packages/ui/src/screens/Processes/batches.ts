import type { RecentBatchDTO } from '@ai-switchboard/core/contract';

import { formatClock, toMs } from '../../lib/format.js';

export const EXAMPLE_SWEEP = '';

export function batchLabel(b: RecentBatchDTO): string {
  const when = formatClock(toMs(b.openedAt) ?? 0);
  const ids = b.artifacts.map((a) => a.id);
  const what = ids.length > 0 ? ids.slice(0, 3).join(', ') + (ids.length > 3 ? '…' : '') : 'empty';
  return `${b.kind === 'event' ? 'batch' : b.kind} ${when} · ${what}`;
}

export function batchOptions(batches: RecentBatchDTO[]): { value: string; label: string }[] {
  return [
    ...batches.map((b) => ({ value: b.id, label: batchLabel(b) })),
    { value: EXAMPLE_SWEEP, label: 'example sweep · no events' },
  ];
}
